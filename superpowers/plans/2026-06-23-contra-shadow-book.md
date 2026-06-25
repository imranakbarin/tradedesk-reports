# Contra Shadow Signal Book Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, fully independent paper-trading book that fires the opposite direction of every *raw* strategy signal (before time-blocks, directional vetoes, or risk gates apply), so the 9 active strategies generate enough contra samples in 2 weeks to judge whether trading the opposite direction has an edge — without touching the existing real-paired contra mechanism (`_place_contra_trade`, `CONTRA_OPEN`/`CONTRA_CLOSED`, `scripts/_contra_analysis.py`) in any way.

**Architecture:** All new logic lives in `backend/services/trading_bot.py`, prefixed `_shadow_*`, grouped in one new section — matching how the existing contra mechanism already lives as plain functions in the same file (no new module, no circular-import risk). A new `shadow_trades` SQLite table keeps shadow data physically separate from `bot_trades`. A module-level queue captures raw signals (including two strategies whose veto happens *inside* `_evaluate_strategy`, before a signal would normally be returned); the bot loop drains the queue and manages shadow exits once per tick, alongside the unrelated real-trade logic that already runs there.

**Tech Stack:** Python 3.11, FastAPI, aiosqlite, pytest + pytest-asyncio (already configured in `backend/pytest.ini`).

---

## Key facts pinned down during investigation (do not re-derive these)

- `_evaluate_strategy(strategy, idx, regime, index_name, intraday) -> tuple[str,str,int] | None` at `backend/services/trading_bot.py:1087`. Returns `(action, reason, confluence)` or `None`. Called from `_try_new_entry` at `trading_bot.py:4294`.
- `_try_new_entry(session_id, index_name, strategy, lot_size, capital, idx, price, regime, intraday)` — function starting at `trading_bot.py:4184`. Line 4294 calls `_evaluate_strategy`; line 4300 unpacks `action, reason, confluence = result`. Everything from line 4306 to line 4619 is a chain of risk/confirmation gates that can `return` before a real trade is placed — but `action` is already known at line 4300, so hooking there captures the *raw* signal regardless of what happens downstream.
- Two strategies compute their would-be direction **inside** `_evaluate_strategy` but never reach line 4300 when vetoed, because the function returns `None` directly:
  - `mtf_sniper` (`trading_bot.py:1197-1233`): a 10:00-12:00 time-block at lines 1213-1218 logs SKIP and leaves `signal = None` — the bull/bear condition check (lines 1220-1226) is never even evaluated inside that window today.
  - `orb_breakout` (`trading_bot.py:1414-1480`): direction is known the instant `live_broke_above`/`live_broke_below` becomes true (lines 1437-1438), but three downstream sub-checks (hold-confirmation, trend_score, VWAP) can still veto before `signal` is set.
- `_place_contra_trade(session_id, real_trade_id, index_name, action, strike, lot_size, strategy)` at `trading_bot.py:3077` — the **existing** mechanism. Not touched by this plan.
- `_dynamic_sl_tgt(strategy, action, idx, intraday, premium, confluence=0, index_name="NIFTY") -> tuple[float, float]` at `trading_bot.py:2097` — reused as-is for shadow SL/target sizing.
- `_fetch_real_premium(index_name, strike, action) -> float | None` (async) at `trading_bot.py:3496` — reused as-is.
- `_shares_per_lot(index_name) -> int` at `trading_bot.py:904`. `_atm_strike(price, step) -> int` at `trading_bot.py:900`. `ITM_STEPS = 1` at `trading_bot.py:677`.
- `_txn_charges(entry_value, exit_value)` — real transaction-cost function, already used by `_close_bot_trade` (`trading_bot.py:3127`). Reused for realistic shadow PnL.
- Real-trade lot sizing/risk-cap formula (`trading_bot.py:2822-2833`): `max_risk = capital * RISK_PER_TRADE_PCT / 100`; `max_lots = max(1, int(max_risk / (sl_pts * shares_per_lot)))`. `RISK_PER_TRADE_PCT = 1.0` at `trading_bot.py:644`. Shadow reuses this formula against its own `SHADOW_CAPITAL` pool.
- `blog(session_id, event, message, symbol="", strategy="", trend_score=None, rsi_15m=None, rsi_5m=None)` — defined in `backend/services/bot_logger.py:92`, imported/wrapped at `trading_bot.py:71`. `event` is free text — `"SHADOW"` is a valid new event type, no schema change needed for `bot_log`.
- `_save_bot_state()` / `_load_bot_state()` at `trading_bot.py:430-464` — JSON sidecar (`db/bot_state.json`) pattern for surviving restarts. Today's keys: `strategy_daily_losses`, `global_daily_pnl`, `global_peak_pnl`, `global_dir_sl_hits`, `mtf_sniper_dir_losses`. This plan adds two more top-level keys, `shadow_strategy_daily_losses` and `shadow_global_daily_pnl`, following the exact same date-prefixed-key / stale-entry-skip pattern.
- `_bot_loop(session_id, index_name, strategy, lot_size, capital)` at `trading_bot.py:3756` — the per-session polling loop (`while True: ... await asyncio.sleep(10)`, line 4181). `_maybe_prune_day_state()` already runs unconditionally every tick (line 3769) — the new `_check_shadow_exits()` call follows that same "runs every tick of every session, internally throttled" pattern. The entry-evaluation call `await _try_new_entry(...)` is at line 4154, inside `if _can_open_new_trade(strategy):` — `_drain_shadow_queue()` is called immediately after it (line 4155), once per tick, so it picks up anything `_try_new_entry`/`_evaluate_strategy` just queued in this same iteration.
- DB schema lives in `backend/db/database.py`. Tables are `CREATE TABLE IF NOT EXISTS` string constants executed in `init_db()` (line 249); new columns are added via a `for col, definition in [...]: try: ALTER TABLE ... except: pass` migration loop (e.g. lines 314-331). This plan follows the same two patterns: one new `CREATE_SHADOW_TRADES` constant, no `ALTER TABLE` needed since it's a brand-new table.
- Test conventions: plain `pytest` functions (no test classes required, though some files use them), async tests use `@pytest.mark.asyncio` (already configured, see `backend/tests/test_broker_adapter.py:15-17`). Tests live in `backend/tests/test_*.py`.
- `docs/` is gitignored (`.gitignore:52`) — this plan file and the spec it implements will not be tracked by git; that's expected and matches the existing specs already in that directory.

