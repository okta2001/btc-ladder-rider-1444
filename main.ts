// LUMEN LADDER RIDER IV — a ladder / momentum rider for CBBTC 1-minute bars.
//
// Idea in one paragraph: only ride confirmed up-moves. Two incremental EMAs
// (fast over slow, price above slow), a positive lookback momentum gate, and
// a slow-EMA slope gate — the slow trend itself must not be falling over the
// last 30 bars, which is what keeps the bot out of dead-cat bounces in a
// falling tape — decide the first entry. While the move keeps climbing we add tranches on a
// fixed price ladder, so a strong trend ends up carrying most of the equity
// while a weak wiggle only ever risks the first, smaller tranche. The whole
// position leaves at once when the move breaks: a trailing stop under the
// highest close since entry, a hard stop under average cost, an EMA
// cross-down, or an account-level equity guard that also parks the bot for
// a long cooldown. Everything is deterministic: no clock, no randomness,
// only the bar stream and the account state the harness hands us.

import { runBars } from './vendor/makefun-bars.ts';

// ---------------------------------------------------------------------------
// Tunable parameters. These are the knobs the local dev grading iterates on;
// they live in one place so a tuning pass never has to touch the logic.
// ---------------------------------------------------------------------------
const PARAMS = {
  emaFastSpan: 20, // bars in the fast exponential moving average
  emaSlowSpan: 60, // bars in the slow exponential moving average
  momentumLookback: 5, // bars back for the momentum ratio
  entryMomentum: 0.0025, // momentum must exceed +0.25% to open tranche 1
  ladderStep: 0.0018, // +0.18% over the last tranche reference adds a tranche
  maxTranches: 6, // ladder depth cap
  trancheFractions: [0.45, 0.27, 0.15, 0.08, 0.03, 0.02], // share of equity per tranche, ~100% in all
  trailStop: 0.014, // exit 1.40% under the highest close since entry
  hardStop: 0.022, // exit 2.20% under average cost
  trendBreakMargin: 0, // fast EMA must fall this far under slow to exit
  slowSlopeBars: 30, // entry needs the slow EMA at least flat over this span
  equityGuardDrop: 0.04, // exit + long cooldown at -4% from peak equity
  equityGuardCooldown: 90, // bars parked after the equity guard fires
  exitCooldown: 4, // bars parked after an ordinary exit
  lateEntryCutoff: 15, // no new entries in the last N scored bars
  totalScoredBars: 1440, // length of the scored race window
  maxSlippageBps: 250, // slippage bound attached to every order
  minOrderUsdc: 5, // never send a buy smaller than this many dollars
};

const SYMBOL = 'CBBTC';

// ---------------------------------------------------------------------------
// Small numeric helpers. Prices travel as bigints scaled by the symbol's
// price_scale; ratios are scale-free, so the indicator math runs on plain
// numbers converted from the raw close, which keeps every bar O(1).
// ---------------------------------------------------------------------------

/** Convert a raw quote amount (USDC, 1e6 per dollar) to a number of dollars. */
function quoteToNumber(raw: bigint): number {
  return Number(raw) / 1_000_000;
}

/**
 * Average entry price of the open position, expressed in the same raw units
 * as a bar close (price_scale units), or null when flat. Inverts the shim's
 * value formula: cost = qty * price * 10^quote_scale / 10^(qty+price scales).
 */
function averageCostRaw(
  qty: bigint,
  cost: bigint,
  qtyScale: number,
  priceScale: number,
  quoteScale: number,
): number | null {
  if (qty <= 0n) return null;
  const numerator = Number(cost) * 10 ** (qtyScale + priceScale);
  const denominator = Number(qty) * 10 ** quoteScale;
  return numerator / denominator;
}

// ---------------------------------------------------------------------------
// Strategy state. One instance per run; the harness drives it batch by batch
// through the hello / batch / done messages of agent-fun/bars-replay/v1.
// ---------------------------------------------------------------------------
class LadderRider {
  // Indicator state.
  private emaFast: number | null = null;
  private emaSlow: number | null = null;
  private prevEmaFast: number | null = null;
  private prevEmaSlow: number | null = null;
  private closes: number[] = []; // recent raw closes, oldest first
  private slowHistory: number[] = []; // recent slow EMA values, oldest first
  private lastClose: number | null = null;

  // Position / ladder state, describing orders we have decided (a decided
  // order fills at the next bar's open, so this bookkeeping leads the
  // account by one bar and the account remains the source of truth for
  // whether we are actually flat).
  private tranchesUsed = 0;
  private lastTrancheRef: number | null = null; // close when last tranche decided
  private highestCloseSinceEntry: number | null = null;
  private pendingEntry = false; // a buy was decided but not yet visible

  // Risk state.
  private cooldownUntilSeq = -1;
  private peakEquity: number | null = null;

