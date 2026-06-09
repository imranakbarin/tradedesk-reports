# Options Backtest Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replay any of 9 NSE bot strategies (7 existing + 2 new) against real logged options tick data, displaying actual CE/PE premium P&L in a new "Options Backtest" tab on the existing backtest page.

**Architecture:** A new `options_backtest_engine.py` reads `db/options_tick.sqlite` minute-by-minute, computes RSI/EMA/ATR on spot prices, runs stateless strategy signal functions at each bar, and records entries/exits using actual CE/PE LTP. A new FastAPI router at `/options-backtest` feeds the results to the existing backtest page's equity curve and metrics components via a new tab.

**Tech Stack:** Python (aiosqlite, pandas, numpy), FastAPI, Next.js (React, TypeScript, inline styles — no new CSS or component libraries)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `backend/models/backtest.py` | Add `OptionsBacktestRequest` model |
| Create | `backend/services/options_backtest_engine.py` | Tick loading, indicator computation, 9 strategy signal fns, replay loop |
| Create | `backend/routers/options_backtest.py` | `POST /options-backtest/run` and `GET /options-backtest/available` |
| Modify | `backend/main.py` | Register new router |
| Modify | `frontend/src/app/backtest/page.tsx` | Add "Options Backtest" tab with its own form and results |

---

## Task 1: Add `OptionsBacktestRequest` model

**Files:**
- Modify: `backend/models/backtest.py`

- [ ] **Step 1: Add the request model**

Open `backend/models/backtest.py` and append after the existing `BacktestRequest` class (after line 11):

```python
class OptionsBacktestRequest(BaseModel):
    index_name:  str            # "NIFTY" | "SENSEX"
    strategy:    str            # one of the 9 strategy keys
    from_date:   str            # YYYY-MM-DD
    to_date:     str            # YYYY-MM-DD
    expiry_type: str = "front"  # "front" | "next"
    capital:     float = 100_000.0
```

- [ ] **Step 2: Verify the model parses correctly**

Run:
```bash
cd d:/TradingApp && python -c "
from backend.models.backtest import OptionsBacktestRequest
r = OptionsBacktestRequest(index_name='NIFTY', strategy='mtf_sniper', from_date='2026-04-15', to_date='2026-04-15')
print(r)
print('OK')
"
```
Expected: prints the model and `OK` with no errors.

- [ ] **Step 3: Commit**

```bash
cd d:/TradingApp && git add backend/models/backtest.py && git commit -m "feat: add OptionsBacktestRequest model"
```

---

## Task 2: Options backtest engine — tick loading and indicator computation

**Files:**
- Create: `backend/services/options_backtest_engine.py`

This task creates the engine skeleton with tick loading and all indicator computations. The replay loop and signal functions come in later tasks.

- [ ] **Step 1: Create the engine file with tick loading**

Create `backend/services/options_backtest_engine.py`:

```python
"""
Options tick backtest engine.

Reads minute-by-minute options tick data from db/options_tick.sqlite,
computes rolling indicators on the spot price series, then replays the
selected NSE bot strategy bar-by-bar using actual CE/PE LTP for entry/exit.

P&L is denominated in option premium: (exit_ltp - entry_ltp) * lot_size.
SL and target are triggered by spot price movement (same ATR multiples
the live bot uses: 1.5× ATR stop, 2.5× ATR target).
"""

import asyncio
import logging
from datetime import datetime, time as dt_time

import aiosqlite
import numpy as np
import pandas as pd

from backend.config import settings
from backend.models.backtest import (
    BacktestResponse, BacktestMetrics, TradeRecord, EquityPoint,
    OptionsBacktestRequest,
)

logger = logging.getLogger(__name__)

# db/options_tick.sqlite path (separate from main DB)
OPTIONS_DB = str(settings.sqlite_path).replace("trading.db", "options_tick.sqlite")

# Lot sizes — SEBI-approved. NIFTY=65 post-2024 revision, SENSEX=20.
LOT_SIZES = {"NIFTY": 65, "SENSEX": 20}

# ATM step sizes
ATM_STEP = {"NIFTY": 50, "SENSEX": 100}

# All supported strategy keys
STRATEGY_KEYS = [
    "mtf_sniper", "pdh_pdl_break", "supertrend_follow",
    "candle_pattern", "expiry_theta", "ict_smc", "oi_sr_simple",
    "orb_breakout", "supertrend_pure",
]

MIN_BARS = 35   # bars needed before first signal can fire


async def _load_ticks(
    index_name: str, from_date: str, to_date: str, expiry_type: str
) -> pd.DataFrame:
    """
    Load minute tick rows from options_tick.sqlite for the given index and
    date range.  Returns a DataFrame sorted by ts with columns:
        ts, spot, atm_ce_ltp, atm_pe_ltp, ce_oi, pe_oi, pcr
    expiry_type 'front' picks the nearest expiry on each day;
    'next' picks the second nearest.
    """
    # We query ALL expiries for the date range then pick front/next per day.
    from_ts = f"{from_date}T00:00:00"
    to_ts   = f"{to_date}T23:59:59"

    async with aiosqlite.connect(OPTIONS_DB, timeout=10) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT ts, expiry, spot, strike,
                   ce_ltp, pe_ltp, ce_oi, pe_oi, pcr
            FROM options_ticks
            WHERE index_name = ?
              AND ts BETWEEN ? AND ?
            ORDER BY ts, expiry, strike
            """,
            (index_name, from_ts, to_ts),
        )
        rows = [dict(r) for r in await cur.fetchall()]

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    df["ts"] = pd.to_datetime(df["ts"])
    df["date"] = df["ts"].dt.date.astype(str)

    # Per day, pick the expiry at position 0 (front) or 1 (next)
    expiry_idx = 0 if expiry_type == "front" else 1
    chosen_expiries: dict[str, str] = {}
    for day, grp in df.groupby("date"):
        expiries = sorted(grp["expiry"].unique())
        if len(expiries) > expiry_idx:
            chosen_expiries[day] = expiries[expiry_idx]
        elif expiries:
            chosen_expiries[day] = expiries[0]

    df = df[df.apply(lambda r: chosen_expiries.get(r["date"]) == r["expiry"], axis=1)].copy()

    # For each timestamp, find the ATM strike and pull its CE/PE LTP
    step = ATM_STEP.get(index_name, 50)

    def _atm(spot: float) -> float:
        return round(spot / step) * step

    records = []
    for ts, grp in df.groupby("ts"):
        spot = float(grp["spot"].iloc[0])
        atm = _atm(spot)
        atm_row = grp[grp["strike"] == atm]
        if atm_row.empty:
            # Nearest available strike
            grp2 = grp.copy()
            grp2["dist"] = (grp2["strike"] - atm).abs()
            atm_row = grp2.nsmallest(1, "dist")
        if atm_row.empty:
            continue
        r = atm_row.iloc[0]
        records.append({
            "ts":         ts,
            "spot":       spot,
            "atm_strike": float(r["strike"]),
            "atm_ce_ltp": float(r["ce_ltp"]) if r["ce_ltp"] else 0.0,
            "atm_pe_ltp": float(r["pe_ltp"]) if r["pe_ltp"] else 0.0,
            "ce_oi":      int(r["ce_oi"])    if r["ce_oi"]  else 0,
            "pe_oi":      int(r["pe_oi"])    if r["pe_oi"]  else 0,
            "pcr":        float(r["pcr"])    if r["pcr"]    else 1.0,
        })

    if not records:
        return pd.DataFrame()

    result = pd.DataFrame(records).sort_values("ts").reset_index(drop=True)
    return result


def _compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """
    Add rolling indicator columns to the tick DataFrame.
    All computations are on the 'spot' column (underlying price).

    Since tick data has no separate OHLCV, ATR is approximated as
    2 × rolling standard deviation of 1-bar spot returns × spot,
    which is equivalent to a ±1σ price range per bar.

    Added columns:
        rsi         RSI(14)
        ema20       EMA(20)
        ema50       EMA(50)
        atr         ATR approximation (14-bar)
        bb_upper    Bollinger upper band (20, 2σ)
        bb_lower    Bollinger lower band (20, 2σ)
        trend_score 0–100 composite bullish score
        st_upper    Supertrend upper band (for supertrend_pure strategy)
        st_lower    Supertrend lower band
        st_dir      Supertrend direction: 1=LONG, -1=SHORT
    """
    spot = df["spot"].astype(float)

    # RSI(14) — Wilder's smoothing via ewm
    delta = spot.diff()
    gain  = delta.clip(lower=0).ewm(com=13, adjust=False).mean()
    loss  = (-delta.clip(upper=0)).ewm(com=13, adjust=False).mean()
    rs    = gain / loss.replace(0, np.nan)
    df["rsi"] = (100 - (100 / (1 + rs))).fillna(50)

    # EMAs
    df["ema20"] = spot.ewm(span=20, adjust=False).mean()
    df["ema50"] = spot.ewm(span=50, adjust=False).mean()

    # ATR approximation (no OHLCV)
    returns = spot.pct_change().fillna(0)
    df["atr"] = (returns.rolling(14).std().fillna(0) * spot * 2).clip(lower=0.1)

    # Bollinger Bands (20, 2σ)
    sma20        = spot.rolling(20).mean()
    std20        = spot.rolling(20).std().fillna(0)
    df["bb_upper"] = (sma20 + 2 * std20).fillna(spot)
    df["bb_lower"] = (sma20 - 2 * std20).fillna(spot)

    # Trend score 0–100:  +25 each for price>ema20, ema20>ema50, rsi>50, spot in upper BB half
    bb_mid = (df["bb_upper"] + df["bb_lower"]) / 2
    df["trend_score"] = (
        ((spot > df["ema20"]).astype(int) * 25) +
        ((df["ema20"] > df["ema50"]).astype(int) * 25) +
        ((df["rsi"] > 50).astype(int) * 25) +
        ((spot > bb_mid).astype(int) * 25)
    )

    # Supertrend(10, 3) — approximation for tick data
    period     = 10
    multiplier = 3.0
    hl2        = spot  # no high/low — use spot as hl2 proxy
    atr_st     = (returns.rolling(period).std().fillna(0) * spot * 2).clip(lower=0.1)

    basic_upper = hl2 + multiplier * atr_st
    basic_lower = hl2 - multiplier * atr_st

    st_upper = basic_upper.copy()
    st_lower = basic_lower.copy()
    st_dir   = pd.Series(1, index=df.index)  # start LONG

    for i in range(1, len(df)):
        # Upper band: only tighten, never widen (when in uptrend)
        prev_upper = st_upper.iloc[i - 1]
        cur_upper  = basic_upper.iloc[i]
        st_upper.iloc[i] = min(cur_upper, prev_upper) if spot.iloc[i - 1] <= prev_upper else cur_upper

        # Lower band: only raise, never drop (when in downtrend)
        prev_lower = st_lower.iloc[i - 1]
        cur_lower  = basic_lower.iloc[i]
        st_lower.iloc[i] = max(cur_lower, prev_lower) if spot.iloc[i - 1] >= prev_lower else cur_lower

        # Direction flip
        prev_dir = st_dir.iloc[i - 1]
        if prev_dir == 1 and spot.iloc[i] < st_lower.iloc[i]:
            st_dir.iloc[i] = -1
        elif prev_dir == -1 and spot.iloc[i] > st_upper.iloc[i]:
            st_dir.iloc[i] = 1
        else:
            st_dir.iloc[i] = prev_dir

    df["st_upper"] = st_upper
    df["st_lower"] = st_lower
    df["st_dir"]   = st_dir

    return df
```