---

## File Structure

- **Modify:** `backend/db/database.py` — add `CREATE_SHADOW_TRADES` table + wire into `init_db()`.
- **Modify:** `backend/services/trading_bot.py` — add a new `# ── Contra Shadow Signal Book ──` section (constants, state, queue/dedup, placement, exit management), three small hook edits (mtf_sniper restructure, orb_breakout hook, generic raw-signal hook in `_try_new_entry`), two one-line call sites in `_bot_loop`, two new keys in `_save_bot_state`/`_load_bot_state`.
- **Create:** `scripts/_contra_shadow_analysis.py` — new, standalone reporting script. Does not import or modify `scripts/_contra_analysis.py`.
- **Create:** `backend/tests/test_contra_shadow_book.py` — unit tests for cooldown dedup and lot-sizing math; integration-style test asserting the existing contra mechanism's code path is unaffected.

---

## Task 1: Add the `shadow_trades` table

**Files:**
- Modify: `backend/db/database.py`

- [ ] **Step 1: Add the `CREATE_SHADOW_TRADES` constant**

Find `CREATE_BOT_TRADES` (around line 224) and add this new constant immediately after its closing `"""` (after line 246):

```python
CREATE_SHADOW_TRADES = """
CREATE TABLE IF NOT EXISTS shadow_trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id        TEXT NOT NULL,
    index_name      TEXT NOT NULL,
    strategy        TEXT NOT NULL,
    real_action     TEXT NOT NULL,
    shadow_action   TEXT NOT NULL,
    strike          INTEGER NOT NULL,
    entry_price     REAL NOT NULL,
    sl_price        REAL NOT NULL,
    target_price    REAL NOT NULL,
    current_price   REAL,
    exit_price      REAL,
    lot_size        INTEGER NOT NULL,
    pnl             REAL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'OPEN',
    veto_reason     TEXT,
    placed_at       TEXT NOT NULL,
    closed_at       TEXT,
    r_multiple      REAL,
    hold_minutes    INTEGER
)
"""
```

- [ ] **Step 2: Wire it into `init_db()`**

In `init_db()` (line 249), find this line (line 260):

```python
        await db.execute(CREATE_BOT_TRADES)
```

Add immediately after it:

```python
        await db.execute(CREATE_SHADOW_TRADES)
```

- [ ] **Step 3: Add lookup indexes**

Find the composite-index block for `bot_trades` (lines 337-340, the `for idx_sql in [...]` loop). Add a second loop right after it (after that `for` loop finishes, still inside `init_db`, same indentation level):

```python
        for idx_sql in [
            "CREATE INDEX IF NOT EXISTS idx_shadow_trades_status ON shadow_trades(status)",
            "CREATE INDEX IF NOT EXISTS idx_shadow_trades_strategy ON shadow_trades(strategy, index_name)",
        ]:
            await db.execute(idx_sql)
```

- [ ] **Step 4: Verify the table is created**

Run:
```bash
cd backend && .venv/Scripts/python.exe -c "import asyncio; from backend.db.database import init_db; asyncio.run(init_db())"
```
Then:
```bash
cd backend && .venv/Scripts/python.exe -c "import sqlite3; c=sqlite3.connect('db/trades.sqlite'); print(c.execute(\"SELECT name FROM sqlite_master WHERE type='table' AND name='shadow_trades'\").fetchall())"
```
Expected: `[('shadow_trades',)]`. Run this against `backend/db/trades.sqlite` (the dev copy) only — do not run schema-init scripts against the live `d:\TradingApp\db\trades.sqlite` without confirming with the user first, since `init_db()` is additive/idempotent but touches the live trading DB.

- [ ] **Step 5: Commit**

```bash
git add backend/db/database.py
git commit -m "feat: add shadow_trades table for contra shadow signal book"
```

---

## Task 2: Shadow state, constants, and cooldown-deduped queueing

**Files:**
- Modify: `backend/services/trading_bot.py`
- Test: `backend/tests/test_contra_shadow_book.py`

- [ ] **Step 1: Add the new section's state and constants**

Find `_strategy_daily_losses: dict[str, int] = {}` (line 405) — insert a new section directly **before** it (i.e. before line 405), so it sits alongside the other risk-state declarations:

```python
# ── Contra Shadow Signal Book ──────────────────────────────────────────────
# Separate, additive paper-trading book. Fires the OPPOSITE direction of every
# raw strategy signal (the moment _evaluate_strategy would return one),
# independent of whether the real trade clears downstream gates. Does not
# read or write any state used by the real bot or by the existing
# _place_contra_trade mechanism (CONTRA_OPEN/CONTRA_CLOSED).
SHADOW_CAPITAL = 100_000.0          # ── Dedicated pool, separate from TOTAL_CAPITAL
SHADOW_COOLDOWN_SEC = 20 * 60       # one shadow trade per (strategy, index, action) per 20min

_shadow_queue: list[dict] = []                  # populated by _queue_shadow_signal, drained each tick
_shadow_cooldowns: dict[str, float] = {}        # "{strategy}:{index_name}:{real_action}" -> monotonic ts
_shadow_strategy_daily_losses: dict[str, int] = {}   # informational only, never blocks an entry
_shadow_global_daily_pnl: dict[str, float] = {}      # informational only, never blocks an entry


def _queue_shadow_signal(strategy: str, index_name: str, real_action: str, veto_reason: str) -> None:
    """
    Record that _evaluate_strategy produced (or would have produced) `real_action`
    for `strategy`/`index_name`. The shadow book will trade the OPPOSITE direction.
    Sync and cheap — safe to call from inside _evaluate_strategy (which is sync).
    Actual placement happens later, when _drain_shadow_queue is awaited.
    """
    key = f"{strategy}:{index_name}:{real_action}"
    last = _shadow_cooldowns.get(key, 0.0)
    now = _time_mod.monotonic()
    if now - last < SHADOW_COOLDOWN_SEC:
        return
    _shadow_cooldowns[key] = now
    _shadow_queue.append({
        "strategy": strategy,
        "index_name": index_name,
        "real_action": real_action,
        "veto_reason": veto_reason,
    })
```

- [ ] **Step 2: Write the failing test for cooldown dedup**

Create `backend/tests/test_contra_shadow_book.py`:

```python
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _reset_shadow_state():
    from backend.services import trading_bot as tb
    tb._shadow_queue.clear()
    tb._shadow_cooldowns.clear()


def test_queue_shadow_signal_dedupes_within_cooldown():
    from backend.services import trading_bot as tb
    _reset_shadow_state()
    tb._queue_shadow_signal("candle_pattern", "NIFTY", "PE", "RSI oversold veto")
    tb._queue_shadow_signal("candle_pattern", "NIFTY", "PE", "RSI oversold veto")
    tb._queue_shadow_signal("candle_pattern", "NIFTY", "PE", "RSI oversold veto")
    assert len(tb._shadow_queue) == 1, \
        "Repeated identical raw signals within the cooldown window must dedupe to one queued entry"


def test_queue_shadow_signal_does_not_dedupe_different_keys():
    from backend.services import trading_bot as tb
    _reset_shadow_state()
    tb._queue_shadow_signal("candle_pattern", "NIFTY", "PE", "veto A")
    tb._queue_shadow_signal("candle_pattern", "NIFTY", "CE", "veto B")
    tb._queue_shadow_signal("mtf_sniper", "NIFTY", "PE", "veto C")
    tb._queue_shadow_signal("candle_pattern", "SENSEX", "PE", "veto D")
    assert len(tb._shadow_queue) == 4, \
        "Different strategy/index/action combinations must each get their own queue entry"


def test_queue_shadow_signal_allows_after_cooldown_expires(monkeypatch):
    from backend.services import trading_bot as tb
    _reset_shadow_state()
    fake_now = [1000.0]
    monkeypatch.setattr(tb._time_mod, "monotonic", lambda: fake_now[0])
    tb._queue_shadow_signal("vol_flow", "NIFTY", "CE", "veto A")
    fake_now[0] += tb.SHADOW_COOLDOWN_SEC + 1
    tb._queue_shadow_signal("vol_flow", "NIFTY", "CE", "veto A")
    assert len(tb._shadow_queue) == 2, \
        "Once the cooldown window has elapsed, the same raw signal must be allowed to queue again"
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_contra_shadow_book.py -v`
Expected: 3 passed (the implementation from Step 1 already exists, so these should pass immediately — this confirms the dedup logic is correct, not a red/green TDD cycle for this particular step since the function is simple enough to write directly).

- [ ] **Step 4: Commit**

```bash
git add backend/services/trading_bot.py backend/tests/test_contra_shadow_book.py
git commit -m "feat: add shadow signal queue with per-(strategy,index,action) cooldown dedup"
```

---

## Task 3: Hook the generic raw-signal capture point

This single hook covers 7 of the 9 active strategies (`pdh_pdl_break`, `candle_pattern`, `expiry_theta`, `oi_sr_simple`, `gamma_blast_scalper`, `inst_flow`, `vol_flow`) — every strategy whose signal is returned directly by `_evaluate_strategy` without an internal veto branch.

**Files:**
- Modify: `backend/services/trading_bot.py:4300`

- [ ] **Step 1: Add the hook**

Find this exact code at `trading_bot.py:4300`:

```python
    action, reason, confluence = result
```

Change it to:

```python
    action, reason, confluence = result
    _queue_shadow_signal(strategy, index_name, action, f"raw signal: {reason[:80]}")
```

This fires the instant `_evaluate_strategy` returns a tuple — before any of the gates between here and `_place_bot_trade` (line 4619) run. Whether the real trade ultimately gets placed or vetoed downstream is irrelevant to the shadow book; it already captured the raw direction.

- [ ] **Step 2: Manual smoke check**

Run: `cd backend && .venv/Scripts/python.exe -c "from backend.services import trading_bot"`
Expected: no import errors (confirms no syntax mistake).

- [ ] **Step 3: Commit**

```bash
git add backend/services/trading_bot.py
git commit -m "feat: queue shadow signal at raw _evaluate_strategy output in _try_new_entry"
```

---

## Task 4: Hook mtf_sniper's 10:00-12:00 time-block

**Files:**
- Modify: `backend/services/trading_bot.py:1213-1232`

