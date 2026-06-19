# mtf_sniper RSI Gate Redesign — Design Spec
**Date:** 2026-06-19
**Status:** Approved (pending spec review)

## Goal

Replace mtf_sniper's fixed absolute RSI entry window with a session-relative
"pullback depth" gate, and validate it via counterfactual price replay before
shipping, so the strategy stops going silent for days at a time whenever RSI
drifts and pins near the window's edge during a slow trend.

## Background

mtf_sniper's CE/PE entry condition (`backend/services/trading_bot.py:1220-1226`)
gates on a **fixed absolute RSI(15m) band**: `45 < rsi < 60` for CE,
`38 < rsi < 58` for PE (on top of the existing `daily_bullish`/`daily_bearish`
trend gate, which is NOT changing — see Scope).

This band has already needed one reactive widening: on 2026-06-15, RSI pinned
at 57-59 all session against the then-ceiling of 55, producing zero signals;
the ceiling was bumped to 60 the same day. On 2026-06-17/18, RSI pinned at
59-63 — at or above the *new* ceiling — and produced zero signals again. Same
failure mode, second occurrence in four days: a slow, low-volatility uptrend
keeps RSI sitting near a fixed threshold rather than genuinely pulling back
into it, and any fixed absolute window will eventually be outrun by enough
trend drift.

## Scope

**In scope:**
- The RSI sub-condition only, for both legs (CE/PE) of `mtf_sniper`, both
  indices (NIFTY, SENSEX) it currently trades.
- A new counterfactual replay script to validate the redesign before it ships.

**Out of scope (explicitly not touched):**
- The macro trend gate (`daily_bullish`/`daily_bearish`: `price > ema50 and
  trend_score > 70`, vice versa). Evidence points only at the RSI sub-condition
  — trend_score was already elevated (67-83) on the drought days, so the macro
  gate was already passing.
- The 10:00-12:00 entry block shipped 2026-06-18 (separate, already-validated
  change).
- `MTF_SIGNAL_COOLDOWN_SEC`, the mtf_sniper direction circuit breaker
  (`_mtf_sniper_dir_blocked`), and `_dynamic_sl_tgt`'s target/SL formula for
  mtf_sniper (pivot target, ATR×1.2 SL) — all unchanged.
- Any other strategy's RSI/threshold logic.

## New Entry Logic

Per index, per session (reset at market open 09:15 IST):

- Track a running `session_rsi_high` (for CE) and `session_rsi_low` (for PE)
  — simple running max/min of RSI(15m) updated every evaluation cycle.
- **CE** fires when: `daily_bullish` (unchanged) AND
  `(session_rsi_high - rsi) >= N` (real pullback depth, not absolute level)
  AND `rsi > FLOOR` (still bullish bias, not an actual reversal) AND
  `price > ema20` (unchanged).
- **PE** mirrors off `session_rsi_low`: `(rsi - session_rsi_low) >= N` AND
  `rsi < CEILING` AND `price < ema20`.

`FLOOR` (CE) and `CEILING` (PE) reuse that same leg's own existing bound from
the old window — CE keeps its old floor (~45), PE keeps its old ceiling
(~58) — purely as a reversal sanity check, not as the primary gate. This is
exactly the role that bound already played in the old condition (e.g. for CE,
45 already stopped RSI from dropping so far it stopped being a "pullback" and
became a reversal); only the pinned-prone side (CE's ceiling, PE's floor) is
being replaced with the relative depth measure.

`N` (pullback depth, in RSI points) is **not fixed upfront**. The replay
tests candidate values and selects the one the fit half prefers, then
confirms it generalizes — see Validation below.

On a day where RSI never meaningfully moves (e.g., Jun 17: 60→61 all
session), this produces zero signals, same as today — correctly, because
there was no real pullback, not because of an arbitrary ceiling.

## Validation: Counterfactual Replay

New script: `scripts/_mtf_sniper_rsi_redesign.py` (scratch analysis script,
matches `scripts/_mtf_sniper_loop_iter1.py` / `scripts/_trend_sr_pullback_backtest.py`
convention — safe to delete after use).

**Data:** Reconstruct 15m RSI, `ema20`, `ema50`, `trend_score` per index from
yfinance candles, full history 2026-04-15 → present (same reconstruction
approach the Phase 0 diagnosis already validated for trend_score gaps).

**Candidate trade generation:** For each candidate `N` in `{3, 5, 8, 10}`
points, walk the full reconstructed series and record every bar where the new
CE/PE condition would have fired (respecting the unchanged macro gate, cooldown,
and the existing 10:00-12:00 block). For each simulated entry, simulate the
outcome using the **same exit formula mtf_sniper already uses live**
(`_dynamic_sl_tgt`'s `strategy == "mtf_sniper"` branch: target = next pivot
level in premium points or `atr_pts*2.0` fallback, SL = `atr_pts*1.2`, capped/
floored by the shared `MIN_TGT`/`MIN_SL`/`MIN_RR` logic at lines 2235-2258),
walking forward through real tick data where available and Black-Scholes
fallback otherwise — reusing `nearest_expiry()`/`price_premium()` from
`_trend_sr_pullback_backtest.py` rather than re-deriving them.

**Known simplification:** the replay simulates target/SL/EOD exit only. It
does **not** model the bot's live trailing-SL (`_compute_trailing_sl`) or
smart-exit (`_should_smart_exit`) logic — same simplification
`_trend_sr_pullback_backtest.py` already made for its own validation. This
will tend to understate exits that would have trailed for more than the fixed
target, and is a known conservative bias, not an oversight.

**Fit/confirm procedure (mirrors `_mtf_sniper_loop_iter1.py`):** For each of
30 seeds, randomly split each candidate `N`'s full simulated trade list 50/50.
On the fit half, compute aggregate PnL per candidate `N` among those with
≥10 trades, and pick whichever has the highest fit-half PnL (if no candidate
reaches 10 trades, that seed is excluded from the report). Apply that seed's
chosen `N` to the confirm half and record whether confirm-half PnL is
positive. Report, across all 30 seeds: how often each `N` gets chosen
(stability of the choice) and how often confirm-half PnL is positive
(generalization).

**Success bar:** Net positive confirm-half PnL, robust across the majority of
seeds — same bar `_mtf_sniper_loop_iter1.py` used for the 10:00-12:00 block.

## Rollout

If validated, replace lines 1223-1226 in `trading_bot.py` directly with the
new condition (no flag, no shadow period) — same path the 10:00-12:00 block
took. The chosen `N`, `FLOOR`/`CEILING` become new named constants near the
existing mtf_sniper threshold comments (lines 1198-1212), with the same
dated-comment convention recording what was tried and why.

## What Is NOT in Scope

- Touching any strategy other than `mtf_sniper`.
- Modeling trailing-SL or smart-exit in the replay (see Known simplification).
- A shadow/log-only rollout period — user explicitly chose direct replacement
  if validation passes.
- Reconstructing trend_score from anything other than yfinance candles (no
  new data source).