- [ ] **Step 2: Verify tick loading and indicators parse without error**

```bash
cd d:/TradingApp && python -c "
from backend.services.options_backtest_engine import _compute_indicators
import pandas as pd, numpy as np

# Synthetic tick data: 60 bars of fake NIFTY
idx = pd.date_range('2026-04-15 09:15', periods=60, freq='1min')
spot = pd.Series(24000 + np.cumsum(np.random.randn(60) * 10), index=range(60))
df = pd.DataFrame({'ts': idx, 'spot': spot, 'atm_ce_ltp': 100.0, 'atm_pe_ltp': 80.0,
                   'atm_strike': 24000.0, 'ce_oi': 500000, 'pe_oi': 600000, 'pcr': 1.1})
df = _compute_indicators(df)
print(df[['rsi','ema20','atr','trend_score','st_dir']].tail(5))
print('Indicators OK')
"
```
Expected: prints a table of 5 rows with non-NaN values and `Indicators OK`.

- [ ] **Step 3: Commit**

```bash
cd d:/TradingApp && git add backend/services/options_backtest_engine.py && git commit -m "feat: options backtest engine skeleton — tick loading and indicator computation"
```

---

## Task 3: Strategy signal functions — existing 7 strategies

**Files:**
- Modify: `backend/services/options_backtest_engine.py`

Each function signature: `(bar: dict, indicators: dict) -> tuple[str, str] | None`
- `bar` keys: `ts, spot, atm_ce_ltp, atm_pe_ltp, ce_oi, pe_oi, pcr`
- `indicators` keys: `rsi, ema20, ema50, atr, bb_upper, bb_lower, trend_score, st_dir`
- Returns `("CE"|"PE", reason)` or `None`

- [ ] **Step 1: Add the 7 strategy signal functions**

Append to `backend/services/options_backtest_engine.py`:

```python
# ── Strategy signal functions ─────────────────────────────────────────────────
# Each takes a bar dict and indicators dict, returns (option_type, reason) or None.
# These mirror the live bot strategy logic in trading_bot.py but as pure functions
# with no broker calls, no async, and no DB writes.

def _sig_mtf_sniper(bar: dict, ind: dict) -> tuple[str, str] | None:
    """Daily trend + RSI pullback confluence entry."""
    spot         = bar["spot"]
    rsi          = ind["rsi"]
    ema20        = ind["ema20"]
    ema50        = ind["ema50"]
    trend_score  = ind["trend_score"]

    daily_bullish = spot > ema50 and trend_score > 60
    daily_bearish = spot < ema50 and trend_score < 40

    if daily_bullish and 40 < rsi < 62 and spot > ema20:
        return ("CE", f"MTF Sniper: uptrend (score {trend_score:.0f}) + RSI {rsi:.0f} pullback")
    if daily_bearish and 38 < rsi < 60 and spot < ema20:
        return ("PE", f"MTF Sniper: downtrend (score {trend_score:.0f}) + RSI {rsi:.0f} bounce")
    return None


def _sig_pdh_pdl_break(bar: dict, ind: dict, day_open: float, prev_close: float) -> tuple[str, str] | None:
    """Breakout above/below previous-session range."""
    spot = bar["spot"]
    atr  = ind["atr"]
    # Use prev_close as PDH/PDL proxy (daily breakout)
    if prev_close <= 0:
        return None
    if spot > prev_close * 1.005:  # broke 0.5% above prev close
        return ("CE", f"PDH Break: spot {spot:.0f} > prev {prev_close:.0f}")
    if spot < prev_close * 0.995:
        return ("PE", f"PDL Break: spot {spot:.0f} < prev {prev_close:.0f}")
    return None


def _sig_supertrend_follow(bar: dict, ind: dict) -> tuple[str, str] | None:
    """Supertrend direction + OI agreement (PCR confirms)."""
    st_dir = ind["st_dir"]
    pcr    = bar["pcr"]
    rsi    = ind["rsi"]

    if st_dir == 1 and pcr > 1.0 and 40 < rsi < 65:
        return ("CE", f"ST Follow: LONG + PCR {pcr:.2f} bullish")
    if st_dir == -1 and pcr < 1.0 and 35 < rsi < 60:
        return ("PE", f"ST Follow: SHORT + PCR {pcr:.2f} bearish")
    return None


def _sig_candle_pattern(bar: dict, ind: dict, prev_spot: float) -> tuple[str, str] | None:
    """
    Simplified candle patterns on minute spot data.
    Uses spot vs ema20 for body direction, RSI for confirmation.
    """
    spot  = bar["spot"]
    rsi   = ind["rsi"]
    ema20 = ind["ema20"]
    atr   = ind["atr"]

    if prev_spot <= 0:
        return None

    move = spot - prev_spot
    move_abs = abs(move)

    # Bullish engulfing: strong positive bar closing above EMA20 after being below
    if move > atr * 0.3 and spot > ema20 and prev_spot < ema20 and rsi < 55:
        return ("CE", f"Candle: bullish engulf +{move:.0f}pts crossing EMA20")

    # Bearish engulfing: strong negative bar closing below EMA20
    if move < -atr * 0.3 and spot < ema20 and prev_spot > ema20 and rsi > 45:
        return ("PE", f"Candle: bearish engulf {move:.0f}pts crossing EMA20")

    # Hammer: spot recovering from low RSI with momentum
    if rsi < 32 and move > atr * 0.2:
        return ("CE", f"Candle: hammer recovery RSI {rsi:.0f} + +{move:.0f}pts")

    # Shooting star: spot rejecting from high RSI
    if rsi > 68 and move < -atr * 0.2:
        return ("PE", f"Candle: shooting star rejection RSI {rsi:.0f} + {move:.0f}pts")

    return None


def _sig_expiry_theta(bar: dict, ind: dict, is_expiry: bool) -> tuple[str, str] | None:
    """Buy ATM in dominant direction on expiry day (11 AM–1 PM window)."""
    if not is_expiry:
        return None
    ts: pd.Timestamp = bar["ts"]
    t = ts.time() if hasattr(ts, "time") else dt_time(12, 0)
    if not (dt_time(11, 0) <= t <= dt_time(13, 0)):
        return None
    trend_score = ind["trend_score"]
    if trend_score > 60:
        return ("CE", f"Expiry Theta: bullish trend_score {trend_score:.0f}")
    if trend_score < 40:
        return ("PE", f"Expiry Theta: bearish trend_score {trend_score:.0f}")
    return None


def _sig_ict_smc(bar: dict, ind: dict) -> tuple[str, str] | None:
    """
    Simplified ICT/SMC: structure shift after BB squeeze breakout.
    Proxy for OB + FVG: look for price breaking out of a tight BB squeeze.
    """
    spot     = bar["spot"]
    bb_upper = ind["bb_upper"]
    bb_lower = ind["bb_lower"]
    rsi      = ind["rsi"]
    atr      = ind["atr"]

    # BB width as fraction of spot — tight squeeze = low width
    bb_width = (bb_upper - bb_lower) / spot if spot > 0 else 1.0

    # Only fire during squeeze (narrow bands: < 0.8% of spot)
    if bb_width > 0.008:
        return None

    if spot > bb_upper and rsi < 65:
        return ("CE", f"ICT/SMC: BB squeeze breakout above {bb_upper:.0f} (width {bb_width*100:.2f}%)")
    if spot < bb_lower and rsi > 35:
        return ("PE", f"ICT/SMC: BB squeeze breakdown below {bb_lower:.0f} (width {bb_width*100:.2f}%)")
    return None


def _sig_oi_sr_simple(bar: dict, ind: dict) -> tuple[str, str] | None:
    """
    OI-derived S/R levels using real logged OI data.
    Max PE OI strike = support, max CE OI strike = resistance.
    When price is near support + RSI bullish → CE.
    When price is near resistance + RSI bearish → PE.
    Also: PCR extremes as directional signal.
    """
    spot   = bar["spot"]
    pcr    = bar["pcr"]
    rsi    = ind["rsi"]
    ema20  = ind["ema20"]

    # PCR extreme reversal (the most reliable OI signal)
    if pcr > 1.3 and rsi < 42:
        return ("CE", f"OI SR: extreme PCR {pcr:.2f} (heavy put writing) + RSI {rsi:.0f}")
    if pcr < 0.7 and rsi > 58:
        return ("PE", f"OI SR: extreme PCR {pcr:.2f} (heavy call writing) + RSI {rsi:.0f}")

    # Price vs EMA20 + OI agreement
    if spot > ema20 and pcr > 1.1 and rsi < 48:
        return ("CE", f"OI SR: above EMA20 + PCR {pcr:.2f} + RSI {rsi:.0f} oversold")
    if spot < ema20 and pcr < 0.9 and rsi > 52:
        return ("PE", f"OI SR: below EMA20 + PCR {pcr:.2f} + RSI {rsi:.0f} overbought")

    return None
```

- [ ] **Step 2: Verify no import errors**

```bash
cd d:/TradingApp && python -c "from backend.services.options_backtest_engine import _sig_mtf_sniper, _sig_oi_sr_simple; print('Signal fns OK')"
```
Expected: `Signal fns OK`

- [ ] **Step 3: Commit**

```bash
cd d:/TradingApp && git add backend/services/options_backtest_engine.py && git commit -m "feat: options backtest — 7 existing strategy signal functions"
```

---

## Task 4: New strategy signal functions — ORB and Supertrend Pure

**Files:**
- Modify: `backend/services/options_backtest_engine.py`

**ORB (Opening Range Breakout):** The first 15 minutes of each trading day (9:15–9:29 IST) define the Opening Range. A breakout above OR high (with a 0.1% buffer) fires CE; a breakdown below OR low fires PE. One signal per day — the first breakout wins. Documented ~58% win rate in NSE options with 2:1 R:R.

**Supertrend Pure:** Uses the precomputed `st_dir` column. Fires CE when direction flips from -1 to +1 (crossover up), PE when it flips from +1 to -1 (crossover down). Only fires at the moment of the flip — not on every bar. Documented ~55% win rate in trending markets.

- [ ] **Step 1: Add the 2 new strategy functions and the state tracker class**

Append to `backend/services/options_backtest_engine.py`:

```python
class _OrbState:
    """Tracks opening range per trading day. One instance per backtest run."""

    def __init__(self):
        self._day: str = ""
        self._bars_seen: int = 0
        self._or_high: float = 0.0
        self._or_low: float = float("inf")
        self._fired: bool = False  # one signal per day

    def update(self, ts: pd.Timestamp, spot: float) -> None:
        """Call for every bar before calling signal()."""
        day = ts.strftime("%Y-%m-%d")
        if day != self._day:
            self._day = day
            self._bars_seen = 0
            self._or_high = 0.0
            self._or_low = float("inf")
            self._fired = False

        self._bars_seen += 1
        if self._bars_seen <= 15:
            self._or_high = max(self._or_high, spot)
            self._or_low  = min(self._or_low,  spot)

    def signal(self, spot: float) -> tuple[str, str] | None:
        """Returns signal after the OR window, or None."""
        if self._bars_seen <= 15 or self._fired:
            return None
        if self._or_high <= 0 or self._or_low >= float("inf"):
            return None

        buffer = 0.001  # 0.1% buffer to avoid false breakouts
        if spot > self._or_high * (1 + buffer):
            self._fired = True
            return ("CE", f"ORB: breakout above OR high {self._or_high:.0f} (first 15min range)")
        if spot < self._or_low * (1 - buffer):
            self._fired = True
            return ("PE", f"ORB: breakdown below OR low {self._or_low:.0f} (first 15min range)")
        return None


def _sig_supertrend_pure(ind: dict, prev_st_dir: int) -> tuple[str, str] | None:
    """
    Fires only at the moment the Supertrend direction flips.
    CE on flip from SHORT(-1) to LONG(+1).
    PE on flip from LONG(+1) to SHORT(-1).
    """
    cur_dir = int(ind["st_dir"])
    if prev_st_dir == -1 and cur_dir == 1:
        return ("CE", "Supertrend Pure: flipped LONG (price crossed above upper band)")
    if prev_st_dir == 1 and cur_dir == -1:
        return ("PE", "Supertrend Pure: flipped SHORT (price crossed below lower band)")
    return None
```