- [ ] **Step 1: Restructure to compute the would-be signal unconditionally**

Find this exact block (`trading_bot.py:1213-1232`):

```python
        t_now = _now().time()
        if dt_time(10, 0) <= t_now < dt_time(12, 0):
            blog(idx.get("_session_id", ""), "SKIP",
                 "mtf_sniper blocked 10:00-12:00 — optimization loop iter1 found this "
                 "window a robust net loser (27/30 held-out random splits)",
                 symbol=index_name, strategy=strategy)
        else:
            daily_bullish = price > ema50 and trend_score > 70
            daily_bearish = price < ema50 and trend_score < 35
            _sig = None
            if daily_bullish and 45 < rsi < 60 and price > ema20:
                _sig = ("CE", f"Daily uptrend (score {trend_score}) + RSI {rsi:.0f} pullback — sniper entry")
            elif daily_bearish and 38 < rsi < 58 and price < ema20:
                _sig = ("PE", f"Daily downtrend (score {trend_score}) + RSI {rsi:.0f} bounce — sniper entry")
            if _sig:
                last = _mtf_last_signal.get(index_name, 0)
                if _time_mod.monotonic() - last >= MTF_SIGNAL_COOLDOWN_SEC:
                    signal = _sig
                    if not _dry_run_eval:
                        _mtf_last_signal[index_name] = _time_mod.monotonic()
```

Replace it with (the condition checks are unchanged — only moved above the time-block branch so the would-be direction is known either way):

```python
        t_now = _now().time()
        daily_bullish = price > ema50 and trend_score > 70
        daily_bearish = price < ema50 and trend_score < 35
        _sig = None
        if daily_bullish and 45 < rsi < 60 and price > ema20:
            _sig = ("CE", f"Daily uptrend (score {trend_score}) + RSI {rsi:.0f} pullback — sniper entry")
        elif daily_bearish and 38 < rsi < 58 and price < ema20:
            _sig = ("PE", f"Daily downtrend (score {trend_score}) + RSI {rsi:.0f} bounce — sniper entry")

        if dt_time(10, 0) <= t_now < dt_time(12, 0):
            blog(idx.get("_session_id", ""), "SKIP",
                 "mtf_sniper blocked 10:00-12:00 — optimization loop iter1 found this "
                 "window a robust net loser (27/30 held-out random splits)",
                 symbol=index_name, strategy=strategy)
            if _sig:
                _queue_shadow_signal(strategy, index_name, _sig[0],
                                      "raw signal during 10:00-12:00 time-block")
        elif _sig:
            last = _mtf_last_signal.get(index_name, 0)
            if _time_mod.monotonic() - last >= MTF_SIGNAL_COOLDOWN_SEC:
                signal = _sig
                if not _dry_run_eval:
                    _mtf_last_signal[index_name] = _time_mod.monotonic()
```

This changes zero thresholds and zero real-trade behavior: the bull/bear condition check is identical, and `signal` is only ever set in the `elif` branch — exactly as before, outside the 10:00-12:00 window.

- [ ] **Step 2: Manual smoke check**

Run: `cd backend && .venv/Scripts/python.exe -c "from backend.services import trading_bot"`
Expected: no import errors.

- [ ] **Step 3: Write a regression test confirming real mtf_sniper behavior is unchanged**

Add to `backend/tests/test_contra_shadow_book.py`:

```python
def test_mtf_sniper_still_blocked_during_time_window():
    """The time-block must still suppress the real signal -- only the shadow hook is new."""
    from backend.services import trading_bot as tb
    from datetime import datetime, time as dt_time
    import backend.services.trading_bot as tb_mod

    class _FixedNow:
        def time(self):
            return dt_time(10, 30)

    orig_now = tb_mod._now
    tb_mod._now = lambda: datetime(2026, 6, 23, 10, 30)
    try:
        idx = {
            "price": 25100, "rsi": 50, "ema20": 25050, "ema50": 25000,
            "trend_score": 75, "_session_id": "test123",
        }
        result = tb._evaluate_strategy("mtf_sniper", idx, "trending", "NIFTY", None)
        assert result is None, \
            "mtf_sniper must still return None for the real trade during 10:00-12:00"
    finally:
        tb_mod._now = orig_now


def test_mtf_sniper_queues_shadow_signal_during_time_window():
    """The shadow hook must capture the would-be direction even though the real signal is blocked."""
    from backend.services import trading_bot as tb
    import backend.services.trading_bot as tb_mod
    from datetime import datetime

    _reset_shadow_state()
    orig_now = tb_mod._now
    tb_mod._now = lambda: datetime(2026, 6, 23, 10, 30)
    try:
        idx = {
            "price": 25100, "rsi": 50, "ema20": 25050, "ema50": 25000,
            "trend_score": 75, "_session_id": "test123",
        }
        tb._evaluate_strategy("mtf_sniper", idx, "trending", "NIFTY", None)
        assert len(tb._shadow_queue) == 1
        assert tb._shadow_queue[0]["strategy"] == "mtf_sniper"
        assert tb._shadow_queue[0]["real_action"] == "CE"
    finally:
        tb_mod._now = orig_now
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_contra_shadow_book.py -v`
Expected: all passed (5 total so far).

- [ ] **Step 5: Commit**

```bash
git add backend/services/trading_bot.py backend/tests/test_contra_shadow_book.py
git commit -m "feat: surface mtf_sniper's would-be direction to shadow book during 10:00-12:00 block"
```

---

## Task 5: Hook orb_breakout's break-detection point

**Files:**
- Modify: `backend/services/trading_bot.py:1445,1463`

- [ ] **Step 1: Queue the shadow signal at the moment a break is detected**

