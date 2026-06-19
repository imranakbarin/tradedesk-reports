# mtf_sniper RSI Redesign — Counterfactual Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/_mtf_sniper_rsi_redesign.py`, a standalone replay script that counterfactually tests a session-relative "pullback depth" RSI gate for `mtf_sniper` against real historical data, reporting per-candidate-N win rate/PnL and a 30-seed fit/confirm generalization check — producing the evidence needed to pick a winning `N` before any change is made to `trading_bot.py` (live code change is explicitly out of scope for this plan).

**Architecture:** Reuse `_trend_sr_pullback_backtest.py`'s real-data primitives (`slice_asof`, `htf_indicators_asof`, `price_premium`, `bs_fallback_premium`, `nearest_strike`, `fetch_yf_history`, `txn_charges`, etc.) via `import _trend_sr_pullback_backtest as tsp` — no duplication. Add only the small, genuinely new pieces: (1) a per-tick "live-equivalent daily bar" reconstruction that appends a synthetic still-forming bar onto real daily history so `rsi`/`ema20`/`ema50`/`macd` evolve within a session exactly as they do live; (2) the new pullback-depth entry condition; (3) a partial confluence score (5 of 6 reconstructible daily sub-signals); (4) mtf_sniper's exact `_dynamic_sl_tgt` formula, duplicated verbatim since it's strategy-specific and not in `tsp`; (5) a premium-based (not spot-based) exit walk, since mtf_sniper's SL/target are denominated in option premium points; (6) a fit/confirm loop across `N ∈ {3,5,8,10}` mirroring `_mtf_sniper_loop_iter1.py`'s methodology.

**Tech Stack:** Python 3.11, pandas, sqlite3, yfinance (via `tsp.fetch_yf_history`), pytest. Backend venv (`backend/.venv`) has all dependencies already installed (same env used by `_trend_sr_pullback_backtest.py`).

---

## Spec Reference

This plan implements `docs/superpowers/specs/2026-06-19-mtf-sniper-rsi-redesign-design.md` (approved, with two corrections committed `48af77d` and `4452f70`). Read that file for the full rationale — this plan only restates what's needed to implement it.

## Out of Scope (do not implement)

- Any change to `backend/services/trading_bot.py`. This script reads nothing from and writes nothing to live code or live state.
- Modeling trailing-SL (`_compute_trailing_sl`) or smart-exit (`_should_smart_exit`) — target/SL/EOD only, matching `_trend_sr_pullback_backtest.py`'s own simplification.
- Reconstructing `options_rec` or any of the 4 intraday confluence sub-signals — no historical 5m/15m OHLC exists for this date range.

---

### Task 1: Script skeleton + module-level constants

**Files:**
- Create: `scripts/_mtf_sniper_rsi_redesign.py`

- [ ] **Step 1: Write the file header, imports, and constants**

```python
"""
Counterfactual replay: tests a session-relative "pullback depth" RSI gate as
a replacement for mtf_sniper's current fixed RSI window (rsi_ce 45-55, rsi_pe
unchanged), per docs/superpowers/specs/2026-06-19-mtf-sniper-rsi-redesign-design.md.

Does NOT modify trading_bot.py or any live state. Read-only against:
  - yfinance daily/weekly history (via _trend_sr_pullback_backtest.fetch_yf_history)
  - db/options_tick.sqlite (real spot/premium/pcr ticks, read-only)

For each candidate pullback depth N in {3, 5, 8, 10} RSI points: walks every
real historical tick instant, reconstructs the live-equivalent daily-bar state
(today's still-forming bar's close = that instant's real spot price -- this is
how idx['rsi']/ema20/ema50/trend_score actually move intraday live), applies
the new entry condition, sizes SL/target via mtf_sniper's exact
_dynamic_sl_tgt formula, and walks forward through real premium ticks to
label WIN/LOSS/EOD. Reports per-N stats plus a 30-seed fit/confirm split
(mirrors _mtf_sniper_loop_iter1.py's methodology) to check whether the best N
on one random half of the data still wins on the other half.

KNOWN SIMPLIFICATIONS (see spec's "Known simplification" sections for why):
  - Confluence score is partial: 5/10 max (supertrend, MACD, RSI, EMA20, PCR).
    options_rec and all 4 intraday sub-signals are not reconstructable.
  - No trailing-SL / smart-exit -- target/SL/EOD only.
  - Real tick coverage is ~36/46 trading days since 2026-04-15 (logger uptime
    gaps) -- gaps are skipped, not interpolated.

Run: cd backend && .venv\\Scripts\\python.exe ..\\scripts\\_mtf_sniper_rsi_redesign.py
Safe to delete after the redesign decision is made and documented.
"""

import io
import random
import sqlite3
import sys
from datetime import time as dt_time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import _trend_sr_pullback_backtest as tsp

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
from backend.services.strategy_engine import _rsi, _ema, _macd  # noqa: E402

CANDIDATE_N = [3, 5, 8, 10]
FLOOR_CE = 45        # mtf_sniper's existing CE RSI floor -- unchanged by this redesign
CEILING_PE = 58       # mtf_sniper's existing PE RSI ceiling -- unchanged by this redesign
MTF_COOLDOWN_SEC = 45 * 60   # trading_bot.py:217 MTF_SIGNAL_COOLDOWN_SEC
BLOCK_START = dt_time(10, 0)  # trading_bot.py 10:00-12:00 block, shipped 2026-06-18 -- unchanged
BLOCK_END = dt_time(12, 0)
MIN_CONF = 2          # trading_bot.py mtf_sniper's min_conf (the "else" branch)
MIN_FIT_TRADES = 10   # candidate must have >=10 fit-half trades to be eligible
FIT_CONFIRM_SEEDS = 30
```

- [ ] **Step 2: Verify imports resolve**

Run (from repo root, PowerShell):
```powershell
cd backend
.venv\Scripts\Activate.ps1
cd ..
python -c "import sys; sys.path.insert(0,'scripts'); import _mtf_sniper_rsi_redesign as m; print(m.CANDIDATE_N, m.MTF_COOLDOWN_SEC)"
```
Expected: `[3, 5, 8, 10] 2700` with no import errors.

- [ ] **Step 3: Commit**

```bash
git -C docs add -A
git add scripts/_mtf_sniper_rsi_redesign.py
git commit -m "feat: scaffold mtf_sniper RSI redesign replay script"
```

---

### Task 2: `daily_state_asof` — live-equivalent daily-bar reconstruction

