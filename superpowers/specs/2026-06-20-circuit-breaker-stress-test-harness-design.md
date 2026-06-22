# Circuit-Breaker & Strategy-Signal Stress-Test Harness — Design Spec
**Date:** 2026-06-20
**Status:** Approved (pending spec review)

## Goal

Build an offline harness that drives the bot's **real** production functions —
`trading_bot._evaluate_strategy()` (signal generation) and the risk-control
bookkeeping (`_record_global_sl_hit`, `_record_strategy_loss`, daily-loss-pct
check, VIX gate, force-close time) — against synthetic NIFTY/SENSEX tick data,
across all 8 regime scenarios the tick engine supports and all 9 currently
active strategies. Output is a printed report: what each strategy would have
signaled under each scenario, and whether each circuit breaker tripped at the
right threshold.

## Background

The user built a synthetic NSE options tick engine (1-second ticks, NIFTY/
SENSEX, full Greeks, 8 regime/event scenarios, WebSocket + REST API, Python
SDK) at `C:\Users\Imran\.gemini\antigravity\scratch\tick-engine`, running
locally on `:8080`. The real `db/options_tick.sqlite` only covers ~2.5 months
of mostly calm market — it has no crash, gap, or gamma-squeeze samples, so
there's no way to check whether the bot's circuit breakers (daily loss cap,
SL-hit escalation, per-strategy loss cap, VIX gate) actually trip correctly
under stress. The synthetic engine's CRISIS/EXPIRY_DAY/etc. scenarios fill
that gap.

This is explicitly **not** a strategy-edge validation tool. Per the standing
decision (`decision_strategy_validation_via_live.md`, 2026-05-29), backtest
results are not trusted for proving strategy edge — only live `bot_trades`
data is. This harness checks bot *mechanics* (do the safety rails work),
not whether any strategy is profitable.

## Scope

**In scope:**
- Relocating the tick engine into the TradingApp repo (`tools/tick-engine/`).
- A reusable adapter (`scripts/_tick_engine_adapter.py`) that turns the
  engine's tick stream into the same `idx`/`intraday`/`options_rec`/`smc`
  shapes the live bot computes.
- A driver script (`scripts/_circuit_breaker_stress_test.py`) that runs all
  8 scenarios × 9 active strategies × {NIFTY, SENSEX}, calling the real
  `_evaluate_strategy` and risk-bookkeeping functions, and prints a report.
- All 9 currently active strategies: `mtf_sniper`, `pdh_pdl_break`,
  `candle_pattern`, `expiry_theta`, `oi_sr_simple`, `gamma_blast_scalper`,
  `orb_breakout`, `inst_flow`, `vol_flow`.

**Out of scope (explicitly not touched):**
- Wiring the synthetic engine in as a live feed source for `trading_bot.py`
  (a separate, future spec — "task #2"). This harness is offline/batch only.
- Any change to `trading_bot.py`, `market_intelligence.py`, or
  `strategy_engine.py` source. Every production function is called as-is,
  never modified, never reimplemented.
- Disabled strategies (`supertrend_follow`, `ict_smc`, `oi_velocity`,
  `smart_money_divergence`, `supertrend_pure`, `option_premium_breakout`).
- Strategy threshold tuning. If a strategy looks broken under stress, that's
  a finding to report, not something this harness fixes.

## Architecture

```
tools/tick-engine/  (relocated copy, own venv, own uvicorn :8080)
        │ WS /stream (scenario, seed, speed, total_days)
        ▼
scripts/_tick_engine_adapter.py        ← reusable; "task #2" reuses this later
   - TickEngineClient (imported in-repo from tools/tick-engine/sdk)
   - resamples 1s ticks → daily/weekly/intraday(5m,15m) OHLC per index
   - builds the `idx` dict using the SAME helpers the live bot uses:
       strategy_engine._rsi/_ema/_macd/_bollinger_bands/_atr/_supertrend
       market_intelligence._smc_analysis / _options_rec
       + pivot & trend_score formulas mirrored from market_intelligence.py
         lines 839-849 / 873-902 (inlined in `_yf_index`, not separable
         functions there — see Known Risks)
   - pulls pcr/max_pain/oi/volume/iv/greeks straight off the synthetic chain
        ▼
scripts/_circuit_breaker_stress_test.py   ← driver + report
   - monkeypatches trading_bot._now() to walk simulated time, one fake
     calendar date per scenario run
   - per scenario × per strategy × {NIFTY, SENSEX}:
       calls the REAL _evaluate_strategy(strategy, idx, regime, index_name,
         intraday)
       on signal → simulates the fill/exit using the REAL bracket-%
         constants from trading_bot.py against the synthetic premium path
       feeds the outcome into the REAL _record_close / _record_global_sl_hit
         / _record_strategy_loss
       re-checks the REAL gate functions after each loss, records PASS/FAIL
   - prints a report (see Report Format)
```