Find this exact line at `trading_bot.py:1445`:

```python
                if live_broke_above:
```

Change it to:

```python
                if live_broke_above:
                    _queue_shadow_signal(strategy, index_name, "CE", "ORB break above OR high (pre-confirmation)")
```

Find this exact line at `trading_bot.py:1463`:

```python
                elif live_broke_below:
```

Change it to:

```python
                elif live_broke_below:
                    _queue_shadow_signal(strategy, index_name, "PE", "ORB break below OR low (pre-confirmation)")
```

This queues a shadow signal the instant price breaks the opening-range level — before the hold-confirmation timer, trend_score gate, or VWAP gate (all of which can still veto the real trade) ever run. One queue call per branch entry; the cooldown dedup in `_queue_shadow_signal` already prevents this from flooding the queue across consecutive ticks while price stays beyond the level.

- [ ] **Step 2: Manual smoke check**

Run: `cd backend && .venv/Scripts/python.exe -c "from backend.services import trading_bot"`
Expected: no import errors.

- [ ] **Step 3: Commit**

```bash
git add backend/services/trading_bot.py
git commit -m "feat: queue shadow signal at orb_breakout break-detection, before confirmation gates"
```

---

## Task 6: Shadow trade placement

**Files:**
- Modify: `backend/services/trading_bot.py`
- Test: `backend/tests/test_contra_shadow_book.py`

- [ ] **Step 1: Add `_shadow_lot_size` (mirrors the real risk-cap formula at line 2822-2833)**

Add this function in the Contra Shadow Signal Book section (after `_queue_shadow_signal`, defined in Task 2):

```python
def _shadow_lot_size(sl_pts: float, index_name: str) -> int:
    """Risk-caps shadow lot size against SHADOW_CAPITAL, same formula as the real
    bot's risk-per-trade cap (trading_bot.py:2822-2833), but against the
    dedicated shadow pool instead of TOTAL_CAPITAL."""
    spl = _shares_per_lot(index_name)
    max_risk = SHADOW_CAPITAL * RISK_PER_TRADE_PCT / 100
    return max(1, int(max_risk / (sl_pts * spl)))
```

- [ ] **Step 2: Write the failing test for lot sizing**

Add to `backend/tests/test_contra_shadow_book.py`:

```python
def test_shadow_lot_size_caps_to_one_pct_risk():
    from backend.services import trading_bot as tb
    # SHADOW_CAPITAL=100,000, risk 1% = 1,000. NIFTY spl=65. sl_pts=20 -> max_risk/(sl*spl) = 1000/(20*65) = 0.77 -> floor 1 (min)
    assert tb._shadow_lot_size(sl_pts=20, index_name="NIFTY") == 1
    # sl_pts=2 -> 1000/(2*65) = 7.6 -> 7
    assert tb._shadow_lot_size(sl_pts=2, index_name="NIFTY") == 7
```

- [ ] **Step 3: Run the test**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_contra_shadow_book.py::test_shadow_lot_size_caps_to_one_pct_risk -v`
Expected: PASS.

- [ ] **Step 4: Add `_place_shadow_trade`**

Add directly after `_shadow_lot_size`:

```python
async def _place_shadow_trade(strategy: str, index_name: str, real_action: str, veto_reason: str) -> None:
    """
    Places a standalone shadow trade in the OPPOSITE direction of real_action.
    Independent of any real trade's lifecycle -- most shadow trades have no
    real trade to pair with (that's the entire point: candle_pattern and
    mtf_sniper produce raw signals that rarely survive to a real entry).
    No capital/risk blocking -- SHADOW_CAPITAL sizing is informational only.
    """
    shadow_action = "PE" if real_action == "CE" else "CE"

    try:
        from backend.services.market_intelligence import get_indices
        indices = await get_indices()
        idx = _get_idx_data(indices, index_name)
        price = idx.get("price", 0) if idx else 0
    except Exception:
        price = 0
    if price <= 0:
        return

    step = 50 if index_name == "NIFTY" else 100
    atm = _atm_strike(price, step)
    strike = atm - ITM_STEPS * step if shadow_action == "CE" else atm + ITM_STEPS * step

    premium = await _fetch_real_premium(index_name, strike, shadow_action)
    if not premium or premium <= 0:
        return

    sl_pts, tgt_pts = _dynamic_sl_tgt(strategy, shadow_action, {}, None, premium, 1, index_name)
    lot_size = _shadow_lot_size(sl_pts, index_name)
    sl_price = round(max(premium - sl_pts, premium * 0.10), 2)
    tgt_price = round(premium + tgt_pts, 2)

    trade_id = str(uuid.uuid4())[:8]
    now = _now().isoformat()
    try:
        async with aiosqlite.connect(_settings.sqlite_path, timeout=10) as db:
            await db.execute("""
                INSERT INTO shadow_trades
                    (trade_id, index_name, strategy, real_action, shadow_action,
                     strike, entry_price, sl_price, target_price, current_price,
                     lot_size, status, veto_reason, placed_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,'OPEN',?,?)
            """, (trade_id, index_name, strategy, real_action, shadow_action,
                  strike, premium, sl_price, tgt_price, premium,
                  lot_size, veto_reason, now))
            await db.commit()
        blog("", "SHADOW", f"Shadow {shadow_action} {index_name} @ ₹{premium:.0f} "
             f"(real would-be {real_action} — {veto_reason})",
             symbol=index_name, strategy=strategy)
    except Exception as e:
        logger.debug(f"SHADOW insert failed: {e}")