**Files:**
- Modify: `scripts/_mtf_sniper_rsi_redesign.py`
- Test: `scripts/test_mtf_sniper_rsi_redesign.py`

This is the core mechanism the whole redesign depends on: reconstructing, at
any historical instant, what `idx["rsi"]`/`ema20`/`ema50`/`trend_score` would
have read live — by appending a synthetic still-forming "today" bar (real
session open + ticks-so-far high/low/close) onto real prior daily history,
then running the same indicator math `market_intelligence.py` uses live.

- [ ] **Step 1: Write the failing test**

Create `scripts/test_mtf_sniper_rsi_redesign.py`:

```python
import sqlite3
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import _mtf_sniper_rsi_redesign as m
import _trend_sr_pullback_backtest as tsp


def _daily_df(closes, start="2026-01-01"):
    dates = pd.date_range(start, periods=len(closes), freq="D")
    return pd.DataFrame({
        "timestamp": dates, "open": closes, "high": [c * 1.01 for c in closes],
        "low": [c * 0.99 for c in closes], "close": closes,
    })


def _weekly_df(closes, start="2026-01-05"):
    dates = pd.date_range(start, periods=len(closes), freq="W")
    return pd.DataFrame({
        "timestamp": dates, "open": closes, "high": [c * 1.02 for c in closes],
        "low": [c * 0.98 for c in closes], "close": closes,
    })


def test_daily_state_asof_high_low_close_come_from_ticks_not_real_day():
    daily_before = _daily_df([100 + i * 0.1 for i in range(40)])
    weekly_before = _weekly_df([100, 101, 102, 103])
    state = m.daily_state_asof(daily_before, weekly_before, day_open=102.0,
                                 ticks_so_far=[100.0, 105.0, 98.0])
    assert state["price"] == 98.0  # close = latest tick, not the real day's actual close
    for key in ("rsi", "ema20", "ema50", "macd", "macd_signal", "trend_score",
                "supertrend", "atr", "pivot", "r1", "s1"):
        assert key in state


def test_daily_state_asof_day_open_can_set_the_synthetic_high():
    daily_before = _daily_df([100 + i * 0.1 for i in range(40)])
    weekly_before = _weekly_df([100, 101, 102, 103])
    # gap-up open at 110, price never trades back above it
    state = m.daily_state_asof(daily_before, weekly_before, day_open=110.0,
                                 ticks_so_far=[105.0, 103.0, 104.0])
    assert state["price"] == 104.0


def test_daily_state_asof_rsi_reacts_to_latest_tick_not_frozen():
    # flat prior history -- RSI should sit near neutral with a flat day so far
    daily_before = _daily_df([100.0] * 40)
    weekly_before = _weekly_df([100.0] * 6)
    flat_state = m.daily_state_asof(daily_before, weekly_before, day_open=100.0,
                                      ticks_so_far=[100.0, 100.0, 100.0])
    jump_state = m.daily_state_asof(daily_before, weekly_before, day_open=100.0,
                                      ticks_so_far=[100.0, 100.0, 150.0])
    # a big intraday jump must push RSI higher than the flat case -- this is
    # the entire premise of the redesign (RSI moves WITHIN a session live)
    assert jump_state["rsi"] > flat_state["rsi"]
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd backend
.venv\Scripts\Activate.ps1
cd ..
pytest scripts/test_mtf_sniper_rsi_redesign.py -v
```
Expected: FAIL — `AttributeError: module '_mtf_sniper_rsi_redesign' has no attribute 'daily_state_asof'`.

- [ ] **Step 3: Implement `daily_state_asof`**

Add to `scripts/_mtf_sniper_rsi_redesign.py`:

```python
def daily_state_asof(daily_before: pd.DataFrame, weekly_before: pd.DataFrame,
                      day_open: float, ticks_so_far: list[float]) -> dict:
    """Reconstructs today's still-forming daily bar from ticks_so_far (real
    spot prices sampled up to and including this instant) and appends it onto
    daily_before (already as-of-sliced to exclude today by the caller), then
    runs the same indicator math market_intelligence.py uses live. day_open is
    the real session open from yfinance's completed-day row for this date --
    known at 09:15, not look-ahead. high/low/close come only from
    ticks_so_far, never from the day's real (not-yet-known-at-this-instant)
    high/low/close."""
    high = max(day_open, max(ticks_so_far))
    low = min(day_open, min(ticks_so_far))
    close = ticks_so_far[-1]
    synthetic_row = pd.DataFrame([{
        "timestamp": pd.NaT, "open": day_open, "high": high, "low": low, "close": close,
    }])
    daily_asof = pd.concat([daily_before, synthetic_row], ignore_index=True)
    htf = tsp.htf_indicators_asof(daily_asof, weekly_before)

    c = daily_asof["close"]
    rsi = _rsi(c, 14)
    ema20 = float(_ema(c, 20).iloc[-1])
    ema50 = float(_ema(c, 50).iloc[-1])
    macd_val, macd_sig = _macd(c)
    return {**htf, "rsi": rsi, "ema20": ema20, "ema50": ema50,
            "macd": macd_val, "macd_signal": macd_sig}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
pytest scripts/test_mtf_sniper_rsi_redesign.py -v
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/_mtf_sniper_rsi_redesign.py scripts/test_mtf_sniper_rsi_redesign.py
git commit -m "feat: add daily_state_asof live-equivalent bar reconstruction"
```

---

### Task 3: `mtf_confluence_partial` — partial confluence score

**Files:**
- Modify: `scripts/_mtf_sniper_rsi_redesign.py`
- Test: `scripts/test_mtf_sniper_rsi_redesign.py`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_mtf_sniper_rsi_redesign.py`:

```python
def _state(supertrend="LONG", macd=1.0, macd_signal=0.5, rsi=50.0, price=100.0,
            ema20=99.0, pcr=1.0):
    return {"supertrend": supertrend, "macd": macd, "macd_signal": macd_signal,
            "rsi": rsi, "price": price, "ema20": ema20, "pcr": pcr}


def test_mtf_confluence_partial_scores_zero_when_nothing_agrees_ce():
    state = _state(supertrend="SHORT", macd=0.5, macd_signal=1.0, rsi=40.0,
                    price=98.0, ema20=99.0, pcr=0.8)
    assert m.mtf_confluence_partial(state, "CE") == 0


def test_mtf_confluence_partial_scores_five_when_everything_agrees_ce():
    state = _state(supertrend="LONG", macd=1.0, macd_signal=0.5, rsi=50.0,
                    price=100.0, ema20=99.0, pcr=1.2)
    assert m.mtf_confluence_partial(state, "CE") == 5


