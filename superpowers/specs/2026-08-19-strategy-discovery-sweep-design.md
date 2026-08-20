# NIFTY/SENSEX Strategy Discovery Sweep — Design

## Purpose

Mirror the strategy-R&D exercise done in `ForexTraderVX` (~250 variants tested
across crypto/forex, walk-forward validated, one composite "hybrid" survivor)
against our own NIFTY/SENSEX options data — to (1) find the best-fitting
strategy config via a broad backtest sweep, and (2) determine whether a
market-regime-aware approach can identify which strategy fits current
conditions.

This is read-only analysis (backtest scripts + a findings report). It does
not modify `trading_bot.py` or change what runs live — that is a separate
decision at a future block boundary, gated by the project's block-freeze
discipline (see root `CLAUDE.md`).

## Honesty caveat (governs how every result here is read)

`db/options_tick.sqlite` covers **~79 days since 2026-04-15** — one, maybe
two market regimes, not ForexTraderVX's 8-10 years across multiple bull/bear/
chop cycles. ForexTraderVX's own hard-won lesson: an 84-variant sweep with
only a 6-month in-sample/out-of-sample split found 7 "survivors" that **all
subsequently failed** when walk-forward tested against the full 8-year
history. Every result from this sweep is provisional, per the project's
existing block-freeze rule ("n<20 → extend, don't decide"). Revisit and
re-run as more live data accumulates.

## Components

### 1. Signal families + parameter grid (`scripts/strategy_sweep.py`)

Reuses `backend/services/options_backtest_engine.py`'s existing tick loader
and indicator engine (`_load_ticks`, `_compute_indicators`) — no new data
pipeline. Adds a small factory generating concrete configs across 5 families,
using indicators already computed (rsi, ema20/50, atr, bb bands, trend_score,
supertrend) plus OI/PCR from the tick data:

- **Trend-follow** — EMA20/50 cross + trend_score threshold
- **Mean-reversion / fade** — RSI extreme + BB-band touch
- **Breakout** — spot vs rolling N-bar high/low
- **OI-imbalance** — PCR / OI-velocity direction
- **Gamma/expiry-timing** — entry window + trend threshold on expiry day

Each family swept across a parameter grid (thresholds, lookback bars,
SL/target R-multiple) → hundreds of concrete configs, each run once through a
shared backtest loop (one pass over ticks + indicators per index, configs
evaluated in-loop — same performance pattern as `target_size_sweep.py`).

### 2. Hybrid composite

One explicit construction mirroring ForexTraderVX's actual survivor pattern
(regime filter → entry signal → structural stop → R-multiple target), not
just hoped to emerge from the grid:

- **Regime filter**: trend_score band (avoid chop)
- **Entry signal**: best-performing family from the sweep (picked on train
  data only, not after seeing test results)
- **Stop**: recent swing high/low in the option premium series (falls back
  to ATR multiple if too tight — mirrors `strategy_hybrid.py`'s fallback)
- **Target**: R-multiple of that structural stop distance

Tested through the identical train/test pipeline as every other config — no
special-casing.

### 3. Cost model

Reuse the calibrated real cost model already in this repo: `_txn_charges()`
(~₹81/RT NIFTY paper) + `SLIPPAGE_PCT_PER_SIDE` (0.10% of premium notional
per side), same as `target_size_sweep.py`. No fee approximation needed —
already more accurate than ForexTraderVX's synthetic-fee model.

### 4. Walk-forward discipline

- Split the 79 days ~60/40 by time: train ≈ first 47 days, test ≈ last 32
  days.
- Pick the best config per family on train data only.
- Run that exact config, untouched, on test data — no refitting.
- Reject anything that doesn't hold up out-of-sample (same discipline that
  killed `oi_velocity` and `pdh_pdl_break`).
- **Min-n = 20 closed trades in the test window** to be considered at all.
  Below that: reported as "not enough data," never as a pass/fail verdict.

### 5. Regime classification + slicing (`scripts/regime_classify.py`)

- Bucket each session using `trend_score` (already computed) into
  trend-up / trend-down / range, crossed with an ATR-percentile split
  (high-vol / low-vol split at the median) → up to 6 regime buckets.
- Re-run the profit-factor ranking **within each bucket** so the output can
  state conditional winners ("candle_pattern wins in trend-up/low-vol,
  snapback wins in range/high-vol") instead of forcing one universal winner.
- Report which bucket the most recent 1-2 weeks fall into, so there is a
  concrete "what fits right now" answer alongside the historical breakdown.

### 6. Ranking metric

**Profit factor** (gross wins ÷ gross losses) as the primary ranking metric,
matching ForexTraderVX's PF>1 = viable convention. Report expectancy per
trade (₹), win rate, and n alongside for every surviving config — same
columns `bot_analysis.py` already reports, for continuity.

### 7. Deliverables

- `scripts/strategy_sweep.py` — family/grid generator + train/test runner.
  Re-runnable as more `options_tick.sqlite` data accumulates. CLI args for
  index (NIFTY/SENSEX/BOTH), date range, split date (mirrors
  `walk_forward_target.py`'s interface).
- `scripts/regime_classify.py` — session-level regime bucketing + per-bucket
  ranking table + "current regime" call-out.
- A findings writeup (table format) at the end of the exercise — presented
  to the user, not necessarily a new file (matches the user's stated
  preference for tables over prose).

Nothing in this exercise touches `trading_bot.py`, `DISABLED_STRATEGIES`, or
any live/paper bot config. If a config or regime-fit looks genuinely
promising, that becomes a pre-registered judgment for the *next* block
boundary — not an immediate change.

## Out of scope

- Multi-year backtest (data doesn't exist yet for NIFTY/SENSEX options at
  this granularity).
- Second independent data source cross-check (ForexTraderVX flagged this as
  a real risk — `options_tick.sqlite` is single-source broker data — but
  there is no alternate minute-level options-chain source available today;
  noted as a known limitation, not solved here).
- Wiring any result into live trading — that is a separate future decision.