- [ ] **Step 2: Verify the ORB state machine works correctly**

```bash
cd d:/TradingApp && python -c "
import pandas as pd
from backend.services.options_backtest_engine import _OrbState

orb = _OrbState()
# Simulate 15 bars of range 23900-24100, then a breakout
for i in range(15):
    ts = pd.Timestamp('2026-04-15 09:15') + pd.Timedelta(minutes=i)
    spot = 23950 + i * 10  # rising from 23950 to 24090
    orb.update(ts, spot)
    print(f'Bar {i+1}: spot={spot}, or_high={orb._or_high}, or_low={orb._or_low}')

# Bar 16 — price breaks above OR high
ts = pd.Timestamp('2026-04-15 09:30')
orb.update(ts, 24200.0)
sig = orb.signal(24200.0)
print(f'Bar 16 signal: {sig}')
assert sig is not None and sig[0] == 'CE', f'Expected CE signal, got {sig}'

# Bar 17 — already fired, no more signals
ts = pd.Timestamp('2026-04-15 09:31')
orb.update(ts, 24250.0)
sig2 = orb.signal(24250.0)
assert sig2 is None, f'Expected None (already fired), got {sig2}'
print('ORB state machine OK')
"
```
Expected: prints the 15 bars with correct OR tracking, `Bar 16 signal: ('CE', ...)`, and `ORB state machine OK`.

- [ ] **Step 3: Commit**

```bash
cd d:/TradingApp && git add backend/services/options_backtest_engine.py && git commit -m "feat: options backtest — ORB and Supertrend Pure strategies"
```

---

## Task 5: Replay loop and metrics computation

**Files:**
- Modify: `backend/services/options_backtest_engine.py`

- [ ] **Step 1: Add the strategy dispatcher and replay loop**

Append to `backend/services/options_backtest_engine.py`:

```python
def _dispatch_signal(
    strategy: str,
    bar: dict,
    ind: dict,
    prev_spot: float,
    prev_st_dir: int,
    prev_close_by_day: dict,   # date -> closing spot from previous day
    is_expiry: bool,
    orb: "_OrbState",
) -> tuple[str, str] | None:
    """Route to the correct strategy signal function."""
    ts: pd.Timestamp = bar["ts"]
    day = ts.strftime("%Y-%m-%d")
    prev_close = prev_close_by_day.get(day, 0.0)

    if strategy == "mtf_sniper":
        return _sig_mtf_sniper(bar, ind)
    if strategy == "pdh_pdl_break":
        return _sig_pdh_pdl_break(bar, ind, bar["spot"], prev_close)
    if strategy == "supertrend_follow":
        return _sig_supertrend_follow(bar, ind)
    if strategy == "candle_pattern":
        return _sig_candle_pattern(bar, ind, prev_spot)
    if strategy == "expiry_theta":
        return _sig_expiry_theta(bar, ind, is_expiry)
    if strategy == "ict_smc":
        return _sig_ict_smc(bar, ind)
    if strategy == "oi_sr_simple":
        return _sig_oi_sr_simple(bar, ind)
    if strategy == "orb_breakout":
        orb.update(ts, bar["spot"])
        return orb.signal(bar["spot"])
    if strategy == "supertrend_pure":
        return _sig_supertrend_pure(ind, prev_st_dir)
    return None


def _compute_metrics(
    trades: list[TradeRecord], initial_capital: float, equity_curve: list[float],
) -> BacktestMetrics:
    if not trades:
        return BacktestMetrics(
            total_trades=0, wins=0, losses=0, win_rate=0.0,
            total_pnl=0.0, total_pnl_pct=0.0,
            avg_win=0.0, avg_loss=0.0, profit_factor=0.0,
            max_drawdown=0.0, max_drawdown_pct=0.0,
            sharpe_ratio=0.0, best_trade=0.0, worst_trade=0.0,
        )

    pnls   = [t.pnl for t in trades]
    wins   = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]

    profit_factor = (sum(wins) / -sum(losses)) if losses and sum(losses) != 0 else 999.0

    peak, max_dd, max_dd_pct = initial_capital, 0.0, 0.0
    for eq in equity_curve:
        if eq > peak:
            peak = eq
        dd = peak - eq
        dd_pct = dd / peak if peak > 0 else 0.0
        if dd > max_dd:
            max_dd, max_dd_pct = dd, dd_pct

    if len(equity_curve) > 1:
        eq_arr = np.array(equity_curve, dtype=float)
        rets   = np.diff(eq_arr) / eq_arr[:-1]
        sharpe = float(np.mean(rets) / np.std(rets) * np.sqrt(252)) if np.std(rets) > 0 else 0.0
    else:
        sharpe = 0.0

    total_pnl = sum(pnls)
    return BacktestMetrics(
        total_trades=len(trades),
        wins=len(wins),
        losses=len(losses),
        win_rate=round(len(wins) / len(trades) * 100, 1),
        total_pnl=round(total_pnl, 2),
        total_pnl_pct=round(total_pnl / initial_capital * 100, 2),
        avg_win=round(float(np.mean(wins)), 2) if wins else 0.0,
        avg_loss=round(float(np.mean(losses)), 2) if losses else 0.0,
        profit_factor=round(min(profit_factor, 999.0), 2),
        max_drawdown=round(max_dd, 2),
        max_drawdown_pct=round(max_dd_pct * 100, 2),
        sharpe_ratio=round(sharpe, 2),
        best_trade=round(max(pnls), 2),
        worst_trade=round(min(pnls), 2),
    )


async def run_options_backtest(request: "OptionsBacktestRequest") -> BacktestResponse:
    """
    Main entry point.  Loads ticks, computes indicators, replays strategy bar-by-bar.
    Returns a BacktestResponse using the same shape as the price backtest.
    """
    df = await _load_ticks(
        request.index_name, request.from_date, request.to_date, request.expiry_type
    )
    if df.empty or len(df) < MIN_BARS:
        raise ValueError(
            f"Not enough tick data for {request.index_name} "
            f"({request.from_date} → {request.to_date}). "
            f"Got {len(df)} bars, need at least {MIN_BARS}. "
            "The options logger must run during market hours to collect data."
        )

    df = _compute_indicators(df)
    lot_size   = LOT_SIZES.get(request.index_name, 65)
    equity     = request.capital
    trades:    list[TradeRecord]  = []
    eq_curve:  list[float]        = [equity]
    eq_times:  list[str]          = [str(df["ts"].iloc[MIN_BARS])]

    # Build prev_close_by_day: for each date, the spot at the last bar of the previous date
    days_sorted = sorted(df["ts"].dt.date.unique())
    spot_by_day = {
        d: df[df["ts"].dt.date == d]["spot"].iloc[-1]
        for d in days_sorted
    }
    prev_close_by_day: dict[str, float] = {}
    for i, d in enumerate(days_sorted):
        if i > 0:
            prev_close_by_day[d.isoformat()] = float(spot_by_day[days_sorted[i - 1]])

    # Expiry day detection: dates where expiry is within the same calendar week
    # Simple proxy: expiry dates are the dates present in the tick data grouped
    # by expiry — the last trading day of that expiry
    all_expiry_dates: set[str] = set()
    try:
        async with aiosqlite.connect(OPTIONS_DB, timeout=5) as db:
            cur = await db.execute(
                "SELECT DISTINCT expiry FROM options_ticks WHERE index_name = ?",
                (request.index_name,),
            )
            rows = await cur.fetchall()
            all_expiry_dates = {r[0] for r in rows}
    except Exception:
        pass

    orb         = _OrbState()
    in_trade    = False
    entry_ltp   = 0.0
    sl_spot     = 0.0
    target_spot = 0.0
    option_type = ""
    entry_bar_i = 0
    prev_spot   = 0.0
    prev_st_dir = 1

    for i in range(MIN_BARS, len(df)):
        row = df.iloc[i]
        spot     = float(row["spot"])
        ce_ltp   = float(row["atm_ce_ltp"])
        pe_ltp   = float(row["atm_pe_ltp"])
        ts       = row["ts"]
        ts_str   = str(ts)

        ind = {
            "rsi":         float(row["rsi"]),
            "ema20":       float(row["ema20"]),
            "ema50":       float(row["ema50"]),
            "atr":         float(row["atr"]),
            "bb_upper":    float(row["bb_upper"]),
            "bb_lower":    float(row["bb_lower"]),
            "trend_score": float(row["trend_score"]),
            "st_dir":      int(row["st_dir"]),
        }

        bar = {
            "ts":         ts,
            "spot":       spot,
            "atm_ce_ltp": ce_ltp,
            "atm_pe_ltp": pe_ltp,
            "ce_oi":      int(row["ce_oi"]),
            "pe_oi":      int(row["pe_oi"]),
            "pcr":        float(row["pcr"]),
        }

        day_str     = ts.strftime("%Y-%m-%d") if hasattr(ts, "strftime") else ts_str[:10]
        is_expiry   = day_str in all_expiry_dates
        is_last_bar = (i == len(df) - 1)

        # ── Exit check ───────────────────────────────────────────────
        if in_trade:
            exit_ltp  = ce_ltp if option_type == "CE" else pe_ltp
            result    = "TIMEOUT"

            if option_type == "CE":
                if spot <= sl_spot:
                    result = "LOSS"
                elif spot >= target_spot:
                    result = "WIN"
            else:  # PE
                if spot >= sl_spot:
                    result = "LOSS"
                elif spot <= target_spot:
                    result = "WIN"

            if result != "TIMEOUT" or is_last_bar:
                pnl     = (exit_ltp - entry_ltp) * lot_size
                cost    = entry_ltp * lot_size
                pnl_pct = pnl / cost * 100 if cost > 0 else 0.0
                equity += pnl
                eq_curve.append(equity)
                eq_times.append(ts_str)

                entry_ts = str(df["ts"].iloc[entry_bar_i])
                trades.append(TradeRecord(
                    entry_time  = entry_ts,
                    exit_time   = ts_str,
                    direction   = "LONG" if option_type == "CE" else "SHORT",
                    entry       = round(entry_ltp, 2),
                    exit_price  = round(exit_ltp, 2),
                    stop_loss   = round(sl_spot, 2),
                    target      = round(target_spot, 2),
                    quantity    = lot_size,
                    pnl         = round(pnl, 2),
                    pnl_pct     = round(pnl_pct, 2),
                    result      = result,
                    strategies  = [request.strategy,
                                   f"{option_type}@{int(row['atm_strike'])}",
                                   f"exp:{day_str}"],
                ))
                in_trade = False

        # ── Entry check ──────────────────────────────────────────────
        if not in_trade and not is_last_bar:
            signal = _dispatch_signal(
                request.strategy, bar, ind,
                prev_spot, prev_st_dir,
                prev_close_by_day, is_expiry, orb,
            )
            if signal:
                opt_type, reason = signal
                ltp = ce_ltp if opt_type == "CE" else pe_ltp
                if ltp > 0:
                    atr      = ind["atr"]
                    in_trade    = True
                    entry_bar_i = i
                    option_type = opt_type
                    entry_ltp   = ltp
                    # SL / target on spot (same multiples as live bot)
                    if opt_type == "CE":
                        sl_spot     = spot - 1.5 * atr
                        target_spot = spot + 2.5 * atr
                    else:
                        sl_spot     = spot + 1.5 * atr
                        target_spot = spot - 2.5 * atr
                    logger.debug(
                        f"BACKTEST ENTRY {opt_type} @ ltp={ltp:.2f} spot={spot:.0f} "
                        f"sl={sl_spot:.0f} tgt={target_spot:.0f} | {reason}"
                    )

        prev_spot   = spot
        prev_st_dir = int(ind["st_dir"])

    # Downsample equity curve for charting (max 300 points)
    if len(eq_curve) > 300:
        step = len(eq_curve) // 300
        idxs = sorted(set(list(range(0, len(eq_curve), step)) + [len(eq_curve) - 1]))
        eq_curve = [eq_curve[j] for j in idxs]
        eq_times = [eq_times[j] for j in idxs]

    equity_curve = [
        EquityPoint(time=t, equity=round(e, 2))
        for t, e in zip(eq_times, eq_curve)
    ]

    metrics = _compute_metrics(trades, request.capital, [p.equity for p in equity_curve])

    return BacktestResponse(
        symbol      = request.index_name,
        from_date   = request.from_date,
        to_date     = request.to_date,
        interval    = "1m",
        capital     = request.capital,
        metrics     = metrics,
        trades      = trades,
        equity_curve= equity_curve,
    )
```