def test_mtf_confluence_partial_scores_five_when_everything_agrees_pe():
    state = _state(supertrend="SHORT", macd=0.5, macd_signal=1.0, rsi=50.0,
                    price=98.0, ema20=99.0, pcr=0.8)
    assert m.mtf_confluence_partial(state, "PE") == 5


def test_mtf_confluence_partial_defaults_missing_pcr_to_neutral():
    state = _state(supertrend="LONG", macd=1.0, macd_signal=0.5, rsi=50.0,
                    price=100.0, ema20=99.0, pcr=None)
    # neutral pcr (1.0) contributes 0 to either side, matching live's
    # oi.get("pcr", 1.0) default
    assert m.mtf_confluence_partial(state, "CE") == 4
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
pytest scripts/test_mtf_sniper_rsi_redesign.py -v -k confluence
```
Expected: FAIL — `AttributeError: ... no attribute 'mtf_confluence_partial'`.

- [ ] **Step 3: Implement `mtf_confluence_partial`**

```python
def mtf_confluence_partial(state: dict, action: str) -> int:
    """Partial reconstruction of trading_bot._confluence_score() (max 10).
    Reconstructs only the 5 of 6 daily sub-signals derivable from real
    historical data: supertrend, MACD, RSI, EMA20 trend (from
    daily_state_asof), and PCR (from options_ticks.pcr, carried on
    state['pcr']). Excluded: options_rec (live-only recommendation engine)
    and all 4 intraday sub-signals (need historical 5m/15m OHLC, unavailable
    -- see spec's Known Simplification). Max achievable score is 5, not 10."""
    is_bullish = action == "CE"
    score = 0
    if (is_bullish and state["supertrend"] == "LONG") or (not is_bullish and state["supertrend"] == "SHORT"):
        score += 1
    if (is_bullish and state["macd"] > state["macd_signal"]) or (not is_bullish and state["macd"] < state["macd_signal"]):
        score += 1
    if (is_bullish and state["rsi"] > 45) or (not is_bullish and state["rsi"] < 55):
        score += 1
    if (is_bullish and state["price"] > state["ema20"]) or (not is_bullish and state["price"] < state["ema20"]):
        score += 1
    pcr = state.get("pcr") if state.get("pcr") is not None else 1.0
    if (is_bullish and pcr > 1.1) or (not is_bullish and pcr < 0.9):
        score += 1
    return score
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
pytest scripts/test_mtf_sniper_rsi_redesign.py -v -k confluence
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/_mtf_sniper_rsi_redesign.py scripts/test_mtf_sniper_rsi_redesign.py
git commit -m "feat: add partial confluence score reconstruction"
```

---

### Task 4: `mtf_dynamic_sl_tgt` — exact mtf_sniper SL/target formula

**Files:**
- Modify: `scripts/_mtf_sniper_rsi_redesign.py`
- Test: `scripts/test_mtf_sniper_rsi_redesign.py`

Duplicated verbatim from `trading_bot.py:2097-2261`'s mtf_sniper branch —
not imported, because `_dynamic_sl_tgt` lives inside a module with live side
effects unsafe to trigger from a scratch script. This is a deliberate,
documented exception to DRY (same exception the spec itself calls out).

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_mtf_sniper_rsi_redesign.py`:

```python
def test_mtf_dynamic_sl_tgt_uses_pivot_level_when_available():
    signal = {"price": 24000.0, "r1": 24100.0, "s1": 23900.0, "atr": 150.0}
    sl, tgt = m.mtf_dynamic_sl_tgt(signal, "CE", entry_premium=100.0, confluence=2)
    assert sl == 13.3
    assert tgt == 20.0


def test_mtf_dynamic_sl_tgt_falls_back_to_atr_when_no_pivot_level():
    signal = {"price": 24000.0, "r1": 0.0, "s1": 0.0, "atr": 150.0}
    sl, tgt = m.mtf_dynamic_sl_tgt(signal, "CE", entry_premium=200.0, confluence=2)
    assert sl == 18.9
    assert tgt == 31.5


def test_mtf_dynamic_sl_tgt_confluence_3_widens_target_vs_confluence_2():
    signal = {"price": 24000.0, "r1": 0.0, "s1": 0.0, "atr": 140.0}
    sl2, tgt2 = m.mtf_dynamic_sl_tgt(signal, "CE", entry_premium=200.0, confluence=2)
    sl3, tgt3 = m.mtf_dynamic_sl_tgt(signal, "CE", entry_premium=200.0, confluence=3)
    assert tgt3 > tgt2
    assert sl3 == sl2  # the >=3 tier only widens target, not SL


def test_mtf_dynamic_sl_tgt_confluence_5_widens_target_and_tightens_sl():
    signal = {"price": 24000.0, "r1": 24100.0, "s1": 23900.0, "atr": 150.0}
    sl2, tgt2 = m.mtf_dynamic_sl_tgt(signal, "CE", entry_premium=500.0, confluence=2)
    sl5, tgt5 = m.mtf_dynamic_sl_tgt(signal, "CE", entry_premium=500.0, confluence=5)
    assert tgt5 > tgt2
    assert sl5 < sl2
    assert tgt2 == 30.0 and sl2 == 18.9
    assert tgt5 == 34.5 and sl5 == 17.0


def test_mtf_dynamic_sl_tgt_premium_cap_limits_target():
    # premium cap (0.20 * premium) binds before the pivot-based target would
    signal = {"price": 24000.0, "r1": 24100.0, "s1": 23900.0, "atr": 150.0}
    sl, tgt = m.mtf_dynamic_sl_tgt(signal, "CE", entry_premium=50.0, confluence=2)
    assert tgt == 10.0 * (1.5)  # tgt/sl floor of 1.2 isn't hit; min target floor 15 wins
```

Wait — that last assertion is unclear in its own right; replace with a
concretely verified value instead of inline arithmetic commentary.

- [ ] **Step 1b: Replace the premium-cap test with a verified value**

