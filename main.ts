// BTC race bot: two-leg long-only trend bot on 1-minute cbBTC/USDC bars.
//
// Design (tuned on the dev window, where every baseline loses money):
//   - The dev window is a slow downtrend with sharp 10-minute legs in both
//     directions. Short-horizon momentum does not persist here, but sharp
//     legs do run a little further, and sharp drops bounce. So the bot
//     trades only sharp 10-bar moves and exits fast.
//   - MOM leg: the 10-bar return is +0.5% or more. Buy full size, sell half
//     at +0.8%, exit the rest at +1.0% take-profit, -1.0% stop, a 0.8%
//     trailing stop from the peak close, or after 120 bars.
//   - DIP leg: the 10-bar return is -0.5% or less. Buy full size, exit at
//     +0.6% take-profit, -0.4% stop, a 0.4% trailing stop from the peak
//     close, or after 90 bars.
//   - Round trips cost about 26 bps, so every exit target clears it.
//   - One position at a time, full size, long only. No clock, no
//     environment, no randomness: every decision is a pure function of the
//     bars seen, so two runs give the same action log.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK = 10;
/** 10-bar return of +0.5% or more opens the momentum leg. */
const MOM_TRIGGER = 0.005;
/** 10-bar return of -0.5% or less opens the dip leg. */
const DIP_TRIGGER = -0.005;
/** Momentum leg: sell half at +0.8% over entry cost. */
/** Momentum leg: exit the rest at +1.0% over entry cost. */
/** Momentum leg: stop at -1.0% under entry cost. */
/** Momentum leg: trailing stop, 0.8% under the peak close since entry. */
const MOM_TRAIL = 0.008;
/** Momentum leg: exit after 120 bars held. */
const MOM_MAX_HOLD = 120;
/** Dip leg: exit at +0.6% over entry cost. */
/** Dip leg: stop at -0.4% under entry cost. */
/** Dip leg: trailing stop, 0.4% under the peak close since entry. */
const DIP_TRAIL = 0.004;
/** Dip leg: exit after 90 bars held. */
const DIP_MAX_HOLD = 90;
/** Max slippage vs the close an order was decided on, 1%. */
const MAX_SLIPPAGE_BPS = 100;
/** The window is 1,440 one-minute bars (24 hours, dev and race alike). */
const WINDOW_BARS = 1440;
/**
 * Do not open a position that cannot run its full course: the longest
 * hold is 120 bars, and a position opened later is cut short by the
 * forced flatten at the last close, paying full fees for a trade whose
 * edge never had time to play out. On the dev window this skips two
 * late dip entries that the flatten closed at a loss.
 */
const NO_ENTRY_AFTER = WINDOW_BARS - 120;

/** Closes seen, oldest first, capped at LOOKBACK + 1. */
const closes: number[] = [];

type Mode = 'mom' | 'dip';
let mode: Mode | null = null;
let entrySeq = -1;
let peak = 0;
let tookHalf = false;

function pushClose(bar: Bar): void {
  closes.push(Number(bar.c));
  if (closes.length > LOOKBACK + 1) closes.shift();
}

/** 10-bar return on the latest close, or null before enough history. */
function ret10(): number | null {
  if (closes.length < LOOKBACK + 1) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[0]!;
  return (now - then) / then;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) pushClose(bar);
    if (state.warmingUp) return [];
    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const close = Number(state.close(SYMBOL));
      if (close > peak) peak = close;
      const orders: SellInput[] = [];
      const heldBars = state.seq - entrySeq;

      if (mode === 'mom' && !tookHalf && value >= (cost * 1008n) / 1000n) {
        // Sell half at +0.8%: integer math on the value ratio, cost in
        // quote units, so value/cost >= 1.008 means +0.8% over cost.
        const half = held.qty / 2n;
        if (half > 0n) {
          orders.push({ side: 'sell', symbol: SYMBOL, qty: half, max_slippage_bps: MAX_SLIPPAGE_BPS });
          tookHalf = true;
        }
      }

      let exit = false;
      if (mode === 'mom') {
        if (value >= (cost * 101n) / 100n) exit = true;
        if (value <= (cost * 99n) / 100n) exit = true;
        if (close <= peak * (1 - MOM_TRAIL)) exit = true;
        if (heldBars >= MOM_MAX_HOLD) exit = true;
      } else {
        if (value >= (cost * 1006n) / 1000n) exit = true;
        if (value <= (cost * 996n) / 1000n) exit = true;
        if (close <= peak * (1 - DIP_TRAIL)) exit = true;
        if (heldBars >= DIP_MAX_HOLD) exit = true;
      }
      if (exit) {
        // Sell the whole remaining position. When the half sale above is
        // in the same reply, the harness fills the half first and this
        // sell is sized on the pre-reply quantity, so cap it at what is
        // left after the half sale.
        const halfQty = orders.length > 0 ? orders[0]!.qty : 0n;
        const rest = held.qty - halfQty;
        if (rest > 0n) orders.push({ side: 'sell', symbol: SYMBOL, qty: rest, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    const r = ret10();
    if (r === null) return [];
    if (state.seq >= NO_ENTRY_AFTER) return [];
    const { caps, fees } = state.hello;
    const stake = state.cash < state.equity ? state.cash : state.equity;
    if (stake < BigInt(fees.min_notional_quote_units)) return [];
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / 10000n;
    const size = stake < byWeight ? stake : byWeight;
    if (size < BigInt(fees.min_notional_quote_units)) return [];

    if (r >= MOM_TRIGGER) {
      mode = 'mom';
      entrySeq = state.seq;
      peak = Number(state.close(SYMBOL));
      tookHalf = false;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }
    if (r <= DIP_TRIGGER) {
      mode = 'dip';
      entrySeq = state.seq;
      peak = Number(state.close(SYMBOL));
      tookHalf = false;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }
    return [];
  },
});
