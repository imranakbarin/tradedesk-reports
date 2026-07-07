# US Stocks Short-Selling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the US paper bot trade SHORT setups symmetrically with longs, un-gating the scanner's existing short signals.

**Architecture:** Thread a direction sign (`LONG→+1`, `SHORT→−1`) derived from each trade's stored `action` through all exit/PnL/trail math in `us_stocks_bot.py`; add a mirror-image short branch to each of the 3 strategies; map short scanner setups to strategies; un-gate the UI. Paper simulation only — no real Alpaca short orders.

**Tech Stack:** Python 3.11 + aiosqlite (backend bot), pytest, Next.js/React + inline CSS (frontend).

**Spec:** `docs/superpowers/specs/2026-07-06-us-stocks-short-selling-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/services/us_stocks_bot.py` | **modify** — `_dir_sign` helper; direction-aware `_trail_sl`, `_place_paper_trade`, `_close_paper_trade`, `_manage_open_trade`, entry re-anchor; 3 short eval branches |
| `backend/services/us_scanner.py` | **modify** — map short setups in `SETUP_TO_STRATEGY` |
| `frontend/src/app/us-stocks/page.tsx` | **modify** — drop stale "long-only" fallback; red SHORT badge |
| `backend/tests/test_us_stocks_shorts.py` | **new** — mechanics + short eval + no-regression |

**Key invariant:** for a SHORT trade, `sl > entry > target`, and a winning short has `exit < entry` → PnL `(exit − entry)·qty·(−1) > 0`.

---

## Task 1: Direction-aware trade mechanics

**Files:**
- Modify: `backend/services/us_stocks_bot.py`
- Test: `backend/tests/test_us_stocks_shorts.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_us_stocks_shorts.py`:

```python
"""Short-selling mechanics + eval tests for us_stocks_bot.

Covers the direction-sign generalization (exit/PnL/trail) and the mirror short
branches of the 3 strategies. Long behavior must not regress.
"""
import asyncio
import sqlite3
from datetime import datetime

import pytest

from backend.config import settings
from backend.db.database import init_db
from backend.services import us_stocks_bot as B


# ── _dir_sign + _trail_sl ────────────────────────────────────────────────────

def test_dir_sign():
    assert B._dir_sign("LONG") == 1
    assert B._dir_sign("SHORT") == -1
    assert B._dir_sign("anything_else") == 1


def test_trail_sl_short_moves_to_breakeven_at_1r():
    # short entry 100, SL 102 (risk 2). At 1R profit price=98 -> SL to BE (100).
    assert B._trail_sl(100.0, 98.0, 102.0, -1) == 100.0
    # not yet 1R (price 99) -> unchanged
    assert B._trail_sl(100.0, 99.0, 102.0, -1) == 102.0


def test_trail_sl_long_unchanged():
    # long entry 100, SL 98 (risk 2). At 1R profit price=102 -> BE (100).
    assert B._trail_sl(100.0, 102.0, 98.0, 1) == 100.0
    assert B._trail_sl(100.0, 101.0, 98.0, 1) == 98.0


# ── DB-backed mechanics ──────────────────────────────────────────────────────

def _seed_session(db, session_id):
    db.execute(
        "INSERT INTO bot_sessions (session_id, index_name, strategy, lot_size, "
        "status, started_at, venue, symbol, capital) "
        "VALUES (?,?,?,0,'RUNNING',?,?,?,?)",
        (session_id, "TSLA", "us_orb", "2026-07-06T09:46:00", "US_STOCKS", "TSLA", 10000),
    )


def _seed_open_trade(db, session_id, trade_id, action, entry, sl, target, qty=10):
    db.execute(
        "INSERT INTO bot_trades (session_id, trade_id, index_name, action, strike, "
        "entry_price, sl_price, target_price, current_price, lot_size, status, placed_at) "
        "VALUES (?,?,?,?,0,?,?,?,?,?,'OPEN',?)",
        (session_id, trade_id, "TSLA", action, entry, sl, target, entry, qty,
         "2026-07-06T09:46:00"),
    )


def _trade_row(db_path, trade_id):
    con = sqlite3.connect(db_path); con.row_factory = sqlite3.Row
    row = con.execute("SELECT status, exit_price, pnl, action FROM bot_trades "
                      "WHERE trade_id=?", (trade_id,)).fetchone()
    con.close()
    return dict(row)


@pytest.fixture
def bot_env(tmp_path, monkeypatch):
    db_path = str(tmp_path / "shorts_test.sqlite")
    monkeypatch.setattr(settings, "sqlite_path", db_path)
    asyncio.run(init_db())
    # Never trip the EOD force-close in these tests
    monkeypatch.setattr(B, "_past_force_close", lambda: False)

    def set_price(p):
        async def fake(symbol):
            return p
        monkeypatch.setattr(B, "get_latest_trade_price", fake)

    con = sqlite3.connect(db_path)
    _seed_session(con, "sess1")
    con.commit(); con.close()
    return db_path, set_price


def test_short_target_hit_positive_pnl(bot_env):
    db_path, set_price = bot_env
    con = sqlite3.connect(db_path)
    _seed_open_trade(con, "sess1", "s1", "SHORT", 100.0, 102.0, 97.0, qty=10)
    con.commit(); con.close()
    set_price(96.0)  # <= target 97 -> TARGET_HIT
    closed, status = asyncio.run(B._manage_open_trade("sess1", "TSLA"))
    assert closed and status == "TARGET_HIT"
    row = _trade_row(db_path, "s1")
    # pnl = (exit 96 - entry 100) * 10 * (-1) = +40
    assert row["pnl"] == 40.0


def test_short_sl_hit_negative_pnl(bot_env):
    db_path, set_price = bot_env
    con = sqlite3.connect(db_path)
    _seed_open_trade(con, "sess1", "s2", "SHORT", 100.0, 102.0, 97.0, qty=10)
    con.commit(); con.close()
    set_price(103.0)  # >= SL 102 -> SL_HIT, closes at effective SL 102
    closed, status = asyncio.run(B._manage_open_trade("sess1", "TSLA"))
    assert closed and status == "SL_HIT"
    row = _trade_row(db_path, "s2")
    # pnl = (102 - 100) * 10 * (-1) = -20
    assert row["pnl"] == -20.0


def test_long_target_hit_still_works(bot_env):
    db_path, set_price = bot_env
    con = sqlite3.connect(db_path)
    _seed_open_trade(con, "sess1", "l1", "LONG", 100.0, 98.0, 103.0, qty=10)
    con.commit(); con.close()
    set_price(104.0)  # >= target 103 -> TARGET_HIT
    closed, status = asyncio.run(B._manage_open_trade("sess1", "TSLA"))
    assert closed and status == "TARGET_HIT"
    assert _trade_row(db_path, "l1")["pnl"] == 40.0  # (104-100)*10*1


def test_place_paper_trade_records_short(bot_env):
    db_path, _ = bot_env
    tid = asyncio.run(B._place_paper_trade("sess1", "TSLA", "SHORT",
                                           100.0, 102.0, 97.0, "test short", 5))
    assert tid is not None
    assert _trade_row(db_path, tid)["action"] == "SHORT"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:\TradingApp\backend && .venv\Scripts\python -m pytest tests/test_us_stocks_shorts.py -v`
Expected: FAIL — `AttributeError: module 'backend.services.us_stocks_bot' has no attribute '_dir_sign'`.

- [ ] **Step 3: Add `_dir_sign` and make `_trail_sl` direction-aware**

In `backend/services/us_stocks_bot.py`, add the helper just after the risk-params block (after `TRAIL_BE_R = 1.0`):