```python
def test_mtf_dynamic_sl_tgt_premium_cap_limits_target():
    # prem_cap = 0.20 * 50 = 10, below MIN_TGT(15) -> tgt floors at 15;
    # sl = atr_pts*1.2 = (150*0.30*0.35)*1.2 = 18.9; tgt/sl = 15/18.9 = 0.79 < 1.5
    # -> sl = tgt/1.5 = 10.0; tgt/sl = 1.5 >= 1.2, no further raise
    signal = {"price": 24000.0, "r1": 24100.0, "s1": 23900.0, "atr": 150.0}
    sl, tgt = m.mtf_dynamic_sl_tgt(signal, "CE", entry_premium=50.0, confluence=2)
    assert tgt == 15.0
    assert sl == 10.0
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
pytest scripts/test_mtf_sniper_rsi_redesign.py -v -k dynamic_sl_tgt
```
Expected: FAIL — `AttributeError: ... no attribute 'mtf_dynamic_sl_tgt'`.

- [ ] **Step 3: Implement `mtf_dynamic_sl_tgt`**

```python
def mtf_dynamic_sl_tgt(signal: dict, action: str, entry_premium: float,
                        confluence: int) -> tuple[float, float]:
    """Verbatim copy of mtf_sniper's branch of trading_bot._dynamic_sl_tgt
    (trading_bot.py:2097-2261). Duplicated, not imported -- _dynamic_sl_tgt
    lives in a module with live side effects unsafe to import from a scratch
    script. Returns (sl_points, target_points) in OPTION PREMIUM points."""
    price = signal["price"]
    atr = signal["atr"]
    atr_pts = atr * 0.30 * 0.35

    is_bullish = action == "CE"
    tgt_level = signal.get("r1") if is_bullish else signal.get("s1")
    if tgt_level:
        tgt = max(abs(tgt_level - price) * 0.30, 15.0)
    else:
        tgt = atr_pts * 2.0
    sl = atr_pts * 1.2

    if confluence >= 5:
        tgt *= 1.15
        sl *= 0.9
    elif confluence >= 3:
        tgt *= 1.05

    prem_cap = 0.20
    tgt = min(tgt, entry_premium * prem_cap)
    tgt = max(tgt, 15.0)

    if sl <= 0 or tgt / sl < 1.5:
        sl = tgt / 1.5
    sl = max(sl, 8.0)

    if tgt / sl < 1.2:
        tgt = round(sl * 1.5, 1)

    return round(sl, 1), round(tgt, 1)
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
pytest scripts/test_mtf_sniper_rsi_redesign.py -v -k dynamic_sl_tgt
```
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/_mtf_sniper_rsi_redesign.py scripts/test_mtf_sniper_rsi_redesign.py
git commit -m "feat: add mtf_sniper exact SL/target formula to replay script"
```

---

### Task 5: `scan_signals_for_n` — the new pullback-depth entry condition

**Files:**
- Modify: `scripts/_mtf_sniper_rsi_redesign.py`
- Test: `scripts/test_mtf_sniper_rsi_redesign.py`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_mtf_sniper_rsi_redesign.py`:

```python
def _tick_state(day, ts, rsi, price=24100.0, ema20=24000.0, ema50=23800.0,
                  trend_score=80.0, supertrend="LONG", macd=1.0, macd_signal=0.5,
                  pcr=1.2, atr=150.0, r1=24200.0, s1=23700.0, index_name="NIFTY"):
    return {"day": day, "ts": ts, "price": price, "ema20": ema20, "ema50": ema50,
            "trend_score": trend_score, "rsi": rsi, "supertrend": supertrend,
            "macd": macd, "macd_signal": macd_signal, "pcr": pcr, "atr": atr,
            "r1": r1, "s1": s1, "index_name": index_name}


def test_scan_signals_for_n_fires_ce_when_pullback_depth_met():
    states = [
        _tick_state("2026-06-01", "2026-06-01T09:20:00", rsi=75.0),  # session_high=75
        _tick_state("2026-06-01", "2026-06-01T09:30:00", rsi=70.0),  # depth=5
    ]
    signals = m.scan_signals_for_n(states, n=5)
    assert len(signals) == 1
    assert signals[0]["action"] == "CE"
    assert signals[0]["n"] == 5


def test_scan_signals_for_n_does_not_fire_when_pullback_depth_not_met():
    states = [
        _tick_state("2026-06-01", "2026-06-01T09:20:00", rsi=75.0),
        _tick_state("2026-06-01", "2026-06-01T09:30:00", rsi=72.0),  # depth=3
    ]
    signals = m.scan_signals_for_n(states, n=5)
    assert signals == []


def test_scan_signals_for_n_blocks_10_to_12_window():
    states = [
        _tick_state("2026-06-01", "2026-06-01T09:20:00", rsi=75.0),
        _tick_state("2026-06-01", "2026-06-01T10:30:00", rsi=70.0),  # inside block
    ]
    signals = m.scan_signals_for_n(states, n=5)
    assert signals == []


def test_scan_signals_for_n_enforces_cooldown():
    states = [
        _tick_state("2026-06-01", "2026-06-01T09:20:00", rsi=80.0),
        _tick_state("2026-06-01", "2026-06-01T09:25:00", rsi=75.0),  # depth=5, fires
        _tick_state("2026-06-01", "2026-06-01T09:35:00", rsi=70.0),  # depth=10, <45min, suppressed
        _tick_state("2026-06-01", "2026-06-01T10:15:01", rsi=65.0),  # >45min later, but in block
        _tick_state("2026-06-01", "2026-06-01T12:30:00", rsi=60.0),  # depth=20, past block, fires
    ]
    signals = m.scan_signals_for_n(states, n=5)
    assert len(signals) == 2
    assert signals[0]["ts"] == "2026-06-01T09:25:00"
    assert signals[1]["ts"] == "2026-06-01T12:30:00"


def test_scan_signals_for_n_resets_session_high_low_at_day_boundary():
    states = [
        _tick_state("2026-06-01", "2026-06-01T14:00:00", rsi=80.0),  # day1 high=80
        _tick_state("2026-06-02", "2026-06-02T09:20:00", rsi=70.0),  # day2 first tick: high resets to 70
    ]
    # if session_high incorrectly carried over from day1 (80), depth=10 >= 5 would wrongly fire
    signals = m.scan_signals_for_n(states, n=5)
    assert signals == []


def test_scan_signals_for_n_gates_on_min_confluence():
    states = [
        _tick_state("2026-06-01", "2026-06-01T09:20:00", rsi=75.0, supertrend="SHORT",
                     macd=0.5, macd_signal=1.0, pcr=0.5),  # nothing agrees w/ CE -> confluence 0
        _tick_state("2026-06-01", "2026-06-01T09:30:00", rsi=70.0, supertrend="SHORT",
                     macd=0.5, macd_signal=1.0, pcr=0.5),
    ]
    signals = m.scan_signals_for_n(states, n=5)
    assert signals == []  # confluence 0 < MIN_CONF(2)
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
pytest scripts/test_mtf_sniper_rsi_redesign.py -v -k scan_signals
```
Expected: FAIL — `AttributeError: ... no attribute 'scan_signals_for_n'`.