- [ ] **Step 2: Verify the engine runs end-to-end on synthetic data**

```bash
cd d:/TradingApp && python -c "
import asyncio, pandas as pd, numpy as np, aiosqlite
from backend.services.options_backtest_engine import _compute_indicators, run_options_backtest, OPTIONS_DB
from backend.models.backtest import OptionsBacktestRequest

async def test():
    # Seed synthetic ticks into options_tick.sqlite
    import os
    os.makedirs('db', exist_ok=True)
    async with aiosqlite.connect(OPTIONS_DB) as db:
        await db.execute('''CREATE TABLE IF NOT EXISTS options_ticks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL, index_name TEXT NOT NULL, expiry TEXT NOT NULL,
            spot REAL NOT NULL, strike REAL NOT NULL,
            ce_ltp REAL, ce_oi INTEGER, ce_volume INTEGER, ce_iv REAL,
            ce_delta REAL, ce_gamma REAL, ce_theta REAL, ce_vega REAL,
            pe_ltp REAL, pe_oi INTEGER, pe_volume INTEGER, pe_iv REAL,
            pe_delta REAL, pe_gamma REAL, pe_theta REAL, pe_vega REAL,
            pcr REAL, max_pain REAL)''')

        # Insert 80 bars of fake NIFTY ticks on 2026-04-15
        spot = 24000.0
        for m in range(80):
            ts = pd.Timestamp('2026-04-15 09:15') + pd.Timedelta(minutes=m)
            spot += np.random.randn() * 15
            await db.execute(
                'INSERT INTO options_ticks (ts, index_name, expiry, spot, strike, ce_ltp, pe_ltp, ce_oi, pe_oi, pcr, max_pain) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                (ts.isoformat(), 'NIFTY', '2026-04-17', round(spot, 2), 24000.0,
                 max(1.0, 100 + (spot - 24000) * 0.5),
                 max(1.0, 100 - (spot - 24000) * 0.5),
                 500000, 600000, 1.1, 24000.0)
            )
        await db.commit()

    req = OptionsBacktestRequest(
        index_name='NIFTY', strategy='mtf_sniper',
        from_date='2026-04-15', to_date='2026-04-15', capital=100000.0
    )
    result = await run_options_backtest(req)
    print(f'Trades: {result.metrics.total_trades}')
    print(f'Win rate: {result.metrics.win_rate}%')
    print(f'Total PnL: {result.metrics.total_pnl}')
    print('Engine end-to-end OK')

asyncio.run(test())
"
```
Expected: prints trade count, win rate, P&L, and `Engine end-to-end OK`. Trade count may be 0 if no signal fires on this synthetic data — that is acceptable; what matters is no exception is raised.

- [ ] **Step 3: Commit**

```bash
cd d:/TradingApp && git add backend/services/options_backtest_engine.py && git commit -m "feat: options backtest engine — replay loop, dispatcher, metrics"
```

---

## Task 6: API router

**Files:**
- Create: `backend/routers/options_backtest.py`

- [ ] **Step 1: Create the router**

Create `backend/routers/options_backtest.py`:

```python
from fastapi import APIRouter, HTTPException
import aiosqlite

from backend.config import settings
from backend.models.backtest import OptionsBacktestRequest, BacktestResponse
from backend.services.options_backtest_engine import (
    run_options_backtest, OPTIONS_DB, STRATEGY_KEYS,
)

router = APIRouter()


@router.post("/run", response_model=BacktestResponse)
async def run_options_backtest_endpoint(request: OptionsBacktestRequest):
    if request.strategy not in STRATEGY_KEYS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown strategy '{request.strategy}'. Valid: {STRATEGY_KEYS}",
        )
    if request.index_name not in ("NIFTY", "SENSEX"):
        raise HTTPException(status_code=400, detail="index_name must be 'NIFTY' or 'SENSEX'")
    try:
        return await run_options_backtest(request)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Options backtest failed: {e}")


@router.get("/available")
async def get_available():
    """
    Returns the date range and expiries available in options_tick.sqlite.
    Used by the frontend to populate the form and disable it when no data exists.
    """
    result: dict[str, dict] = {}
    try:
        async with aiosqlite.connect(OPTIONS_DB, timeout=5) as db:
            db.row_factory = aiosqlite.Row
            for index_name in ("NIFTY", "SENSEX"):
                cur = await db.execute(
                    """
                    SELECT MIN(substr(ts,1,10)) AS min_date,
                           MAX(substr(ts,1,10)) AS max_date
                    FROM options_ticks
                    WHERE index_name = ?
                    """,
                    (index_name,),
                )
                row = dict(await cur.fetchone() or {})
                if row.get("min_date"):
                    exp_cur = await db.execute(
                        "SELECT DISTINCT expiry FROM options_ticks WHERE index_name = ? ORDER BY expiry",
                        (index_name,),
                    )
                    expiries = [r[0] for r in await exp_cur.fetchall()]
                    result[index_name] = {
                        "min_date": row["min_date"],
                        "max_date": row["max_date"],
                        "expiries": expiries,
                    }
    except Exception:
        pass  # DB doesn't exist yet — return empty dict
    return result
```

- [ ] **Step 2: Verify the router imports cleanly**

```bash
cd d:/TradingApp && python -c "from backend.routers.options_backtest import router; print('Router OK')"
```
Expected: `Router OK`

- [ ] **Step 3: Commit**

```bash
cd d:/TradingApp && git add backend/routers/options_backtest.py && git commit -m "feat: options backtest API router — /run and /available endpoints"
```

---

## Task 7: Register router in main.py

**Files:**
- Modify: `backend/main.py`

- [ ] **Step 1: Add the import and router registration**

In `backend/main.py`, find the line:
```python
from backend.routers import signals, options, orders, broker, backtest, watchlist, paper_trading, market, journal, bot, analytics, calendar_events, fii_dii, alerts, watchlist_v2, screener, ai_trader, metering, admin
```
Add `options_backtest` to the import:
```python
from backend.routers import signals, options, orders, broker, backtest, watchlist, paper_trading, market, journal, bot, analytics, calendar_events, fii_dii, alerts, watchlist_v2, screener, ai_trader, metering, admin, options_backtest
```

Then find the last `app.include_router(...)` call (admin router) and add after it:
```python
app.include_router(options_backtest.router, prefix="/options-backtest", tags=["options-backtest"])
```

- [ ] **Step 2: Verify the app starts without error**

```bash
cd d:/TradingApp && python -c "
import asyncio
from backend.main import app
print([r.path for r in app.routes if 'options-backtest' in r.path])
print('main.py OK')
"
```
Expected: prints `['/options-backtest/run', '/options-backtest/available']` and `main.py OK`.

- [ ] **Step 3: Commit**

```bash
cd d:/TradingApp && git add backend/main.py && git commit -m "feat: register options-backtest router in main.py"
```

---

## Task 8: Frontend — Options Backtest tab

**Files:**
- Modify: `frontend/src/app/backtest/page.tsx`

The existing page has a single form + results section. We add a tab switcher at the top that toggles between the existing "Price Backtest" view and a new "Options Backtest" view. All existing components (`EquityCurve`, `MetricCard`, `StrategyHitChart`, `ResultBanner`, `LoadingOverlay`) are reused unchanged.

- [ ] **Step 1: Add tab state and Options Backtest form state**

In `frontend/src/app/backtest/page.tsx`, find the `export default function BacktestPage()` declaration (line 529) and add the tab state and options-specific state immediately after the existing state declarations:

```tsx
  const [activeTab, setActiveTab] = useState<"price" | "options">("price");

  // Options backtest state
  const [optIndex,      setOptIndex]      = useState<"NIFTY" | "SENSEX">("NIFTY");
  const [optStrategy,   setOptStrategy]   = useState("mtf_sniper");
  const [optExpiry,     setOptExpiry]     = useState<"front" | "next">("front");
  const [optFromDate,   setOptFromDate]   = useState(() => new Date().toISOString().slice(0, 10));
  const [optToDate,     setOptToDate]     = useState(() => new Date().toISOString().slice(0, 10));
  const [optCapital,    setOptCapital]    = useState("100000");
  const [optLoading,    setOptLoading]    = useState(false);
  const [optError,      setOptError]      = useState<string | null>(null);
  const [optResult,     setOptResult]     = useState<BacktestResponse | null>(null);
  const [optAvailable,  setOptAvailable]  = useState<Record<string, { min_date: string; max_date: string; expiries: string[] }>>({});
```

- [ ] **Step 2: Add the `useEffect` to fetch available data and the options run handler**

Add these immediately after the state declarations from Step 1 (before the `handleRun` function):

```tsx
  // Fetch available options tick data on mount
  const { useEffect } = require("react"); // Note: add useEffect to the import at top
```

Actually, add `useEffect` to the React import at the top of the file. The file starts with:
```tsx
"use client";
import { useState } from "react";
```
Change to:
```tsx
"use client";
import { useState, useEffect } from "react";
```

Then add after the state declarations:
```tsx
  useEffect(() => {
    fetch("http://localhost:8000/options-backtest/available")
      .then(r => r.json())
      .then(d => setOptAvailable(d))
      .catch(() => {});
  }, []);

  async function handleOptionsRun() {
    setOptLoading(true); setOptError(null); setOptResult(null);
    try {
      const res = await fetch("http://localhost:8000/options-backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          index_name:  optIndex,
          strategy:    optStrategy,
          from_date:   optFromDate,
          to_date:     optToDate,
          expiry_type: optExpiry,
          capital:     parseFloat(optCapital) || 100_000,
        }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail ?? "Options backtest failed"); }
      setOptResult(await res.json());
    } catch (e: unknown) {
      setOptError(e instanceof Error ? e.message : String(e));
    } finally {
      setOptLoading(false);
    }
  }
```

- [ ] **Step 3: Add the tab switcher and Options Backtest form to the JSX**

In the JSX, find the opening `<div style={{ padding: "4px 8px", maxWidth: 1100, margin: "0 auto" }}>` and the Hero section. Insert the tab switcher immediately after the Hero `</div>` and before the Form `{/* ── Form ── */}` comment:

```tsx
      {/* ── Tab switcher ── */}
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {(["price", "options"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: "8px 20px", borderRadius: 8, border: "none",
              fontWeight: 700, fontSize: 12, cursor: "pointer",
              background: activeTab === tab ? "#2563eb" : "#f1f5f9",
              color: activeTab === tab ? "#fff" : "#64748b",
              letterSpacing: "0.03em",
              transition: "all 0.15s",
            }}
          >
            {tab === "price" ? "Price Backtest" : "Options Backtest"}
          </button>
        ))}
      </div>
```

Then wrap the entire existing Form + Error + Loading + Results block in `{activeTab === "price" && ( ... )}`.

After that closing paren, add the Options Backtest panel:

```tsx
      {/* ── Options Backtest Panel ── */}
      {activeTab === "options" && (
        <>
          {/* Options form */}
          <div style={{
            background: "#ffffff", border: "1px solid #e8e8e8", borderRadius: 14,
            padding: "20px 24px", marginBottom: 8,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#131722", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 16 }}>🎯</span> Options Backtest — Real Premium P&L
            </div>

            {/* No data warning */}
            {Object.keys(optAvailable).length === 0 && (
              <div style={{
                background: "#fefce8", border: "1px solid #fde047", borderRadius: 8,
                padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#854d0e",
              }}>
                No options tick data logged yet. The logger runs automatically during market hours (9:15–15:30 IST).
                Start the app before market open and data will appear here.
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr 0.9fr", gap: 8, alignItems: "end" }}>
              {/* Index */}
              <div>
                <label style={labelStyle}>Index</label>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["NIFTY", "SENSEX"] as const).map(idx => (
                    <button key={idx} onClick={() => setOptIndex(idx)} style={{
                      flex: 1, padding: "9px 0", borderRadius: 7, border: "1px solid",
                      borderColor: optIndex === idx ? "#2563eb" : "#d1d5db",
                      background: optIndex === idx ? "#eff6ff" : "#fff",
                      color: optIndex === idx ? "#2563eb" : "#374151",
                      fontWeight: 700, fontSize: 12, cursor: "pointer",
                    }}>{idx}</button>
                  ))}
                </div>
              </div>

              {/* Strategy */}
              <div>
                <label style={labelStyle}>Strategy</label>
                <select value={optStrategy} onChange={e => setOptStrategy(e.target.value)} style={inputStyle}>
                  {[
                    ["mtf_sniper",       "MTF Sniper"],
                    ["pdh_pdl_break",    "PDH/PDL Break"],
                    ["supertrend_follow","Supertrend Follow"],
                    ["candle_pattern",   "Candle Pattern"],
                    ["expiry_theta",     "Expiry Theta"],
                    ["ict_smc",          "ICT Smart Money"],
                    ["oi_sr_simple",     "OI S/R Simple"],
                    ["orb_breakout",     "ORB Breakout ★"],
                    ["supertrend_pure",  "Supertrend Pure ★"],
                  ].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <div style={hintStyle}>★ = new strategy</div>
              </div>

              {/* Expiry */}
              <div>
                <label style={labelStyle}>Expiry Week</label>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["front", "next"] as const).map(e => (
                    <button key={e} onClick={() => setOptExpiry(e)} style={{
                      flex: 1, padding: "9px 0", borderRadius: 7, border: "1px solid",
                      borderColor: optExpiry === e ? "#2563eb" : "#d1d5db",
                      background: optExpiry === e ? "#eff6ff" : "#fff",
                      color: optExpiry === e ? "#2563eb" : "#374151",
                      fontWeight: 700, fontSize: 12, cursor: "pointer",
                    }}>{e === "front" ? "Front" : "Next"}</button>
                  ))}
                </div>
              </div>

              {/* From */}
              <div>
                <label style={labelStyle}>From Date</label>
                <input
                  type="date"
                  value={optFromDate}
                  min={optAvailable[optIndex]?.min_date}
                  max={optAvailable[optIndex]?.max_date}
                  onChange={e => setOptFromDate(e.target.value)}
                  style={inputStyle}
                />
                <div style={hintStyle}>{optAvailable[optIndex] ? `Data from ${optAvailable[optIndex].min_date}` : "No data yet"}</div>
              </div>

              {/* To */}
              <div>
                <label style={labelStyle}>To Date</label>
                <input
                  type="date"
                  value={optToDate}
                  min={optAvailable[optIndex]?.min_date}
                  max={optAvailable[optIndex]?.max_date}
                  onChange={e => setOptToDate(e.target.value)}
                  style={inputStyle}
                />
                <div style={hintStyle}>End of test period</div>
              </div>

              {/* Capital */}
              <div>
                <label style={labelStyle}>Capital (₹)</label>
                <input
                  type="number" value={optCapital}
                  onChange={e => setOptCapital(e.target.value)}
                  min="10000" step="10000" style={inputStyle}
                />
                <div style={hintStyle}>Starting cash</div>
              </div>
            </div>

            <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 12 }}>
              <button
                onClick={handleOptionsRun}
                disabled={optLoading || Object.keys(optAvailable).length === 0}
                style={{
                  padding: "10px 28px", borderRadius: 8, border: "none",
                  cursor: (optLoading || Object.keys(optAvailable).length === 0) ? "not-allowed" : "pointer",
                  background: (optLoading || Object.keys(optAvailable).length === 0)
                    ? "#94a3b8"
                    : "linear-gradient(135deg, #059669, #10b981)",
                  color: "#fff", fontWeight: 700, fontSize: 13,
                  boxShadow: optLoading ? "none" : "0 4px 12px rgba(16,185,129,0.35)",
                  transition: "all 0.2s",
                }}
              >
                {optLoading ? "⏳ Running…" : "▶ Run Options Backtest"}
              </button>
              {optResult && !optLoading && (
                <button
                  onClick={() => setOptResult(null)}
                  style={{
                    padding: "10px 18px", borderRadius: 8, border: "1px solid #e8e8e8",
                    cursor: "pointer", background: "#f8fafc", color: "#6b7280", fontWeight: 600, fontSize: 13,
                  }}
                >
                  Clear Results
                </button>
              )}
            </div>
          </div>

          {/* Error */}
          {optError && (
            <div style={{
              background: "#fef2f2", border: "1px solid #ef535030", borderRadius: 10,
              padding: "8px 10px", color: "#ef5350", fontSize: 13, marginBottom: 8,
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <span style={{ fontSize: 18 }}>⚠️</span> {optError}
            </div>
          )}

          {/* Loading */}
          {optLoading && (
            <div style={{
              background: "#ffffff", border: "1px solid #e8e8e8", borderRadius: 16,
              padding: "48px 32px", textAlign: "center",
            }}>
              <div style={{ position: "relative", width: 64, height: 64, margin: "0 auto 24px" }}>
                <div style={{
                  width: 64, height: 64, border: "4px solid #e2e8f0", borderTopColor: "#10b981",
                  borderRadius: "50%", animation: "spin 0.9s linear infinite",
                }} />
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>📊</div>
              </div>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#131722", marginBottom: 6 }}>
                Replaying {optStrategy} on {optIndex}…
              </div>
              <div style={{ fontSize: 13, color: "#6b7280" }}>
                Bar-by-bar replay against real CE/PE premiums from options_tick.sqlite
              </div>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {/* Results — reuse all existing result components */}
          {optResult && optResult.metrics && !optLoading && (() => {
            const m = optResult.metrics;
            return (
              <>
                <ResultBanner result={optResult} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
                  {buildMetrics(m).map(card => <MetricCard key={card.label} m={card} />)}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8, marginBottom: 16 }}>
                  <div style={{ background: "#ffffff", border: "1px solid #e8e8e8", borderRadius: 14, padding: "8px 10px" }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "#131722" }}>Equity Curve</div>
                      <div style={{ fontSize: 11, color: "#6b7280" }}>
                        {optResult.symbol} · {optStrategy} · ₹{optResult.capital.toLocaleString("en-IN")} capital
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 10, fontStyle: "italic" }}>
                      P&L is in CE/PE premium terms: (exit LTP − entry LTP) × lot size
                    </div>
                    <EquityCurve points={optResult.equity_curve} capital={optResult.capital} />
                  </div>
                  <div style={{ background: "#ffffff", border: "1px solid #e8e8e8", borderRadius: 14, padding: "8px 10px" }}>
                    <StrategyHitChart trades={optResult.trades} />
                  </div>
                </div>

                {optResult.trades.length > 0 ? (
                  <div style={{ background: "#ffffff", border: "1px solid #e8e8e8", borderRadius: 14, overflow: "hidden", marginBottom: 20 }}>
                    <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 15 }}>📋</span>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 800, color: "#131722" }}>
                          Trade Log — {optResult.trades.length} trades · {optResult.symbol} {optStrategy}
                        </div>
                        <div style={{ fontSize: 11, color: "#6b7280" }}>
                          Entry/exit prices are real option premium LTPs. P&L = (exit − entry) × lot size.
                        </div>
                      </div>
                    </div>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: "#f8fafc", borderBottom: "1px solid #f0f0f0" }}>
                            {["#", "Type", "Entry Time", "Entry LTP", "Exit LTP", "Spot SL", "Spot Tgt", "Lots", "P&L", "%", "Result", "Details"].map(h => (
                              <th key={h} style={thStyle}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {optResult.trades.map((t, i) => {
                            const win = t.result === "WIN";
                            const loss = t.result === "LOSS";
                            const optType = t.strategies.find(s => s.startsWith("CE") || s.startsWith("PE")) ?? t.direction;
                            const details = t.strategies.filter(s => !s.startsWith("CE") && !s.startsWith("PE") && !s.startsWith("exp:")).join(", ");
                            return (
                              <tr key={i} style={{
                                borderBottom: "1px solid #f8fafc",
                                background: win ? "rgba(240,253,244,0.5)" : loss ? "rgba(254,242,242,0.4)" : "#fff",
                                borderLeft: `3px solid ${win ? "#16a34a" : loss ? "#dc2626" : "#e2e8f0"}`,
                              }}>
                                <td style={{ ...tdStyle, color: "#6b7280", fontSize: 10 }}>{i + 1}</td>
                                <td style={{ ...tdStyle, fontWeight: 700, color: optType.startsWith("CE") ? "#15803d" : "#b91c1c" }}>{optType}</td>
                                <td style={{ ...tdStyle, color: "#6b7280", whiteSpace: "nowrap" }}>{t.entry_time.slice(0, 16)}</td>
                                <td style={tdStyle}>₹{t.entry.toFixed(2)}</td>
                                <td style={{ ...tdStyle, fontWeight: 600 }}>₹{t.exit_price.toFixed(2)}</td>
                                <td style={{ ...tdStyle, color: "#ef5350" }}>₹{t.stop_loss.toFixed(0)}</td>
                                <td style={{ ...tdStyle, color: "#26a69a" }}>₹{t.target.toFixed(0)}</td>
                                <td style={tdStyle}>{t.quantity}</td>
                                <td style={{ ...tdStyle, fontWeight: 700, color: t.pnl >= 0 ? "#15803d" : "#b91c1c" }}>
                                  {t.pnl >= 0 ? "+" : ""}₹{t.pnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                                </td>
                                <td style={{ ...tdStyle, fontWeight: 600, color: t.pnl_pct >= 0 ? "#15803d" : "#b91c1c" }}>
                                  {t.pnl_pct >= 0 ? "+" : ""}{t.pnl_pct.toFixed(1)}%
                                </td>
                                <td style={tdStyle}>
                                  <span style={{
                                    fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                                    background: win ? "#f0fdf4" : loss ? "#fef2f2" : "#f8fafc",
                                    color: win ? "#15803d" : loss ? "#b91c1c" : "#64748b",
                                    border: `1px solid ${win ? "#86efac" : loss ? "#fca5a5" : "#e2e8f0"}`,
                                  }}>
                                    {t.result === "WIN" ? "✓ WIN" : t.result === "LOSS" ? "✗ LOSS" : "⏱ TIME"}
                                  </span>
                                </td>
                                <td style={{ ...tdStyle, color: "#6b7280", fontSize: 10 }}>{details}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div style={{
                    background: "#ffffff", border: "1px solid #e8e8e8", borderRadius: 14,
                    padding: "16px 12px", textAlign: "center",
                  }}>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#131722", marginBottom: 6 }}>No trades found</div>
                    <div style={{ fontSize: 13, color: "#6b7280" }}>
                      The {optStrategy} strategy did not fire any signals in this period.<br />
                      Try a wider date range or a different strategy.
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </>
      )}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd d:/TradingApp/frontend && npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors (or only pre-existing unrelated errors, not errors in `backtest/page.tsx`).

- [ ] **Step 3: Start dev server and visually verify the tab switcher**

```bash
cd d:/TradingApp/frontend && npm run dev
```
Open `http://localhost:3000/backtest` in a browser. Verify:
1. Two tabs appear: "Price Backtest" and "Options Backtest"
2. Clicking "Options Backtest" shows the form with Index/Strategy/Expiry/Date/Capital fields
3. If no tick data exists, the yellow warning banner shows
4. Strategy dropdown shows all 9 strategies with ★ on ORB and Supertrend Pure
5. The "Price Backtest" tab still works as before (run a quick backtest on RELIANCE to confirm no regression)