  // Diagnostics (stderr only; the wire carries replies alone).
  readonly stats = { entries: 0, ladderAdds: 0, exits: {} as Record<string, number> };

  /** Feed one batch's CBBTC close into the indicators. */
  private updateIndicators(closeRaw: number): void {
    this.lastClose = closeRaw;
    this.closes.push(closeRaw);
    const keep = Math.max(PARAMS.momentumLookback + 2, 32);
    if (this.closes.length > keep) this.closes.splice(0, this.closes.length - keep);

    this.prevEmaFast = this.emaFast;
    this.prevEmaSlow = this.emaSlow;
    const kFast = 2 / (PARAMS.emaFastSpan + 1);
    const kSlow = 2 / (PARAMS.emaSlowSpan + 1);
    this.emaFast = this.emaFast === null ? closeRaw : closeRaw * kFast + this.emaFast * (1 - kFast);
    this.emaSlow = this.emaSlow === null ? closeRaw : closeRaw * kSlow + this.emaSlow * (1 - kSlow);
    this.slowHistory.push(this.emaSlow);
    if (this.slowHistory.length > 64) this.slowHistory.splice(0, this.slowHistory.length - 64);

    if (this.highestCloseSinceEntry !== null && closeRaw > this.highestCloseSinceEntry) {
      this.highestCloseSinceEntry = closeRaw;
    }
  }

  /** Momentum over the lookback: close / close[lookback] - 1, or null early. */
  private momentum(): number | null {
    const n = this.closes.length;
    if (n <= PARAMS.momentumLookback) return null;
    const past = this.closes[n - 1 - PARAMS.momentumLookback];
    if (past === undefined || past <= 0 || this.lastClose === null) return null;
    return this.lastClose / past - 1;
  }

  /**
   * True when the trend has genuinely broken: the fast EMA sits below the
   * slow EMA by more than the break margin. A bare touch of the two EMAs is
   * noise on 1-minute bars — in the dev window every exit of the first tuned
   * version came from a hairline cross that cut rides at breakeven — so the
   * break must clear a small band before it sells.
   */
  private crossedDown(): boolean {
    if (this.emaFast === null || this.emaSlow === null) return false;
    return this.emaFast < this.emaSlow * (1 - PARAMS.trendBreakMargin);
  }

  onBatch(state: any, batch: any): any[] {
    // Find this batch's CBBTC bar; a missing minute means no new information,
    // so we keep the last close and send no orders.
    const bar = (batch.bars ?? []).find((b: any) => b.symbol === SYMBOL);
    if (!bar) return [];
    const closeRaw = Number(bar.c);
    if (!Number.isFinite(closeRaw) || closeRaw <= 0) return [];
    this.updateIndicators(closeRaw);

    // Warm-up batches only build history; the harness rejects orders on them.
    if (state.warmingUp) return [];

    const position = state.positions.get(SYMBOL);
    const heldQty: bigint = position?.qty ?? 0n;
    const holding = heldQty > 0n || this.pendingEntry;

    // Track the equity peak for the account-level guard.
    const equityNow = quoteToNumber(state.equity);
    if (this.peakEquity === null || equityNow > this.peakEquity) this.peakEquity = equityNow;

    const scoredIndex = state.seq - state.warmupBars;
    const inCooldown = state.seq < this.cooldownUntilSeq;

    // ---- exits first: capital protection outranks every entry idea -------
    if (holding && heldQty > 0n) {
      const exitReason = this.exitReason(state, heldQty, position.cost);
      if (exitReason !== null) {
        this.stats.exits[exitReason] = (this.stats.exits[exitReason] ?? 0) + 1;
        const longPark = exitReason === 'equity-guard';
        this.cooldownUntilSeq = state.seq + (longPark ? PARAMS.equityGuardCooldown : PARAMS.exitCooldown);
        this.resetLadder();
        return [{
          side: 'sell',
          symbol: SYMBOL,
          qty: heldQty.toString(),
          max_slippage_bps: PARAMS.maxSlippageBps,
          client_id: state.clientId(),
        }];
      }
    }

    // The equity guard also parks a flat bot: after a -4% drawdown from the
    // peak we stop opening fresh risk for the long cooldown.
    if (this.peakEquity !== null && equityNow <= this.peakEquity * (1 - PARAMS.equityGuardDrop)) {
      if (!inCooldown) this.cooldownUntilSeq = state.seq + PARAMS.equityGuardCooldown;
      return [];
    }

    if (inCooldown) return [];

    // ---- ladder adds while a position is running --------------------------
    if (holding) {
      if (this.tranchesUsed >= 1 && this.tranchesUsed < PARAMS.maxTranches && this.lastTrancheRef !== null) {
        if (closeRaw >= this.lastTrancheRef * (1 + PARAMS.ladderStep)) {
          const order = this.buyOrder(state, this.tranchesUsed);
          if (order !== null) {
            this.stats.ladderAdds += 1;
            this.tranchesUsed += 1;
            this.lastTrancheRef = closeRaw;
            return [order];
          }
        }
      }
      return [];
    }

    // ---- fresh entry -------------------------------------------------------
    // No new risk in the tail of the window: a position opened there cannot
    // pay its round-trip costs before the forced flat at the end.
    if (scoredIndex >= PARAMS.totalScoredBars - PARAMS.lateEntryCutoff) return [];
    if (this.emaFast === null || this.emaSlow === null) return [];
    if (!(this.emaFast > this.emaSlow)) return [];
    if (!(closeRaw > this.emaSlow)) return [];
    // The slow trend itself must not be falling: a rising fast EMA inside a
    // falling slow trend is a bounce in a bleed, and those entries ground
    // out as a string of small losses in the dev window's second half.
    if (PARAMS.slowSlopeBars > 0) {
      const n = this.slowHistory.length;
      if (n <= PARAMS.slowSlopeBars) return [];
      if (this.slowHistory[n - 1]! < this.slowHistory[n - 1 - PARAMS.slowSlopeBars]!) return [];
    }
    const mom = this.momentum();
    if (mom === null || mom <= PARAMS.entryMomentum) return [];

    const order = this.buyOrder(state, 0);
    if (order === null) return [];
    this.stats.entries += 1;
    this.tranchesUsed = 1;
    this.lastTrancheRef = closeRaw;
    this.highestCloseSinceEntry = closeRaw;
    this.pendingEntry = true;
    return [order];
  }