- [ ] **Step 3: Implement `scan_signals_for_n`**

```python
def scan_signals_for_n(states: list[dict], n: int) -> list[dict]:
    """Walks one index's precomputed per-tick states (chronological, each
    carrying 'day'/'ts'/'index_name' plus daily_state_asof's fields) and
    applies the redesigned entry condition: session-relative pullback depth
    of >= n RSI points from the day's running high (CE) / low (PE), the
    unchanged macro trend gate (price vs ema50 + trend_score >70/<35), the
    unchanged CE floor (45) / PE ceiling (58), the unchanged 10:00-12:00
    block, the unchanged 45-min cooldown, and the unchanged min_conf=2 gate
    (via the partial confluence score). Returns one dict per fired signal."""
    signals = []
    session_high = session_low = None
    cur_day = None
    last_signal_ts = None

    for state in states:
        day = state["day"]
        if day != cur_day:
            cur_day = day
            session_high = session_low = state["rsi"]
            last_signal_ts = None
        else:
            session_high = max(session_high, state["rsi"])
            session_low = min(session_low, state["rsi"])

        ts = pd.Timestamp(state["ts"])
        if BLOCK_START <= ts.time() < BLOCK_END:
            continue

        rsi = state["rsi"]
        daily_bullish = state["price"] > state["ema50"] and state["trend_score"] > 70
        daily_bearish = state["price"] < state["ema50"] and state["trend_score"] < 35

        action = None
        if daily_bullish and (session_high - rsi) >= n and rsi > FLOOR_CE and state["price"] > state["ema20"]:
            action = "CE"
        elif daily_bearish and (rsi - session_low) >= n and rsi < CEILING_PE and state["price"] < state["ema20"]:
            action = "PE"
        if action is None:
            continue

        if last_signal_ts is not None and (ts - last_signal_ts).total_seconds() < MTF_COOLDOWN_SEC:
            continue

        confluence = mtf_confluence_partial(state, action)
        if confluence < MIN_CONF:
            continue

        last_signal_ts = ts
        signals.append({**state, "action": action, "confluence": confluence, "n": n})

    return signals
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
pytest scripts/test_mtf_sniper_rsi_redesign.py -v -k scan_signals
```
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/_mtf_sniper_rsi_redesign.py scripts/test_mtf_sniper_rsi_redesign.py
git commit -m "feat: add pullback-depth entry condition scan"
```

---

### Task 6: `process_signal` — premium-based exit simulation

**Files:**
- Modify: `scripts/_mtf_sniper_rsi_redesign.py`
- Test: `scripts/test_mtf_sniper_rsi_redesign.py`

Unlike `_trend_sr_pullback_backtest.py`'s `simulate_trade` (spot-based),
mtf_sniper's SL/target are denominated in option PREMIUM points — this
function walks forward through real premium ticks via `tsp.price_premium`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_mtf_sniper_rsi_redesign.py`:

```python
def _make_ticks_db(tmp_path, rows):
    db_path = tmp_path / "ticks.sqlite"
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE options_ticks (
            ts TEXT, index_name TEXT, expiry TEXT, spot REAL, strike REAL,
            ce_ltp REAL, pe_ltp REAL
        )
    """)
    conn.executemany(
        "INSERT INTO options_ticks (ts, index_name, expiry, spot, strike, ce_ltp, pe_ltp) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    conn.row_factory = sqlite3.Row
    return conn


def _signal(day="2026-06-01", ts="2026-06-01T09:30:00", action="CE",
             price=24000.0, atr=150.0, r1=24100.0, s1=23900.0, confluence=2,
             n=5, index_name="NIFTY"):
    return {"day": day, "ts": ts, "action": action, "price": price, "atr": atr,
            "r1": r1, "s1": s1, "confluence": confluence, "n": n, "index_name": index_name}


def test_process_signal_skips_below_min_entry_premium(tmp_path):
    conn = _make_ticks_db(tmp_path, [
        ("2026-06-01T09:30:00", "NIFTY", "2026-06-03", 24000.0, 24000.0, 5.0, 5.0),
    ])
    day_ticks = [pd.Timestamp("2026-06-01T09:30:00")]
    result = m.process_signal(conn, _signal(), day_ticks)
    assert result["skipped"] == "BELOW_MIN_ENTRY_PREMIUM"


def test_process_signal_exits_on_target_hit_and_labels_win(tmp_path):
    conn = _make_ticks_db(tmp_path, [
        ("2026-06-01T09:30:00", "NIFTY", "2026-06-03", 24000.0, 24000.0, 100.0, 90.0),
        ("2026-06-01T09:45:00", "NIFTY", "2026-06-03", 24110.0, 24000.0, 180.0, 40.0),
    ])
    day_ticks = [pd.Timestamp("2026-06-01T09:30:00"), pd.Timestamp("2026-06-01T09:45:00")]
    result = m.process_signal(conn, _signal(), day_ticks)
    assert result["skipped"] is None
    assert result["exit_reason"] == "TARGET"
    assert result["label"] == "WIN"
    assert result["pnl"] > 0


def test_process_signal_exits_on_sl_hit_and_labels_loss(tmp_path):
    conn = _make_ticks_db(tmp_path, [
        ("2026-06-01T09:30:00", "NIFTY", "2026-06-03", 24000.0, 24000.0, 100.0, 90.0),
        ("2026-06-01T09:45:00", "NIFTY", "2026-06-03", 23940.0, 24000.0, 60.0, 130.0),
    ])
    day_ticks = [pd.Timestamp("2026-06-01T09:30:00"), pd.Timestamp("2026-06-01T09:45:00")]
    result = m.process_signal(conn, _signal(), day_ticks)
    assert result["skipped"] is None
    assert result["exit_reason"] == "SL"
    assert result["label"] == "LOSS"
    assert result["pnl"] < 0


def test_process_signal_force_closes_at_eod_when_neither_hit(tmp_path):
    conn = _make_ticks_db(tmp_path, [
        ("2026-06-01T09:30:00", "NIFTY", "2026-06-03", 24000.0, 24000.0, 100.0, 90.0),
        ("2026-06-01T15:19:00", "NIFTY", "2026-06-03", 24020.0, 24000.0, 110.0, 85.0),
    ])
    day_ticks = [pd.Timestamp("2026-06-01T09:30:00"), pd.Timestamp("2026-06-01T15:19:00")]
    result = m.process_signal(conn, _signal(), day_ticks)
    assert result["skipped"] is None
    assert result["exit_reason"] == "EOD"
    assert result["exit_ts"] == pd.Timestamp("2026-06-01T15:19:00")
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
pytest scripts/test_mtf_sniper_rsi_redesign.py -v -k process_signal
```
Expected: FAIL — `AttributeError: ... no attribute 'process_signal'`.