```

- [ ] **Step 5: Add `_drain_shadow_queue`**

Add directly after `_place_shadow_trade`:

```python
async def _drain_shadow_queue() -> None:
    """Called once per _bot_loop tick. Pops everything _queue_shadow_signal
    queued this cycle and places a shadow trade for each."""
    global _shadow_queue
    if not _shadow_queue:
        return
    pending, _shadow_queue = _shadow_queue, []
    for item in pending:
        await _place_shadow_trade(
            item["strategy"], item["index_name"], item["real_action"], item["veto_reason"])
```

- [ ] **Step 6: Manual smoke check**

Run: `cd backend && .venv/Scripts/python.exe -c "from backend.services import trading_bot"`
Expected: no import errors.

- [ ] **Step 7: Commit**

```bash
git add backend/services/trading_bot.py backend/tests/test_contra_shadow_book.py
git commit -m "feat: add shadow trade placement and queue drain, sized against SHADOW_CAPITAL"
```

---

## Task 7: Shadow exit management

**Files:**
- Modify: `backend/services/trading_bot.py`

- [ ] **Step 1: Add `_check_shadow_exits`**

Add directly after `_drain_shadow_queue`:

```python
_shadow_exit_last_check = 0.0
SHADOW_EXIT_CHECK_INTERVAL_SEC = 10   # throttle: this runs from every session's tick

async def _check_shadow_exits() -> None:
    """
    Manages SL/target/EOD exits for all OPEN shadow trades, across every
    strategy and index. Runs independently of any real trade's lifecycle --
    unlike the existing contra mechanism (which mirrors its paired real
    trade's close), most shadow trades have no real trade to mirror.
    Throttled to once every SHADOW_EXIT_CHECK_INTERVAL_SEC even though it's
    called from every active session's loop tick.
    """
    global _shadow_exit_last_check
    now_mono = _time_mod.monotonic()
    if now_mono - _shadow_exit_last_check < SHADOW_EXIT_CHECK_INTERVAL_SEC:
        return
    _shadow_exit_last_check = now_mono

    try:
        async with aiosqlite.connect(_settings.sqlite_path, timeout=10) as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM shadow_trades WHERE status='OPEN'")
            rows = [dict(r) for r in await cur.fetchall()]
    except Exception as e:
        logger.debug(f"SHADOW exit-check query failed: {e}")
        return

    eod = _should_force_close()
    for row in rows:
        try:
            premium = await _fetch_real_premium(row["index_name"], row["strike"], row["shadow_action"])
            if not premium or premium <= 0:
                continue

            status = None
            if premium <= row["sl_price"]:
                status = "SL_HIT"
            elif premium >= row["target_price"]:
                status = "TARGET_HIT"
            elif eod:
                status = "EOD_CLOSE"

            if status:
                await _close_shadow_trade(row, premium, status)
        except Exception as e:
            logger.debug(f"SHADOW exit-check trade {row.get('trade_id')} failed: {e}")


async def _close_shadow_trade(trade: dict, exit_price: float, status: str) -> None:
    entry = trade["entry_price"]
    lot_size = trade["lot_size"]
    spl = _shares_per_lot(trade["index_name"])
    qty = lot_size * spl
    charges = _txn_charges(entry * qty, exit_price * qty)
    pnl = round((exit_price - entry) * qty - charges, 2)

    sl_pts = max(entry - trade["sl_price"], 0.01)
    max_risk = sl_pts * qty
    r_multiple = round(pnl / max_risk, 2) if max_risk > 0 else 0.0

    now = _now().isoformat()
    try:
        hold_minutes = int((_now() - datetime.fromisoformat(trade["placed_at"])).total_seconds() / 60)
    except Exception:
        hold_minutes = 0

    async with aiosqlite.connect(_settings.sqlite_path, timeout=10) as db:
        await db.execute("""
            UPDATE shadow_trades SET current_price=?, exit_price=?, pnl=?, status=?,
                closed_at=?, r_multiple=?, hold_minutes=?
            WHERE trade_id=?
        """, (exit_price, exit_price, pnl, status, now, r_multiple, hold_minutes, trade["trade_id"]))
        await db.commit()

    # Informational-only counters -- never block a future shadow entry.
    today = _now().date().isoformat()
    if pnl < 0:
        key = f"{today}:{trade['strategy']}"
        _shadow_strategy_daily_losses[key] = _shadow_strategy_daily_losses.get(key, 0) + 1
    _shadow_global_daily_pnl[today] = _shadow_global_daily_pnl.get(today, 0.0) + pnl
    _save_bot_state()

    blog("", "SHADOW", f"Shadow {trade['shadow_action']} {trade['index_name']} closed @ ₹{exit_price:.0f} "
         f"({status}) pnl={pnl:+.0f}", symbol=trade["index_name"], strategy=trade["strategy"])
```

- [ ] **Step 2: Manual smoke check**

Run: `cd backend && .venv/Scripts/python.exe -c "from backend.services import trading_bot"`
Expected: no import errors.

- [ ] **Step 3: Commit**

```bash
git add backend/services/trading_bot.py
git commit -m "feat: add shadow trade exit management (SL/target/EOD), independent of real trade lifecycle"
```

---

## Task 8: Wire drain + exit-check into the bot loop

**Files:**
- Modify: `backend/services/trading_bot.py:3769,4154-4155`

- [ ] **Step 1: Add the exit-check call near the top of the loop**

Find this exact line at `trading_bot.py:3769`:

```python
            _maybe_prune_day_state()   # cheap when no rollover; clears stale day-keyed dicts
```

Add immediately after it:

```python
            await _check_shadow_exits()   # internally throttled; runs from every session's tick