## Components

### 1. Repo relocation: `tools/tick-engine/`

Copy (not move) `C:\Users\Imran\.gemini\antigravity\scratch\tick-engine\` to
`d:\TradingApp\tools\tick-engine\`. The original scratch copy is left
untouched — no deletion happens as part of this work.

- New venv at `tools/tick-engine/.venv`, mirroring the `backend/.venv`
  convention. `pip install -r requirements.txt` there (fastapi, uvicorn,
  websockets, numpy, scipy, py_vollib, pyarrow, pandas, pydantic, pyyaml,
  python-dateutil, rich, numba, httpx, python-multipart).
- Runs as its own process: `uvicorn api.main:app --port 8080` from
  `tools/tick-engine/`, independent of the backend's `:8000` uvicorn.
- Add `tools/tick-engine/storage/data/` to `.gitignore` (Parquet tick
  output — the engine's own README estimates ~10GB/year). `.venv/` and
  `__pycache__/` are already covered by the existing global patterns.
- Judgment call, flagged explicitly: this is new top-level testing
  infrastructure, not a new page/broker/scheduler job, so it's being
  treated as in-bounds under the Phase 2 freeze's "analysis scripts/
  queries" allowance. It is a bigger lift than a typical script.
- After this ships, update `code_map.md` with the new `tools/tick-engine/`
  entry per the standing "update after structural change" rule.

### 2. `scripts/_tick_engine_adapter.py`

Runs inside `backend/.venv` (already has `websockets` as a dependency —
confirmed in `backend/pyproject.toml`). Adds `tools/tick-engine` to
`sys.path` and imports `sdk.python.tick_engine_client.TickEngineClient`
directly (in-repo import, not a cross-filesystem scratch dependency).

Responsibilities:
- Connect to `ws://localhost:8080/stream`, subscribe with a chosen
  `initial_regime`/scenario, `seed`, `speed` (use high speed, e.g. 500-1000x,
  for fast iteration), and `total_days` covering warm-up + the test day.
- Accumulate incoming ticks per index into running 1-min OHLC bars (streamed,
  not batch-resampled — see plan), rolling each completed simulated day into
  one row of a `daily` DataFrame. `weekly` is derived from `daily` by
  grouping every 5 consecutive trading-day rows (the synthetic calendar has
  no weekend gaps, so 5 sequential trading days IS a calendar week).
- Build the `idx` dict by calling, in order, the exact same helper functions
  `market_intelligence._yf_index` calls on the live path:
  `strategy_engine._rsi(close, 14)`, `_macd(close)`, `_ema(close, {20,50,200})`,
  `_bollinger_bands(close, 20, 2)`, `_supertrend(daily)`, `_atr(daily)`.