- [ ] **Step 3: Implement `process_signal`**

```python
def process_signal(conn: sqlite3.Connection, signal: dict, day_ticks_ts: list) -> dict:
    """Looks up entry premium/strike via tsp.price_premium (real-tick-first,
    BS-fallback, unmodified), sizes SL/target via mtf_dynamic_sl_tgt, then
    walks forward through day_ticks_ts (every real tick timestamp recorded
    for this index_name on this day) checking premium >= target /
    premium <= SL. Returns a result dict, or {'skipped': <reason>} on a
    data-quality skip."""
    index_name = signal["index_name"]
    action = signal["action"]
    entry_ts = pd.Timestamp(signal["ts"])
    strike = tsp.nearest_strike(signal["price"], index_name)

    entry_premium, entry_source = tsp.price_premium(conn, index_name, strike, action, entry_ts)
    if entry_premium is None:
        return {"skipped": "NO_EXPIRY_DATA", "n": signal["n"]}
    if entry_premium < tsp.MIN_ENTRY_PREMIUM.get(index_name, 50):
        return {"skipped": "BELOW_MIN_ENTRY_PREMIUM", "n": signal["n"]}

    sl_pts, tgt_pts = mtf_dynamic_sl_tgt(signal, action, entry_premium, signal["confluence"])
    target_premium = entry_premium + tgt_pts
    sl_premium = entry_premium - sl_pts
    force_close_ts = pd.Timestamp(f"{entry_ts.strftime('%Y-%m-%d')}T{tsp.FORCE_CLOSE_TIME}")

    forward_ts = sorted(t for t in day_ticks_ts if entry_ts < t <= force_close_ts)
    exit_ts = exit_premium = exit_source = exit_reason = None
    for t in forward_ts:
        premium, source = tsp.price_premium(conn, index_name, strike, action, t)
        if premium is None:
            continue
        if premium >= target_premium:
            exit_ts, exit_premium, exit_source, exit_reason = t, premium, source, "TARGET"
            break
        if premium <= sl_premium:
            exit_ts, exit_premium, exit_source, exit_reason = t, premium, source, "SL"
            break

    if exit_ts is None:
        exit_ts = forward_ts[-1] if forward_ts else entry_ts
        exit_premium, exit_source = tsp.price_premium(conn, index_name, strike, action, exit_ts)
        exit_reason = "EOD"
        if exit_premium is None:
            return {"skipped": "NO_EXPIRY_DATA_AT_EXIT", "n": signal["n"]}

    lot_size = tsp.SHARES_PER_LOT.get(index_name, 65)
    buy_value = entry_premium * lot_size
    sell_value = exit_premium * lot_size
    pnl = round((exit_premium - entry_premium) * lot_size - tsp.txn_charges(buy_value, sell_value), 2)
    label = "WIN" if pnl > 0 else "LOSS"

    return {
        "skipped": None, "n": signal["n"], "day": signal["day"], "index_name": index_name,
        "action": action, "strike": strike, "confluence": signal["confluence"],
        "entry_ts": entry_ts, "entry_premium": entry_premium, "entry_source": entry_source,
        "exit_ts": exit_ts, "exit_premium": exit_premium, "exit_source": exit_source,
        "exit_reason": exit_reason, "sl_pts": sl_pts, "tgt_pts": tgt_pts,
        "pnl": pnl, "label": label,
    }
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
pytest scripts/test_mtf_sniper_rsi_redesign.py -v -k process_signal
```
Expected: 4 passed. (`tsp.MIN_ENTRY_PREMIUM` is confirmed as
`{"NIFTY": 50, "SENSEX": 150, "BANKNIFTY": 50}` at
`_trend_sr_pullback_backtest.py:64` — the `.get(index_name, 50)` call above
is correct as written.)

- [ ] **Step 5: Commit**

```bash
git add scripts/_mtf_sniper_rsi_redesign.py scripts/test_mtf_sniper_rsi_redesign.py
git commit -m "feat: add premium-based exit simulation for mtf_sniper signals"
```

---

### Task 7: `pick_best_n` / `random_split` / `run_fit_confirm` — generalization check

**Files:**
- Modify: `scripts/_mtf_sniper_rsi_redesign.py`
- Test: `scripts/test_mtf_sniper_rsi_redesign.py`

Mirrors `_mtf_sniper_loop_iter1.py`'s fit/confirm methodology, generalized to
choosing among 4 candidate `N` values instead of choosing which time buckets
to exclude.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_mtf_sniper_rsi_redesign.py`:

```python
def _trade(n, pnl):
    return {"n": n, "pnl": pnl}


def test_random_split_produces_two_disjoint_halves_covering_all_trades():
    trades = [_trade(5, i) for i in range(10)]
    fit, confirm = m.random_split(trades, seed=1)
    assert len(fit) == 5 and len(confirm) == 5
    assert sorted(t["pnl"] for t in fit + confirm) == list(range(10))


def test_pick_best_n_returns_none_when_no_candidate_reaches_min_trades():
    trades_by_n = {3: [_trade(3, 100)] * 5, 5: [_trade(5, 50)] * 8}
    assert m.pick_best_n(trades_by_n, min_n=10) is None


def test_pick_best_n_picks_highest_pnl_among_qualifying_candidates():
    trades_by_n = {
        3: [_trade(3, 10)] * 12,            # total pnl 120
        5: [_trade(5, 50)] * 12,            # total pnl 600
        8: [_trade(8, 5)] * 5,              # only 5 trades, excluded
    }
    assert m.pick_best_n(trades_by_n, min_n=10) == 5


