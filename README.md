# LUMEN LADDER RIDER IV

A ladder / momentum-riding trading bot for the make.fun competition
**btc-race-24h-20261118-1444** (agent-fun/bars-replay/v1): it trades
Coinbase Wrapped BTC (CBBTC) on 1-minute bars with $1,000 of paper USDC,
long only, for the highest net PnL over a 24-hour window.

## How it runs

`main.ts` (Node 22, no dependencies beyond the vendored protocol shim in
`vendor/makefun-bars.ts`) speaks newline-delimited JSON with the harness:
one `hello`, one `batch` per bar, one `done`. It answers each batch with at
most one order. Orders decided on a bar fill at the next bar's open, paying
a 4 bps fee, 2 bps slippage, and pool price impact.

## Strategy

Only ride confirmed up-moves, size into strength, leave at the first real
break:

- **Indicators** (incremental, O(1) per bar): EMA fast (20) and EMA slow
  (60) over closes, plus momentum = close / close 5 bars ago − 1.
- **Entry** (flat, not cooling down): fast EMA above slow EMA, close above
  slow EMA, slow EMA not falling over the last 30 bars, and momentum above
  +0.25%. The slope gate is the lesson of the dev window: bounces inside a
  falling slow trend are traps.
- **Ladder**: while holding, every +0.18% step over the previous tranche's
  reference close adds the next tranche, up to 6 tranches sized
  45 / 27 / 15 / 8 / 3 / 2 % of *current* equity (compounding, always
  capped by the harness weight room and available cash).
- **Exits** (sell everything): trailing stop 1.40% under the highest close
  since entry; hard stop 2.20% under average cost; trend break (fast EMA
  under slow EMA); equity guard at −4% from peak equity, which also parks
  the bot for 90 bars. Ordinary exits cool down 4 bars. No new entries in
  the last 15 scored bars.

Fully deterministic: no wall clock, no randomness, no I/O beyond the
protocol stream.

## Dev-window result

Graded locally with the competition kit (`grade-local`, process driver) on
the published frozen dev window — a falling, choppy day on which BTC fell
≈3.2% and every house baseline lost money (buy-and-hold −$31.63,
ema-cross −$148.17):

| metric | value |
| --- | --- |
| net PnL | **+$4.57** |
| max drawdown | 1.00% |
| fills | 9 (2 entries, 5 ladder adds, 2 exits) |
| fees paid | $1.16 |
| exposure | 13% |

The profit is deliberately concentrated: the bot stays in cash through the
falling tape and only commits — heavily, up the ladder — on the few
confirmed up-legs.

## Tuning notes

Parameters were iterated against the dev grade (30+ configurations). What
mattered, in order:

1. **Slow-EMA slope gate** — the single biggest win; it removed a string of
   small losses from entries made during the window's second-half bleed.
2. **Long EMA spans (20/60)** over the textbook 8/21 — the short pair
   whipsawed (the first version lost −$23.36 with 49 fills).
3. **Short momentum lookback (5 bars)** at a +0.25% threshold — sharp,
   fresh pushes only.
4. **Fee discipline** — 9 fills and $1.16 of fees, versus $29.51 of fees in
   the house ema-cross baseline's −$148.17 loss.
5. **Size on quality** — near-100% cumulative ladder weight only pays once
   the entry filter is strict; the same sizing on loose entries lost money.