```

- [ ] **Step 2: Add the drain call after entry evaluation**

Find this exact code at `trading_bot.py:4153-4155`:

```python
                if _can_open_new_trade(strategy):
                    await _try_new_entry(session_id, index_name, strategy, lot_size,
                                         capital, idx, price, regime, intraday)
```

Change it to:

```python
                if _can_open_new_trade(strategy):
                    await _try_new_entry(session_id, index_name, strategy, lot_size,
                                         capital, idx, price, regime, intraday)
                    await _drain_shadow_queue()
```

- [ ] **Step 3: Manual smoke check**

Run: `cd backend && .venv/Scripts/python.exe -c "from backend.services import trading_bot"`
Expected: no import errors.

- [ ] **Step 4: Commit**

```bash
git add backend/services/trading_bot.py
git commit -m "feat: wire shadow queue drain and exit checks into the bot loop"
```

---

## Task 9: Persist shadow counters across restarts

**Files:**
- Modify: `backend/services/trading_bot.py:430-464`

- [ ] **Step 1: Extend `_save_bot_state`**

Find this exact code at `trading_bot.py:430-440`:

```python
def _save_bot_state():
    try:
        _BOT_STATE_PATH.write_text(_json.dumps({
            "strategy_daily_losses": _strategy_daily_losses,
            "global_daily_pnl":      _global_daily_pnl,
            "global_peak_pnl":       _global_peak_pnl,
            "global_dir_sl_hits":    _global_dir_sl_hits,
            "mtf_sniper_dir_losses": _mtf_sniper_dir_losses,
        }), encoding="utf-8")
    except Exception:
        pass
```

Change it to:

```python
def _save_bot_state():
    try:
        _BOT_STATE_PATH.write_text(_json.dumps({
            "strategy_daily_losses": _strategy_daily_losses,
            "global_daily_pnl":      _global_daily_pnl,
            "global_peak_pnl":       _global_peak_pnl,
            "global_dir_sl_hits":    _global_dir_sl_hits,
            "mtf_sniper_dir_losses": _mtf_sniper_dir_losses,
            "shadow_strategy_daily_losses": _shadow_strategy_daily_losses,
            "shadow_global_daily_pnl":      _shadow_global_daily_pnl,
        }), encoding="utf-8")
    except Exception:
        pass
```

- [ ] **Step 2: Extend `_load_bot_state`**

Find this exact code at `trading_bot.py:442-464`:

```python
def _load_bot_state():
    """Restore today's intraday counters from disk. Stale (yesterday's) entries skipped."""
    if not _BOT_STATE_PATH.exists():
        return
    try:
        state = _json.loads(_BOT_STATE_PATH.read_text(encoding="utf-8"))
        today = _now().date().isoformat()
        for k, v in state.get("strategy_daily_losses", {}).items():
            if k.startswith(today):
                _strategy_daily_losses[k] = v
        for k, v in state.get("global_daily_pnl", {}).items():
            if k == today:
                _global_daily_pnl[k] = v
        for k, v in state.get("global_peak_pnl", {}).items():
            if k == today:
                _global_peak_pnl[k] = v
        for k, v in state.get("global_dir_sl_hits", {}).items():
            if k.startswith(today):
                _global_dir_sl_hits[k] = v
        for k, v in state.get("mtf_sniper_dir_losses", {}).items():
            if k.startswith(today):
                _mtf_sniper_dir_losses[k] = v
    except Exception:
```

Add these two blocks right before the closing `except Exception:` line (i.e. as the last two loops inside the `try`):

```python
        for k, v in state.get("shadow_strategy_daily_losses", {}).items():
            if k.startswith(today):
                _shadow_strategy_daily_losses[k] = v
        for k, v in state.get("shadow_global_daily_pnl", {}).items():
            if k == today:
                _shadow_global_daily_pnl[k] = v
    except Exception:
```

(Note: this replaces the original lone `except Exception:` line with the same line after the two new loops — net effect is just inserting the two loops before it.)

- [ ] **Step 2: Manual smoke check**

Run: `cd backend && .venv/Scripts/python.exe -c "from backend.services import trading_bot"`
Expected: no import errors.

- [ ] **Step 3: Commit**

```bash
git add backend/services/trading_bot.py
git commit -m "feat: persist shadow daily-loss/pnl counters in db/bot_state.json"
```

---

## Task 10: Reporting script

**Files:**
- Create: `scripts/_contra_shadow_analysis.py`

- [ ] **Step 1: Write the script**

```python
"""
Contra Shadow Signal Book analysis -- reports the NEW shadow mechanism only.

Does NOT read or modify anything used by scripts/_contra_analysis.py (which
reports on the existing real-paired contra mechanism). The two are kept
fully separate, per the 2026-06-23 design spec.

Usage:
    python scripts/_contra_shadow_analysis.py [--days N]
"""
import argparse
import sqlite3
from pathlib import Path

ROOT = Path(__file__).parent.parent
DB = ROOT / "db" / "trades.sqlite"