def test_run_fit_confirm_reports_consistent_counts():
    all_results = [_trade(3, -10) for _ in range(20)] + [_trade(5, 30) for _ in range(20)]
    result = m.run_fit_confirm(all_results, seeds=10)
    assert result["seeds"] == 10
    assert result["used_seeds"] + result["excluded_seeds"] == 10
    assert result["generalizes_count"] <= result["used_seeds"]
    assert sum(result["chosen_n_counts"].values()) == result["used_seeds"]
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
pytest scripts/test_mtf_sniper_rsi_redesign.py -v -k "random_split or pick_best_n or run_fit_confirm"
```
Expected: FAIL — missing attributes.

- [ ] **Step 3: Implement all three functions**

```python
def random_split(trades: list, seed: int):
    shuffled = list(trades)
    random.Random(seed).shuffle(shuffled)
    mid = len(shuffled) // 2
    return shuffled[:mid], shuffled[mid:]


def pick_best_n(trades_by_n: dict, min_n: int = MIN_FIT_TRADES):
    """Highest fit-half total PnL among candidate Ns with >= min_n trades.
    Returns None if no candidate qualifies -- caller excludes this seed."""
    qualifying = {n: trades for n, trades in trades_by_n.items() if len(trades) >= min_n}
    if not qualifying:
        return None
    return max(qualifying, key=lambda n: sum(t["pnl"] for t in qualifying[n]))


def run_fit_confirm(all_results: list, seeds: int = FIT_CONFIRM_SEEDS) -> dict:
    """For each of `seeds` random 50/50 splits of each candidate N's full
    trade list: pick the best N on the fit half (>=MIN_FIT_TRADES trades,
    highest PnL), apply it to that N's confirm half, and record whether
    confirm-half PnL is positive. Mirrors _mtf_sniper_loop_iter1.py."""
    by_n = {}
    for r in all_results:
        by_n.setdefault(r["n"], []).append(r)

    chosen_n_counts = {}
    generalizes_count = 0
    excluded_seeds = 0
    confirm_pnls = []

    for seed in range(seeds):
        fit_by_n, confirm_by_n = {}, {}
        for n, trades in by_n.items():
            fit, confirm = random_split(trades, seed)
            fit_by_n[n] = fit
            confirm_by_n[n] = confirm

        best_n = pick_best_n(fit_by_n, min_n=MIN_FIT_TRADES)
        if best_n is None:
            excluded_seeds += 1
            continue
        chosen_n_counts[best_n] = chosen_n_counts.get(best_n, 0) + 1

        confirm_pnl = sum(t["pnl"] for t in confirm_by_n[best_n])
        confirm_pnls.append(confirm_pnl)
        if confirm_pnl > 0:
            generalizes_count += 1

    used_seeds = seeds - excluded_seeds
    return {
        "seeds": seeds, "excluded_seeds": excluded_seeds, "used_seeds": used_seeds,
        "chosen_n_counts": chosen_n_counts, "generalizes_count": generalizes_count,
        "avg_confirm_pnl": round(sum(confirm_pnls) / len(confirm_pnls), 2) if confirm_pnls else None,
    }
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
pytest scripts/test_mtf_sniper_rsi_redesign.py -v -k "random_split or pick_best_n or run_fit_confirm"
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/_mtf_sniper_rsi_redesign.py scripts/test_mtf_sniper_rsi_redesign.py
git commit -m "feat: add fit/confirm generalization check across candidate N"
```

---

### Task 8: `build_daily_states` — real-data orchestration (no unit test; exercised via `main`)

**Files:**
- Modify: `scripts/_mtf_sniper_rsi_redesign.py`

This function touches real yfinance history and the real `options_tick.sqlite`
DB — per this repo's established convention (see `_trend_sr_pullback_backtest.py`'s
own `run_backtest_for_index`/`main`), DB/network-orchestration functions are
exercised by running the script end-to-end against real data and reading the
output, not via a unit test with a fixture DB. The function is one pass per
index: computed once, reused across all 4 candidate `N` values in Task 9 (the
underlying `_rsi`/`_ema`/`_macd` recomputation is the expensive part and must
not be repeated per-N).

- [ ] **Step 1: Implement `build_daily_states`**

```python
def build_daily_states(index_name: str, daily_full: pd.DataFrame, weekly_full: pd.DataFrame,
                        ticks_conn: sqlite3.Connection) -> list[dict]:
    """One pass per index: for every real tick recorded that day, reconstructs
    the live-equivalent daily-bar state as-of that exact instant. Assumes
    ticks_conn.row_factory == sqlite3.Row (set by main() before calling)."""
    rows = ticks_conn.execute(
        "SELECT ts, spot, pcr FROM options_ticks WHERE index_name = ? ORDER BY ts",
        (index_name,),
    ).fetchall()
    if not rows:
        return []
    df_all = pd.DataFrame([(r["ts"], r["spot"], r["pcr"]) for r in rows],
                           columns=["ts", "spot", "pcr"])
    df_all["day"] = df_all["ts"].str.slice(0, 10)
    days = sorted(df_all["day"].unique())

    states = []
    for day in days:
        day_rows = list(df_all.loc[df_all["day"] == day, ["ts", "spot", "pcr"]]
                         .itertuples(index=False, name=None))
        asof_cutoff = pd.Timestamp(day) - pd.Timedelta(days=1)
        daily_before = tsp.slice_asof(daily_full, asof_cutoff)
        weekly_before = tsp.slice_asof(weekly_full, asof_cutoff)
        if len(daily_before) < 60 or len(weekly_before) < 2:
            continue
        day_match = daily_full[daily_full["timestamp"].dt.strftime("%Y-%m-%d") == day]
        if day_match.empty:
            continue
        day_open = float(day_match["open"].iloc[0])

        spots_so_far = []
        for ts, spot, pcr in day_rows:
            spots_so_far.append(spot)
            state = daily_state_asof(daily_before, weekly_before, day_open, spots_so_far)
            state["ts"] = ts
            state["day"] = day
            state["index_name"] = index_name
            state["pcr"] = pcr
            states.append(state)
    return states