```python
def _dir_sign(action: str) -> int:
    """+1 for LONG, -1 for SHORT. Unknown actions treated as long."""
    return -1 if action == "SHORT" else 1
```

Replace the existing `_trail_sl` function with:

```python
def _trail_sl(entry: float, current: float, original_sl: float, sign: int) -> float:
    """Move SL to breakeven once 1R profit reached. Ratchet-only, direction-aware.
    sign +1 long / -1 short."""
    risk = abs(entry - original_sl)
    if risk <= 0:
        return original_sl
    if sign * (current - entry) / risk >= TRAIL_BE_R:
        return entry
    return original_sl
```

- [ ] **Step 4: Make `_place_paper_trade` and `_close_paper_trade` direction-aware**

Change the `_place_paper_trade` signature and INSERT. Replace its definition with:

```python
async def _place_paper_trade(session_id: str, symbol: str, action: str, entry: float,
                              sl: float, target: float, reason: str,
                              confluence: int) -> str | None:
    qty = _position_size(entry)
    if qty <= 0:
        return None
    trade_id = str(uuid.uuid4())[:8]
    now = datetime.now().isoformat()
    async with aiosqlite.connect(_settings.sqlite_path, timeout=10) as db:
        await db.execute("""
            INSERT INTO bot_trades
                (session_id, trade_id, index_name, action, strike,
                 entry_price, sl_price, target_price, current_price,
                 lot_size, status, reason, placed_at)
            VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
        """, (
            session_id, trade_id, symbol, action,
            round(entry, 2), round(sl, 2), round(target, 2),
            round(entry, 2), qty, reason[:300], now,
        ))
        await db.commit()
    logger.info(f"US_PAPER placed {action} {qty} {symbol} @ {entry:.2f} SL={sl:.2f} TGT={target:.2f}")
    return trade_id
```

In `_close_paper_trade`, replace the PnL line:

```python
    entry = open_trade["entry_price"]
    qty   = open_trade["lot_size"]
    pnl   = round((exit_price - entry) * qty, 2)
```

with:

```python
    entry = open_trade["entry_price"]
    qty   = open_trade["lot_size"]
    sign  = _dir_sign(open_trade["action"])
    pnl   = round((exit_price - entry) * qty * sign, 2)
```

- [ ] **Step 5: Make `_manage_open_trade` direction-aware**

Replace the body of `_manage_open_trade` from the `trailing = ...` line through the final `return False, None` with:

```python
        entry       = trade["entry_price"]
        original_sl = trade["sl_price"]
        target      = trade["target_price"]
        qty         = trade["lot_size"]
        sign        = _dir_sign(trade["action"])

        trailing = _trail_sl(entry, price, original_sl, sign)
        effective_sl = max(trailing, original_sl) if sign > 0 else min(trailing, original_sl)

        hit_target = sign * (price - target) >= 0
        hit_sl     = sign * (price - effective_sl) <= 0
        eod_close  = _past_force_close()

        if hit_target:
            await _close_paper_trade(db, trade, price, "TARGET_HIT", "target hit")
            await db.commit()
            return True, "TARGET_HIT"
        if hit_sl:
            status = "TRAIL_SL" if effective_sl != original_sl else "SL_HIT"
            await _close_paper_trade(db, trade, effective_sl, status,
                                      f"sl={effective_sl:.2f}")
            await db.commit()
            return True, status
        if eod_close:
            await _close_paper_trade(db, trade, price, "EOD_CLOSE",
                                      "15:55 ET force-close")
            await db.commit()
            return True, "EOD_CLOSE"

        # Just update live price + maybe tighten SL
        pnl = round((price - entry) * qty * sign, 2)
        updates = "current_price = ?, pnl = ?"
        params: list = [round(price, 2), pnl]
        if effective_sl != original_sl:
            updates += ", sl_price = ?"
            params.append(round(effective_sl, 2))
        params.append(trade["trade_id"])
        await db.execute(f"UPDATE bot_trades SET {updates} WHERE trade_id=?", params)
        await db.commit()
        return False, None
```