def load_shadow_trades(days: int) -> list[dict]:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    cur = conn.execute("""
        SELECT * FROM shadow_trades
        WHERE status != 'OPEN'
          AND placed_at >= datetime('now', ?)
        ORDER BY placed_at
    """, (f"-{days} days",))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def report(days: int) -> None:
    rows = load_shadow_trades(days)
    if not rows:
        print(f"No closed shadow trades in the last {days} day(s).")
        return

    by_strategy: dict[str, list[dict]] = {}
    for r in rows:
        by_strategy.setdefault(r["strategy"], []).append(r)

    print(f"=== Contra Shadow Signal Book — last {days} day(s) ===")
    print(f"Shadow capital pool: Rs.1,00,000 (separate from real bot's TOTAL_CAPITAL)\n")

    total_pnl = 0.0
    total_trades = 0
    total_wins = 0

    for strategy, trades in sorted(by_strategy.items()):
        wins = sum(1 for t in trades if t["pnl"] and t["pnl"] > 0)
        pnl = sum(t["pnl"] or 0 for t in trades)
        n = len(trades)
        wr = (wins / n * 100) if n else 0
        total_pnl += pnl
        total_trades += n
        total_wins += wins
        print(f"{strategy:28s} n={n:4d}  WR={wr:5.1f}%  PnL=Rs.{pnl:+10,.0f}  "
              f"return_on_pool={pnl / 100_000 * 100:+.2f}%")

    overall_wr = (total_wins / total_trades * 100) if total_trades else 0
    print(f"\n{'TOTAL':28s} n={total_trades:4d}  WR={overall_wr:5.1f}%  "
          f"PnL=Rs.{total_pnl:+10,.0f}  return_on_pool={total_pnl / 100_000 * 100:+.2f}%")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=14)
    args = parser.parse_args()
    report(args.days)
```

- [ ] **Step 2: Smoke-test the script against the dev DB**

Run: `cd backend && .venv/Scripts/python.exe ../scripts/_contra_shadow_analysis.py --days 14`
Expected: `No closed shadow trades in the last 14 day(s).` (table is empty until the bot has run with this code live).

- [ ] **Step 3: Commit**

```bash
git add scripts/_contra_shadow_analysis.py
git commit -m "feat: add standalone reporting script for contra shadow signal book"
```

---

## Task 11: Verify the existing contra mechanism is untouched

**Files:**
- Test: `backend/tests/test_contra_shadow_book.py`

- [ ] **Step 1: Write a regression test asserting `_place_contra_trade` is unmodified**

Add to `backend/tests/test_contra_shadow_book.py`:

```python
def test_existing_contra_mechanism_unaffected_by_shadow_book():
    """
    Guards against accidental coupling: _place_contra_trade must not reference
    any _shadow_* state, and vice versa. If this test ever needs to change,
    that's a sign the two mechanisms have stopped being independent.
    """
    import inspect
    from backend.services import trading_bot as tb

    contra_src = inspect.getsource(tb._place_contra_trade)
    assert "_shadow" not in contra_src, \
        "_place_contra_trade must not reference any shadow-book state"

    shadow_src = inspect.getsource(tb._place_shadow_trade) + inspect.getsource(tb._drain_shadow_queue)
    assert "_place_contra_trade" not in shadow_src, \
        "Shadow book must not call into the existing contra mechanism"
    assert "CONTRA_OPEN" not in shadow_src and "CONTRA_CLOSED" not in shadow_src, \
        "Shadow book must use its own shadow_trades table/statuses, not bot_trades CONTRA_* statuses"
```

- [ ] **Step 2: Run the full new test file**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_contra_shadow_book.py -v`
Expected: all tests pass (8 total).

- [ ] **Step 3: Run the full existing test suite to confirm no regressions**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -v`
Expected: all previously-passing tests still pass; no new failures introduced by this plan's edits to `trading_bot.py`.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/test_contra_shadow_book.py
git commit -m "test: verify contra shadow book is fully independent of existing contra mechanism"
```

---

## Task 12: Update code_map.md

**Files:**
- Modify: `C:\Users\Imran\.claude\projects\d--TradingApp\memory\code_map.md`

- [ ] **Step 1: Add the new table, script, and trading_bot.py section to the code map**

Per `CLAUDE.md`'s "After any structural change — update `code_map.md` immediately" rule: add an entry noting the `shadow_trades` table (in `backend/db/database.py`), the new `# ── Contra Shadow Signal Book ──` section in `backend/services/trading_bot.py` (constants `SHADOW_CAPITAL`/`SHADOW_COOLDOWN_SEC`, functions `_queue_shadow_signal`/`_place_shadow_trade`/`_drain_shadow_queue`/`_check_shadow_exits`/`_close_shadow_trade`), and `scripts/_contra_shadow_analysis.py`. Read the current file first to match its existing format before editing.

- [ ] **Step 2: Commit** (memory files are outside the git repo — no git commit needed for this step; just save the file.)

---

## Self-review notes

- **Spec coverage:** Background/Goal/Non-goals — satisfied (no changes to `_place_contra_trade`, `_contra_analysis.py`, real bot thresholds, or disabled strategies; Task 11 enforces this with a guard test). Hook point — satisfied (Tasks 3-5 cover all 9 active strategies: 7 via the generic hook, 2 via dedicated hooks for mtf_sniper/orb_breakout). Cooldown — satisfied (Task 2, 20min default). Capital/risk tracking — satisfied (Task 6's `_shadow_lot_size`, Task 9's persistence). Independent exit — satisfied (Task 7, no mirroring). Reporting — satisfied (Task 10, fully separate script). Testing section of the spec — satisfied (Tasks 2/4/6/11).
- **Placeholder scan:** none — every step has complete, exact code and file/line targets pulled directly from the current state of `trading_bot.py` and `database.py`.
- **Known limitation, not a defect:** `_try_new_entry` (and therefore both shadow hooks inside it and the generic hook at line 4300) only runs when a session has no real trade currently open (`_bot_loop:3911-3913`) and when `_can_open_new_trade(strategy)` allows it. Shadow sampling pauses during those windows too — but this is still a strict improvement over the existing 1:1 contra mechanism, which only samples when a real trade is *placed* (a strictly smaller set of ticks).