```

- [ ] **Step 2: Commit**

```bash
git add scripts/_mtf_sniper_rsi_redesign.py
git commit -m "feat: add per-index daily-state orchestration"
```

---

### Task 9: `report` + `main` — wire everything together, run against real data

**Files:**
- Modify: `scripts/_mtf_sniper_rsi_redesign.py`

- [ ] **Step 1: Implement `report` and `main`**

```python
def report(by_n: dict, fit_confirm_result: dict):
    print(f"\n{'=' * 70}")
    print("mtf_sniper RSI redesign -- counterfactual replay")
    print(f"{'=' * 70}")
    for n in sorted(by_n.keys()):
        fired = [r for r in by_n[n] if r.get("skipped") is None]
        skipped = [r for r in by_n[n] if r.get("skipped") is not None]
        wins = [r for r in fired if r["label"] == "WIN"]
        pnl = sum(r["pnl"] for r in fired)
        wr = 100 * len(wins) / len(fired) if fired else 0
        print(f"\n  N={n}: fired={len(fired)} skipped={len(skipped)} "
              f"WR={wr:.1f}% PnL=Rs.{pnl:,.2f}")

    print(f"\n{'-' * 70}")
    print(f"Fit/confirm ({fit_confirm_result['used_seeds']}/{fit_confirm_result['seeds']} seeds "
          f"used, {fit_confirm_result['excluded_seeds']} excluded -- no N reached "
          f">={MIN_FIT_TRADES} fit-half trades):")
    for n, count in sorted(fit_confirm_result["chosen_n_counts"].items()):
        print(f"  N={n} chosen in {count}/{fit_confirm_result['used_seeds']} seeds")
    print(f"  Confirm-half PnL positive in {fit_confirm_result['generalizes_count']}/"
          f"{fit_confirm_result['used_seeds']} seeds")
    print(f"  Avg confirm-half PnL: Rs.{fit_confirm_result['avg_confirm_pnl']:,.2f}")

    print(f"\n{'=' * 70}")
    print("CAVEATS:")
    print("  - Confluence score is partial (max 5/10 reconstructible) -- the live")
    print("    >=5 SL/target bonus tier and MTF confirmation gate are both")
    print("    structurally rare/absent here. See spec's Known Simplification.")
    print("  - Real tick coverage is ~36/46 trading days since 2026-04-15, not")
    print("    a clean continuous window -- gaps are skipped, not interpolated.")
    print("  - Trailing-SL/smart-exit not modeled -- target/SL/EOD only.")
    print("  - Premiums marked BS are Black-Scholes estimates, not real prices.")
    print(f"{'=' * 70}")


def main():
    ticks_conn = sqlite3.connect(tsp.TICKS_DB_PATH)
    ticks_conn.row_factory = sqlite3.Row

    by_n = {n: [] for n in CANDIDATE_N}
    for index_name, ticker in tsp.TICKERS.items():
        print(f"Fetching yfinance history for {index_name} ({ticker})...")
        daily_full, weekly_full = tsp.fetch_yf_history(ticker)
        print(f"  {len(daily_full)} daily bars, {len(weekly_full)} weekly bars")
        states = build_daily_states(index_name, daily_full, weekly_full, ticks_conn)
        print(f"  {len(states)} tick instants reconstructed across "
              f"{len({s['day'] for s in states})} trading days")

        day_ticks_by_day = {}
        for s in states:
            day_ticks_by_day.setdefault(s["day"], []).append(pd.Timestamp(s["ts"]))

        for n in CANDIDATE_N:
            signals = scan_signals_for_n(states, n)
            priced = 0
            for sig in signals:
                result = process_signal(ticks_conn, sig, day_ticks_by_day[sig["day"]])
                by_n[n].append(result)
                if result.get("skipped") is None:
                    priced += 1
            print(f"  N={n}: {len(signals)} candidate signals -> {priced} priced")

    ticks_conn.close()

    all_results = [r for trades in by_n.values() for r in trades]
    fit_confirm_result = run_fit_confirm(all_results, seeds=FIT_CONFIRM_SEEDS)
    report(by_n, fit_confirm_result)


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    main()
```

(`tsp.TICKS_DB_PATH` is confirmed as `ROOT / "db" / "options_tick.sqlite"` at
`_trend_sr_pullback_backtest.py:57`, and `tsp.TICKERS` as
`{"NIFTY": "^NSEI", "SENSEX": "^BSESN"}` at line 402 — `main()`'s references
above are correct as written.)

- [ ] **Step 2: Run the full test suite**

```powershell
cd backend
.venv\Scripts\Activate.ps1
cd ..
pytest scripts/test_mtf_sniper_rsi_redesign.py -v
```
Expected: all tests pass (≈26 tests across Tasks 2–7).

- [ ] **Step 3: Run the script end-to-end against real data**

```powershell
python scripts/_mtf_sniper_rsi_redesign.py
```
Expected: prints per-index fetch/reconstruction counts, per-N fired/skipped/WR/PnL,
the fit/confirm summary, and the CAVEATS block. No exceptions. Read the output —
this is the actual deliverable of this plan (the evidence for picking a
winning `N`, or for concluding none generalizes).

- [ ] **Step 4: Commit**

```bash
git add scripts/_mtf_sniper_rsi_redesign.py
git commit -m "feat: wire up mtf_sniper RSI redesign replay report and main"
```

---

## After Running: Decision Point (not part of this plan's scope)

Read the printed report. Per the spec, the next step is a human decision —
not automated — about whether any candidate `N` generalizes well enough
(confirm-half PnL positive in a strong majority of seeds, similar to how the
10:00-12:00 block's 27/30 and 20/30 splits were judged) to justify a
`trading_bot.py` change. That change, if any, is a separate, future plan.

---

## Self-Review Notes

- **Spec coverage:** Data sources (daily+weekly OHLC, options_ticks spot/premium/pcr) →
  Task 8; live-equivalent RSI reconstruction → Task 2; new entry condition →
  Task 5; unchanged macro gate/floor/ceiling/block/cooldown/min_conf → Task 5;
  exact SL/target formula → Task 4; premium-based exit walk → Task 6;
  candidate N sweep + fit/confirm → Tasks 7–9; confluence partial-reconstruction
  caveat → Task 3 + printed in Task 9's report.
- **Placeholder scan:** no TBD/TODO; every step has complete code.
- **Type consistency:** `state`/`signal` dict shapes are consistent from
  Task 2 (`daily_state_asof` output) through Task 8 (`build_daily_states`
  adds `ts`/`day`/`index_name`/`pcr`) through Task 5 (`scan_signals_for_n`
  adds `action`/`confluence`/`n`) through Task 6 (`process_signal` reads
  `signal["price"]`/`["atr"]`/`["r1"]`/`["s1"]`/`["confluence"]`/`["n"]`/
  `["day"]`/`["index_name"]`/`["action"]`/`["ts"]` — all present at each stage).
- **External names re-verified against source at plan-writing time:**
  `tsp.MIN_ENTRY_PREMIUM` (`_trend_sr_pullback_backtest.py:64`),
  `tsp.TICKS_DB_PATH` (line 57), `tsp.TICKERS` (line 402) — all confirmed via
  a fresh grep, not assumed from memory.