- [ ] **Step 6: Update the `_bot_loop` entry re-anchor + placement call**

In `_bot_loop`, replace this block:

```python
            action, reason, sl, target, confluence = sig
            blog(session_id, "SIGNAL",
                 f"{action} {symbol} C{confluence} — {reason[:80]}",
                 symbol=symbol, strategy=strategy)

            # 6. Refresh live price for entry
            entry = await get_latest_trade_price(symbol)
            if entry <= 0:
                await asyncio.sleep(TICK)
                continue
            # Re-anchor SL/target to live entry
            sl_d  = abs(entry - sl)
            tgt_d = abs(target - entry)
            sl     = round(entry - sl_d, 2)
            target = round(entry + tgt_d, 2)

            # 7. Place paper trade
            trade_id = await _place_paper_trade(
                session_id, symbol, entry, sl, target,
                f"[{strategy}] C{confluence} {reason}", confluence)
            if trade_id:
                state.last_entry_at = _time.monotonic()
                blog(session_id, "TRADE",
                     f"LONG {symbol} @${entry:.2f} SL=${sl:.2f} TGT=${target:.2f}",
                     symbol=symbol, strategy=strategy)
```

with:

```python
            action, reason, sl, target, confluence = sig
            sign = _dir_sign(action)
            blog(session_id, "SIGNAL",
                 f"{action} {symbol} C{confluence} — {reason[:80]}",
                 symbol=symbol, strategy=strategy)

            # 6. Refresh live price for entry
            entry = await get_latest_trade_price(symbol)
            if entry <= 0:
                await asyncio.sleep(TICK)
                continue
            # Re-anchor SL/target to live entry (direction-aware)
            sl_d  = abs(entry - sl)
            tgt_d = abs(target - entry)
            sl     = round(entry - sign * sl_d, 2)
            target = round(entry + sign * tgt_d, 2)

            # 7. Place paper trade
            trade_id = await _place_paper_trade(
                session_id, symbol, action, entry, sl, target,
                f"[{strategy}] C{confluence} {reason}", confluence)
            if trade_id:
                state.last_entry_at = _time.monotonic()
                blog(session_id, "TRADE",
                     f"{action} {symbol} @${entry:.2f} SL=${sl:.2f} TGT=${target:.2f}",
                     symbol=symbol, strategy=strategy)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd D:\TradingApp\backend && .venv\Scripts\python -m pytest tests/test_us_stocks_shorts.py -v`
Expected: PASS (7 tests: `_dir_sign`, 2× `_trail_sl`, short target/SL, long target, place-short).

- [ ] **Step 8: Commit**

```bash
git add backend/services/us_stocks_bot.py backend/tests/test_us_stocks_shorts.py
git commit -m "feat(us-stocks): direction-aware trade mechanics for shorts"
```

---

## Task 2: Short eval branches for the 3 strategies

**Files:**
- Modify: `backend/services/us_stocks_bot.py`
- Test: `backend/tests/test_us_stocks_shorts.py`

- [ ] **Step 1: Add the failing eval tests**

Append to `backend/tests/test_us_stocks_shorts.py`:

```python
# ── Short eval branches ──────────────────────────────────────────────────────

def _assert_short(sig):
    assert sig is not None, "expected a signal"
    action, reason, sl, target, conf = sig
    assert action == "SHORT"
    # short invariant: sl above entry-ish above target
    assert sl > target
    return sig


def test_orb_short_breaks_below():
    data = {
        "opening_range": {"low": 100.0, "high": 105.0,
                          "broke_below": True, "broke_above": False},
        "tf_5m": {"price": 99.8, "atr": 1.0, "vol_ratio": 1.5, "rsi": 40},
        "tf_1h": {"trend": "DOWN"},
    }
    sig = B.evaluate_strategy("us_orb", data, B.BotState(), "TSLA")
    action, reason, sl, target, conf = _assert_short(sig)
    assert sl > 99.8 > target       # sl above entry, target below


def test_trend_pullback_short_in_downtrend():
    data = {
        "tf_5m": {"price": 50.0, "ema20": 50.05, "atr": 0.5, "rsi": 58, "vol_ratio": 1.3},
        "tf_1h": {"trend": "STRONG_DOWN"},
    }
    sig = B.evaluate_strategy("us_trend_pullback", data, B.BotState(), "TSLA")
    _assert_short(sig)


def test_mean_reversion_short_at_upper_band():
    data = {
        "tf_5m": {"price": 210.0, "bb_up": 209.0, "bb_mid": 200.0, "atr": 2.0, "rsi": 76},
        "tf_1h": {"trend": "DOWN"},
    }
    sig = B.evaluate_strategy("us_mean_reversion", data, B.BotState(), "TSLA")
    action, reason, sl, target, conf = _assert_short(sig)
    assert target == 200.0          # target = BB mid


def test_trend_pullback_long_still_fires():
    data = {
        "tf_5m": {"price": 50.0, "ema20": 49.95, "atr": 0.5, "rsi": 42, "vol_ratio": 1.3},
        "tf_1h": {"trend": "UP"},
    }
    sig = B.evaluate_strategy("us_trend_pullback", data, B.BotState(), "TSLA")
    assert sig is not None and sig[0] == "LONG"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd D:\TradingApp\backend && .venv\Scripts\python -m pytest tests/test_us_stocks_shorts.py -k "short or long_still" -v`
Expected: FAIL — the short branches don't exist yet, so `evaluate_strategy` returns `None` (assertions fail).

- [ ] **Step 3: Add the ORB short branch**

In `_eval_us_orb`, after the existing long block that ends with the `return ("LONG", ...)`, and before the function's implicit end, the current code returns the long tuple. Restructure so it handles both. Replace the section from `orng = data.get("opening_range", {})` through the final `return ("LONG", ...)` with:

```python
    orng = data.get("opening_range", {})
    tf5 = data.get("tf_5m", {})
    price = tf5.get("price", 0)
    atr = tf5.get("atr", 0)
    if not orng or price <= 0 or atr <= 0:
        return None
    tf1h = data.get("tf_1h", {})
    trend = tf1h.get("trend")

    # LONG: break above opening-range high
    if orng.get("broke_above") and orng.get("high", 0) > 0:
        or_high = orng["high"]
        extension_pct = (price - or_high) / or_high
        if extension_pct > 0.005:
            return None
        if tf5.get("vol_ratio", 0) < 1.0:
            return None
        sl = round(price - atr * SL_R_MULT, 2)
        tgt = round(price + atr * SL_R_MULT * TGT_R_MULT, 2)
        conf = 4
        if trend in ("UP", "STRONG_UP"):
            conf += 1
        if tf5.get("vol_ratio", 0) >= 1.5:
            conf += 1
        if extension_pct < 0.002:
            conf += 1
        state.orb_fired[symbol] = today
        return ("LONG",
                f"ORB break above {or_high:.2f} (price {price:.2f}, vol {tf5.get('vol_ratio'):.1f}x)",
                sl, tgt, conf)

    # SHORT: break below opening-range low (mirror)
    if orng.get("broke_below") and orng.get("low", 0) > 0:
        or_low = orng["low"]
        extension_pct = (or_low - price) / or_low
        if extension_pct > 0.005:
            return None
        if tf5.get("vol_ratio", 0) < 1.0:
            return None
        sl = round(price + atr * SL_R_MULT, 2)
        tgt = round(price - atr * SL_R_MULT * TGT_R_MULT, 2)
        conf = 4
        if trend in ("DOWN", "STRONG_DOWN"):
            conf += 1
        if tf5.get("vol_ratio", 0) >= 1.5:
            conf += 1
        if extension_pct < 0.002:
            conf += 1
        state.orb_fired[symbol] = today
        return ("SHORT",
                f"ORB break below {or_low:.2f} (price {price:.2f}, vol {tf5.get('vol_ratio'):.1f}x)",
                sl, tgt, conf)

    return None
```