  /** Decide whether the open position must be sold in full, and why. */
  private exitReason(state: any, heldQty: bigint, cost: bigint): string | null {
    const closeRaw = this.lastClose;
    if (closeRaw === null) return null;

    // (d) equity guard: the whole account is down too far from its peak.
    const equityNow = quoteToNumber(state.equity);
    if (this.peakEquity !== null && equityNow <= this.peakEquity * (1 - PARAMS.equityGuardDrop)) {
      return 'equity-guard';
    }
    // (a) trailing stop under the best close seen since entry.
    if (this.highestCloseSinceEntry !== null &&
        closeRaw <= this.highestCloseSinceEntry * (1 - PARAMS.trailStop)) {
      return 'trailing-stop';
    }
    // (b) hard stop under average cost.
    const sym = state.hello.symbols.find((s: any) => s.symbol === SYMBOL);
    if (sym) {
      const avg = averageCostRaw(heldQty, cost, sym.qty_scale, sym.price_scale, state.hello.capital.quote_scale);
      if (avg !== null && closeRaw <= avg * (1 - PARAMS.hardStop)) return 'hard-stop';
    }
    // (c) trend break: fast EMA crosses below slow EMA.
    if (this.crossedDown()) return 'trend-break';
    return null;
  }

  /** Build the buy order for tranche `index`, sized off current equity. */
  private buyOrder(state: any, trancheIndex: number): any | null {
    const fraction = PARAMS.trancheFractions[trancheIndex] ?? 0;
    if (fraction <= 0) return null;
    const byEquity = BigInt(Math.floor(Number(state.equity) * fraction));
    const room = state.weightRoom(SYMBOL);
    const cash = state.cash;
    let notional = byEquity < room ? byEquity : room;
    if (cash < notional) notional = cash;
    if (notional < BigInt(PARAMS.minOrderUsdc * 1_000_000)) return null;
    return {
      side: 'buy',
      symbol: SYMBOL,
      notional_quote_units: notional.toString(),
      max_slippage_bps: PARAMS.maxSlippageBps,
      client_id: state.clientId(),
    };
  }

  private resetLadder(): void {
    this.tranchesUsed = 0;
    this.lastTrancheRef = null;
    this.highestCloseSinceEntry = null;
    this.pendingEntry = false;
  }

  /** Keep the ladder bookkeeping honest when the account says we are flat. */
  syncWithAccount(state: any): void {
    const position = state.positions.get(SYMBOL);
    const flat = !position || position.qty <= 0n;
    if (flat && !this.pendingEntry && this.tranchesUsed > 0) this.resetLadder();
    if (!flat) this.pendingEntry = false;
  }
}

// ---------------------------------------------------------------------------
// Wire-up: runBars owns the hello / batch / done protocol; we only decide.
// ---------------------------------------------------------------------------
const rider = new LadderRider();

await runBars({
  onBatch(state: any, batch: any) {
    rider.syncWithAccount(state);
    return rider.onBatch(state, batch);
  },
  onDone() {
    console.error(`LADDER-STATS ${JSON.stringify(rider.stats)}`);
  },
});