- Build the `intraday` dict using `backend.services.intraday_signals`'s real
  `_compute_tf_signals(df)` — discovered during planning to be the actual
  pure function the live bot calls for each of "1m"/"5m"/"15m" (via
  `get_intraday_signals()`, which is otherwise unusable directly because it
  fetches yfinance internally). The adapter resamples its 1-min bars to 5m/
  15m the same way `intraday_signals._resample()` does, calls
  `_compute_tf_signals()` directly (no mirroring needed — it's pure), then
  mirrors only the ~20-line `mtf_consensus`/`mtf_strength` aggregation block
  (`intraday_signals.py` lines 367-388) since that part is inlined in the
  async `get_intraday_signals()` rather than factored out.
- Compute pivot/r1/r2/s1/s2 from the last two synthetic weekly bars, and
  `trend_score`/`trend_label` from the 12-signal formula — both mirrored
  verbatim from `market_intelligence.py` (lines 839-849, 873-902) since
  they're inlined in `_yf_index` rather than separable functions. Comment
  in the adapter points back to those exact line numbers.
- Call `market_intelligence._smc_analysis(daily, price, atr, ema200)` and
  `market_intelligence._options_rec(...)` directly — both are already pure
  functions taking explicit args, no mirroring needed. `pcr`, `max_pain`,
  `ce_oi_total`, `pe_oi_total` come straight from the synthetic chain's
  per-strike `oi` fields and the chain-level `pcr`/`max_pain` the engine
  already reports.
- Expose one function: `build_idx_and_intraday(tick_history, index_name) ->
  (idx: dict, intraday: dict, regime: str)` per simulated day, used by the
  driver script.

### 3. `scripts/_circuit_breaker_stress_test.py`

The driver and report generator.

- **Time control:** monkeypatches `backend.services.trading_bot._now` for
  the duration of the run. Each scenario run gets its own fake calendar date
  (e.g. scenario N → `2030-01-0{N}`), so the date-keyed risk dicts
  (`_global_daily_pnl`, `_strategy_daily_losses`, `_global_dir_sl_hits`)
  never collide across scenario runs. Within a scenario run, fake time
  advances through the simulated trading day in step with the synthetic
  ticks, so time-gated logic (`mtf_sniper`'s 10:00-12:00 block,
  `expiry_theta`'s 11:00-12:00 window) is exercised correctly.
- **Logging isolation (critical):** `_evaluate_strategy`'s branches call the
  module-level `trading_bot.blog(...)`, which by default forwards to
  `bot_logger.blog()` and persists to the real SQLite log table — the same
  one `bot_analysis.py` trusts for live win-rate stats. The harness
  monkeypatches `trading_bot.blog` itself (not `_dry_run_eval` — see below)
  to a collector that appends into the report's own buffer instead of
  touching the real logger/DB.
  - Deliberately **not** using the existing `_dry_run_eval` flag for this:
    that flag also suppresses the `_mtf_last_signal` cooldown-state write
    (`if not _dry_run_eval: _mtf_last_signal[index_name] = ...`), which
    would make `MTF_SIGNAL_COOLDOWN_SEC` never actually engage during a
    simulated day — defeating the point of testing cooldown behavior.
    Patching `blog` directly leaves all real state-mutating dict writes
    (cooldowns, loss counters, SL-hit counters) intact and exercised
    normally; only the side-effecting DB write is intercepted.
- **State-persistence isolation (critical, separate from logging):**
  `_record_global_sl_hit`, `_record_strategy_loss`, and `_update_global_pnl`
  each call `trading_bot._save_bot_state()` internally, which overwrites the
  real `db/bot_state.json` with the CURRENT in-memory contents of
  `_strategy_daily_losses` / `_global_daily_pnl` / `_global_peak_pnl` /
  `_global_dir_sl_hits` / `_mtf_sniper_dir_losses`. The harness runs in a
  separate process that never calls `_load_bot_state()`, so its copies of
  those dicts start empty — the first harness-triggered save would overwrite
  the real file with a snapshot containing only synthetic fake-dated entries,
  destroying whatever real same-day state was on disk. The harness
  monkeypatches `trading_bot._save_bot_state` to a no-op for the duration of
  the run, the same way it patches `blog` — this is a second, distinct
  instance of the production-state-pollution pattern that drove the
  logging-isolation fix above, not a variant of it.
- **Warm-up:** before the scenario day, runs the engine for a configurable
  warm-up period (default 210 simulated days at `SIDEWAYS_LOW_IV`, the
  cheapest/most neutral regime) at a fixed speed of 1000x so EMA200 (needs
  ~200 daily bars) and `_smc_analysis` (needs ~80) have real history rather
  than degraded fallbacks. This costs seconds of wall-clock time, not 210
  real days. The scenario/test day itself also streams at speed=1000 — the
  speed multiplier paces tick delivery, it doesn't drop ticks, so this
  doesn't trade off completeness for iteration speed.
- **Per scenario × per strategy × per index:** calls the real
  `_evaluate_strategy`. On a signal, simulates the trade's fill/exit by
  calling the real `_dynamic_sl_tgt(strategy, action, idx, intraday, premium,
  confluence, index_name)` for the actual (sl_pts, tgt_pts) — this is the
  real source of the per-strategy bracket sizing (not a flat % constant as
  originally described; `_dynamic_sl_tgt` computes it per-strategy from ATR/
  S-R levels with per-strategy premium caps near line 2239) — then walks the
  synthetic chain's premium path forward against those levels, applying the
  real `_compute_trailing_sl()` (`TRAIL_BE_R`/`TRAIL_LOCK_R`) and real
  `_txn_charges()` / `SLIPPAGE_PCT_PER_SIDE`. Smart-exit (`_should_smart_exit`)
  is explicitly NOT simulated — out of scope, see Known Risks. This is a
  **new** fill-simulation function,
  not a reuse of `_trend_sr_pullback_backtest.py`'s `simulate_trade()` —
  that function is hardcoded around `sqlite3.Connection` premium lookups
  against the real tick DB, which doesn't apply here. It mirrors that
  function's walk-forward/bracket/trailing-stop *mechanics*, sourced from
  the synthetic chain's premium path instead. The resulting win/loss and
  P&L feed into the real `_record_close`, `_record_global_sl_hit`,
  `_record_strategy_loss`.
- **Gate verification:** instantiates one real `trading_bot.SessionState(capital)`
  per (scenario, index) pair — the same per-session risk object the live bot
  uses — shared across that index's strategies for the scenario day, calling
  its real `.record_close(pnl)` / `.is_daily_loss_exceeded()` /
  `.is_on_cooldown()` after each simulated trade. Combined with the
  module-level gates (`_is_strategy_disabled()` backed by
  `_max_strategy_losses()`, `_global_sl_blocked()` backed by
  `_DIR_SL_COOLDOWNS`), re-checked after each simulated loss and recorded as
  a PASS/FAIL line: did the gate engage at the count/threshold it's supposed
  to.

## Report Format

Printed report, matching the convention of existing `scripts/_*.py`
backtest/analysis scripts (e.g. `_trend_sr_pullback_backtest.py`'s
`report()`), not pytest assertions:

```
=== Scenario: CRISIS (seed=42, NIFTY) ===
  mtf_sniper      : 3 signals (2 CE, 1 PE) | sim P&L: -₹4,210
  orb_breakout    : 1 signal  (1 PE)       | sim P&L: -₹890
  ...
  Circuit breakers:
    [PASS] Global dir-SL escalation: blocked PE entries after 4th hit (11:42 IST)
    [PASS] MAX_DAILY_LOSS_PCT: bot would have stopped at 14:05 IST (-3.1% of capital)
    [FAIL] expiry_theta strategy-loss cap: fired a 4th trade after cap=3 reached
=== Scenario: EXPIRY_DAY ===
  ...
```

## Error Handling

- Tick engine not reachable on `:8080` → fail fast with a message telling
  the user to start it from `tools/tick-engine/` (own venv), not a silent
  empty report.
- A given scenario/strategy combo lacks enough warm-up history (e.g. a
  partial run) → skip that combo, log it as "skipped — insufficient
  history" in the report, don't abort the whole 8-scenario sweep.
- WebSocket disconnects mid-scenario → mark that scenario's report section
  as incomplete, continue to the next scenario.

## Validating the Harness Itself

Before trusting the full 8×9 sweep:
1. One smoke run with `total_days=1` at a known regime — manually inspect
   the adapter's resampled OHLC bars against the raw tick stream to confirm
   the resampling is correct.
2. For the CRISIS scenario specifically, manually confirm the synthetic
   India VIX actually exceeds `MAX_VIX_FOR_ENTRY` (25.0) enough that the
   report's VIX-gate PASS/FAIL is meaningful and not vacuously true.

## Known Risks / Assumptions

- **Mirrored formulas drift risk:** the pivot and `trend_score` formulas are
  copied (not imported) from `market_intelligence.py` because they're
  inlined in `_yf_index` rather than standalone functions. If that formula
  changes in `market_intelligence.py`, the adapter's copy will silently go
  stale. Documented with a line-number pointer in the adapter so this is a
  visible diff risk, not a hidden one. No code change to
  `market_intelligence.py` to extract these into testable functions is
  in scope here — that would be a refactor of production code outside this
  harness's stated scope.
- **Trade simulation is necessarily approximate:** the bot's real fill
  behavior involves bid-ask/timing nuances beyond what `simulate_trade`-style
  premium-path walking can capture exactly. This is the same approximation
  every existing `scripts/_*_backtest.py` script already makes; it's
  adequate for checking whether circuit breakers trip, not for asserting
  exact P&L figures.
- **Smart-exit not simulated:** `_should_smart_exit()` (5m RSI/Supertrend
  early-exit logic) is real production logic but is not exercised by the
  fill simulator — only target/SL/trailing-stop. Simulated trades that would
  have smart-exited early instead run to target or SL, which can overstate
  per-trade P&L magnitude. Doesn't affect circuit-breaker PASS/FAIL checks,
  which key off win/loss counts and thresholds, not exact P&L.
- **Phase 2 freeze judgment call:** relocating and standing up a second
  FastAPI service (`tools/tick-engine`) is a larger addition than the
  freeze's "analysis scripts/queries" wording was likely written for, even
  though it adds no production-path risk. Flagged for visibility; proceeding
  on the basis that it's test-only infrastructure with zero coupling to the
  live bot loop.