Note: the early `if state.orb_fired.get(symbol) == today: return None` guard at the top of the function stays as-is.

- [ ] **Step 4: Add the trend-pullback short branch**

In `_eval_us_trend_pullback`, replace the block from `# 1h must be UP/STRONG_UP` through the final `return ("LONG", ...)` with:

```python
    trend = tf1h.get("trend")
    rsi = tf5.get("rsi", 50)
    price = tf5.get("price", 0)
    ema20 = tf5.get("ema20", 0)
    atr = tf5.get("atr", 0)
    if price <= 0 or ema20 <= 0 or atr <= 0:
        return None

    # LONG: uptrend + RSI pullback + reclaim of 5m EMA20
    if trend in ("UP", "STRONG_UP") and 35 <= rsi <= 48 and price >= ema20 * 0.998:
        sl = round(price - atr * SL_R_MULT, 2)
        tgt = round(price + atr * SL_R_MULT * TGT_R_MULT, 2)
        conf = 4
        if trend == "STRONG_UP":
            conf += 1
        if tf5.get("vol_ratio", 0) >= 1.2:
            conf += 1
        if 38 <= rsi <= 44:
            conf += 1
        return ("LONG",
                f"Pullback: 1h {trend} + 5m RSI {rsi:.0f} bounce @{price:.2f}",
                sl, tgt, conf)

    # SHORT: downtrend + RSI rally into resistance + rejection at 5m EMA20 (mirror)
    if trend in ("DOWN", "STRONG_DOWN") and 52 <= rsi <= 65 and price <= ema20 * 1.002:
        sl = round(price + atr * SL_R_MULT, 2)
        tgt = round(price - atr * SL_R_MULT * TGT_R_MULT, 2)
        conf = 4
        if trend == "STRONG_DOWN":
            conf += 1
        if tf5.get("vol_ratio", 0) >= 1.2:
            conf += 1
        if 56 <= rsi <= 62:
            conf += 1
        return ("SHORT",
                f"Rally-short: 1h {trend} + 5m RSI {rsi:.0f} rejection @{price:.2f}",
                sl, tgt, conf)

    return None
```

Note: keep the guard at the top of the function that returns None when `tf5`/`tf1h` are empty.

- [ ] **Step 5: Add the mean-reversion short branch**

In `_eval_us_mean_reversion`, replace the block from `# Don't fade strong downtrends` through the final `return ("LONG", ...)` with:

```python
    price = tf5.get("price", 0)
    rsi   = tf5.get("rsi", 50)
    atr   = tf5.get("atr", 0)
    if price <= 0 or atr <= 0:
        return None
    trend = tf1h.get("trend")
    bb_mid = tf5.get("bb_mid", 0)

    # LONG: at lower band, RSI<30, not a strong downtrend
    bb_lo = tf5.get("bb_lo", 0)
    if (trend not in ("STRONG_DOWN", "DOWN") and bb_lo > 0 and rsi < 30
            and price <= bb_lo * 1.005):
        sl = round(price - atr * SL_R_MULT, 2)
        tgt = round(bb_mid, 2) if bb_mid > price else round(price + atr * SL_R_MULT * TGT_R_MULT, 2)
        conf = 4
        if rsi < 25:
            conf += 1
        if trend in ("UP", "STRONG_UP"):
            conf += 1
        if price < bb_lo:
            conf += 1
        return ("LONG",
                f"Mean-rev: 5m @ lower BB {bb_lo:.2f} (RSI {rsi:.0f})",
                sl, tgt, conf)

    # SHORT: at upper band, RSI>70, not a strong uptrend (mirror)
    bb_up = tf5.get("bb_up", 0)
    if (trend not in ("STRONG_UP", "UP") and bb_up > 0 and rsi > 70
            and price >= bb_up * 0.995):
        sl = round(price + atr * SL_R_MULT, 2)
        tgt = round(bb_mid, 2) if bb_mid < price else round(price - atr * SL_R_MULT * TGT_R_MULT, 2)
        conf = 4
        if rsi > 75:
            conf += 1
        if trend in ("DOWN", "STRONG_DOWN"):
            conf += 1
        if price > bb_up:
            conf += 1
        return ("SHORT",
                f"Mean-rev short: 5m @ upper BB {bb_up:.2f} (RSI {rsi:.0f})",
                sl, tgt, conf)

    return None
```