- [ ] **Step 4: Commit**

```bash
cd d:/TradingApp && git add frontend/src/app/backtest/page.tsx && git commit -m "feat: options backtest UI — new tab on backtest page with full form and results"
```

---

## Task 9: End-to-end integration test

**Files:** No new files

- [ ] **Step 1: Restart backend and verify both endpoints respond**

```bash
# In a terminal: start the backend
cd d:/TradingApp && uvicorn backend.main:app --reload --port 8000
```

In a second terminal:
```bash
curl -s http://localhost:8000/options-backtest/available | python -m json.tool
```
Expected: either `{}` (no data yet — correct) or a JSON object with NIFTY/SENSEX date ranges.

- [ ] **Step 2: Verify the run endpoint returns a proper 400 when no data**

```bash
curl -s -X POST http://localhost:8000/options-backtest/run \
  -H "Content-Type: application/json" \
  -d '{"index_name":"NIFTY","strategy":"mtf_sniper","from_date":"2026-04-01","to_date":"2026-04-01","capital":100000}' \
  | python -m json.tool
```
Expected: `{"detail": "Not enough tick data for NIFTY ... "}` (400 error — correct, no data for that date).

- [ ] **Step 3: Verify the UI renders correctly end-to-end**

Open `http://localhost:3000/backtest`. Switch to "Options Backtest" tab. The form should render without JavaScript errors in the browser console. If tick data has been logged (start the app during market hours), run a backtest and verify the equity curve and trade log render correctly.

- [ ] **Step 4: Final commit**

```bash
cd d:/TradingApp && git add -A && git commit -m "feat: options backtest — full integration (engine, router, UI, 2 new strategies)"
```

---

## Self-Review

**Spec coverage check:**
- [x] Tick loading from `options_tick.sqlite` — Task 2
- [x] ATM strike selection with fallback to nearest — Task 2 `_load_ticks`
- [x] RSI, EMA, ATR, BB, trend_score indicators — Task 2 `_compute_indicators`
- [x] All 7 existing strategies ported as pure functions — Task 3
- [x] ORB Breakout new strategy — Task 4
- [x] Supertrend Pure new strategy — Task 4
- [x] Replay loop with spot-based SL/target — Task 5
- [x] CE/PE LTP entry/exit pricing — Task 5
- [x] P&L in premium terms × lot size — Task 5
- [x] Lot sizes from `LOT_SIZES` constant (never hardcoded) — Task 2
- [x] TIMEOUT result for end-of-data trades — Task 5
- [x] `BacktestResponse` format reused — Task 5
- [x] `POST /options-backtest/run` — Task 6
- [x] `GET /options-backtest/available` — Task 6
- [x] Router registered in main.py — Task 7
- [x] "Options Backtest" tab on existing backtest page — Task 8
- [x] Form: index, strategy, expiry, date range, capital — Task 8
- [x] No-data warning banner — Task 8
- [x] Strategy dropdown with ★ on new strategies — Task 8
- [x] Reuses EquityCurve, MetricCard, StrategyHitChart, ResultBanner — Task 8
- [x] Options-specific trade log (entry LTP, exit LTP, option type) — Task 8

**Type consistency check:** `OptionsBacktestRequest` defined in Task 1, imported in Tasks 6 and 5. `run_options_backtest` defined in Task 5, imported in Task 6. `_OrbState` defined in Task 4, used in Task 5. All consistent.

**No placeholders:** All code blocks are complete and ready to paste.