Note: keep the guard at the top of the function that returns None when `tf5`/`tf1h` are empty.

- [ ] **Step 6: Run the full short test file**

Run: `cd D:\TradingApp\backend && .venv\Scripts\python -m pytest tests/test_us_stocks_shorts.py -v`
Expected: PASS (all mechanics + eval tests, ~11 total).

- [ ] **Step 7: Run the US test suites (no regression)**

Run: `cd D:\TradingApp\backend && .venv\Scripts\python -m pytest tests/test_us_stocks_analytics.py tests/test_us_stocks_shorts.py -v`
Expected: PASS. (The broader NSE strategy suite is guarded automatically by the pre-commit hook on every commit.)

- [ ] **Step 8: Commit**

```bash
git add backend/services/us_stocks_bot.py backend/tests/test_us_stocks_shorts.py
git commit -m "feat(us-stocks): symmetric short branches for the 3 strategies"
```

---

## Task 3: Un-gate short setups in the scanner

**Files:**
- Modify: `backend/services/us_scanner.py`
- Test: `backend/tests/test_us_stocks_shorts.py`

- [ ] **Step 1: Add the failing test**

Append to `backend/tests/test_us_stocks_shorts.py`:

```python
def test_scanner_maps_short_setups():
    from backend.services.us_scanner import SETUP_TO_STRATEGY
    assert SETUP_TO_STRATEGY["BREAKDOWN"] == "us_orb"
    assert SETUP_TO_STRATEGY["BEAR_RALLY"] == "us_trend_pullback"
    assert SETUP_TO_STRATEGY["OVERBOUGHT_FADE"] == "us_mean_reversion"
    assert SETUP_TO_STRATEGY["VOLUME_SURGE"] is None   # bias ambiguous, stays unmapped
```

- [ ] **Step 2: Run to verify failure**

Run: `cd D:\TradingApp\backend && .venv\Scripts\python -m pytest tests/test_us_stocks_shorts.py::test_scanner_maps_short_setups -v`
Expected: FAIL — `assert None == 'us_orb'`.

- [ ] **Step 3: Map the short setups**

In `backend/services/us_scanner.py`, replace the short-setup block of `SETUP_TO_STRATEGY`:

```python
    # Short-bias setups: scanner display only in v1 (long-only bots)
    "BREAKDOWN":        None,
    "BREAKDOWN_LOW_VOL": None,
    "GAP_UP_FADE":      None,
    "GAP_DOWN_HOLD":    None,
    "BEAR_RALLY":       None,
    "NEAR_RECENT_LOW":  None,
    "OVERBOUGHT_FADE":  None,
    "VOLUME_SURGE":     None,
```

with:

```python
    # Short-bias setups (bot now trades symmetric shorts, 2026-07-06)
    "BREAKDOWN":         "us_orb",
    "BREAKDOWN_LOW_VOL": "us_orb",
    "GAP_UP_FADE":       "us_orb",
    "GAP_DOWN_HOLD":     "us_orb",
    "BEAR_RALLY":        "us_trend_pullback",
    "NEAR_RECENT_LOW":   "us_trend_pullback",
    "OVERBOUGHT_FADE":   "us_mean_reversion",
    "VOLUME_SURGE":      None,   # bias ambiguous — no clean strategy
```

- [ ] **Step 4: Run to verify pass**

Run: `cd D:\TradingApp\backend && .venv\Scripts\python -m pytest tests/test_us_stocks_shorts.py::test_scanner_maps_short_setups -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/us_scanner.py backend/tests/test_us_stocks_shorts.py
git commit -m "feat(us-stocks): map short scanner setups to bot strategies"
```

---

## Task 4: Un-gate the UI

**Files:**
- Modify: `frontend/src/app/us-stocks/page.tsx`

- [ ] **Step 1: Remove the stale long-only fallback**

In `page.tsx`, find the scanner card's action fallback (the `else` branch of `canStart ? ... : (...)`):

```tsx
                        {!account?.ok ? "Connect Alpaca to trade"
                         : r.bias === "SHORT" ? "SHORT signal · v1 is long-only"
                         : "No matching bot strategy"}
```

Replace with:

```tsx
                        {!account?.ok ? "Connect Alpaca to trade"
                         : "No matching bot strategy"}
```

- [ ] **Step 2: Color the SHORT action badge red in the trades table**

In `page.tsx`, find the trades-table action cell:

```tsx
                      <td style={td}>
                        <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10,
                          fontWeight: 700, color: "#15803d", background: "#dcfce7" }}>{t.action}</span>
                      </td>
```

Replace with:

```tsx
                      <td style={td}>
                        <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10,
                          fontWeight: 700,
                          color: t.action === "SHORT" ? "#b91c1c" : "#15803d",
                          background: t.action === "SHORT" ? "#fee2e2" : "#dcfce7" }}>{t.action}</span>
                      </td>
```

- [ ] **Step 3: Type-check**

Run: `cd D:\TradingApp\frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Visual verification**

Restart the backend (so the new short branches + scanner map load), open `http://localhost:3000/us-stocks`:
- Scanner tab → a SHORT-bias card now shows an enabled red "Start Bot · <strategy>" button (previously "SHORT signal · v1 is long-only").
- Start it; when it fills, the Sessions → trades table shows a red `SHORT` badge with `sl > entry > target`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/us-stocks/page.tsx
git commit -m "feat(us-stocks): enable SHORT start button + red short badge"
```

---

## Task 5: Update code map

**Files:**
- Modify: `C:\Users\Imran\.claude\projects\d--TradingApp\memory\code_map.md`

- [ ] **Step 1: Note the bot is now long+short**

In `code_map.md`, update the `us_stocks.py` router row and/or the US bot note to say the US bot trades **symmetric long+short** (3 strategies, direction from `bot_trades.action`, sign-based exit math), and that short scanner setups map to strategies in `SETUP_TO_STRATEGY`. Bump the "Last updated" date to 2026-07-06.

- [ ] **Step 2: No repo commit needed** — `code_map.md` is a loose memory file outside the repo git tree (confirmed during sub-project B); the edit is saved directly.

---

## Self-Review

**Spec coverage:**
- §1 sign generalization (`_dir_sign`, `_trail_sl`, place/close/manage, re-anchor) → Task 1 ✓
- §2 three mirror short branches → Task 2 ✓
- §3 scanner map + UI un-gate → Tasks 3–4 ✓
- §4 testing (eval short, trail short, manage short exits, place-short, no-regression) → Tasks 1–3 tests ✓
- Out of scope respected: no Alpaca order routing, no regime filter, no pinned direction, no new page/scheduler ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `_dir_sign(action)` used identically in `_trail_sl`, `_close_paper_trade`, `_manage_open_trade`, and `_bot_loop`; `_place_paper_trade` gains `action` as its 3rd positional arg and every caller (only `_bot_loop`) passes it; eval tuples remain `(action, reason, sl, target, conf)` throughout; short invariant `sl > entry > target` asserted consistently.
