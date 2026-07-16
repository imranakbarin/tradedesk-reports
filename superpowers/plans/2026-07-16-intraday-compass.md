# Intraday Compass + vol_flow Prune Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prune the edgeless vol_flow strategy and replace the stale daily `trend_score` with a new `intraday_trend_score` in the intraday entry gates (ORB, inside-bar, PDH/PDL, mtf_sniper confirm, daily-bias override), so PE entries become reachable on down days.

**Architecture:** One new pure function `intraday_trend_score(idx, intraday)` in `backend/services/trading_bot.py`, computed from per-cycle intraday data already fetched (`intraday_signals.py` output). Five gate sites switch from `trend_score` (daily) to the new score. One additive DB column records the score at entry for weekly-review validation. Spec: `docs/superpowers/specs/2026-07-16-intraday-compass-design.md`.

**Tech Stack:** Python 3.11, FastAPI service code, aiosqlite, pytest. Backend venv at `backend/.venv`.

**Conventions for every task:**
- Run tests from repo root with: `backend/.venv/Scripts/python.exe -m pytest backend/tests/<file> -v`
  (tests add `backend/` to `sys.path` themselves via the existing conftest pattern).
- Line numbers reference commit `9c74fab2`; verify with the quoted `old` code before editing — if it doesn't match exactly, search for the quoted string.
- All commits go to the **root repo** (`d:\TradingApp`), branch `master`. Do NOT push.
- After the final task, run the full suite: `backend/.venv/Scripts/python.exe -m pytest backend/tests/ -q`

---

### Task 1: `intraday_trend_score` function (TDD)

**Files:**
- Test: `backend/tests/test_intraday_score.py` (create)
- Modify: `backend/services/trading_bot.py` (add function directly below `_get_or_set_daily_bias`, i.e. after line ~367)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_intraday_score.py`:

```python
"""
Tests for intraday_trend_score — the intraday compass that replaced the daily
trend_score in intraday entry gates (2026-07-16, see
docs/superpowers/specs/2026-07-16-intraday-compass-design.md).

Six equal-weight signals; missing input contributes 0.5 (neutral).
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.trading_bot import intraday_trend_score


def _idx(price=24000.0, day_open=23900.0):
    return {"price": price, "day_open": day_open}


def _intraday(st5="LONG", st15="LONG", rsi15=60.0, vwap_pos="ABOVE",
              p15=24000.0, ema21=23900.0):
    return {
        "5m":  {"supertrend": st5, "vwap_pos": vwap_pos},
        "15m": {"supertrend": st15, "rsi": rsi15, "price": p15, "ema21": ema21},
    }


def test_all_bullish_is_100():
    # price 24000 > day_open 23900, both ST LONG, RSI 60>50, ABOVE vwap, p15>ema21
    assert intraday_trend_score(_idx(), _intraday()) == 100


def test_all_bearish_is_0():
    idx = _idx(price=23800.0, day_open=23900.0)
    itd = _intraday(st5="SHORT", st15="SHORT", rsi15=40.0, vwap_pos="BELOW",
                    p15=23800.0, ema21=23900.0)
    assert intraday_trend_score(idx, itd) == 0


def test_none_intraday_is_50():
    assert intraday_trend_score(_idx(), None) == 50
    assert intraday_trend_score(_idx(), {}) == 50


def test_missing_15m_block_contributes_neutral():
    # 15m missing -> st15, rsi15, ema21 signals each contribute 0.5.
    # Remaining bullish: st5 LONG=1, vwap ABOVE=1, price>open=1.
    # score = (1+1+1 + 0.5*3)/6*100 = 75
    itd = {"5m": {"supertrend": "LONG", "vwap_pos": "ABOVE"}}
    assert intraday_trend_score(_idx(), itd) == 75


def test_missing_day_open_contributes_neutral():
    # day_open=0 -> price-vs-open neutral; everything else bullish.
    # score = (5 + 0.5)/6*100 = 92
    assert intraday_trend_score(_idx(day_open=0), _intraday()) == 92


def test_mixed_signals():
    # bull: st5 LONG, vwap ABOVE, price>open (3) · bear: st15 SHORT, rsi 40, p15<ema21 (0)
    itd = _intraday(st15="SHORT", rsi15=40.0, p15=23800.0, ema21=23900.0)
    assert intraday_trend_score(_idx(), itd) == 50
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests/test_intraday_score.py -v`
Expected: FAIL — `ImportError: cannot import name 'intraday_trend_score'`

- [ ] **Step 3: Implement the function**

In `backend/services/trading_bot.py`, insert directly after the `_get_or_set_daily_bias` function body (after line ~367, before the `# ── Pre-window signal staleness tracker` comment):

```python
def intraday_trend_score(idx: dict, intraday: dict | None) -> int:
    """
    0-100 intraday trend compass (2026-07-16). Replaces the DAILY trend_score in
    intraday entry gates — the daily score (EMA20/50/200 on daily candles) stays
    bullish for weeks after a top, which force-fed CE entries through early July
    (29/34 trades CE, index moved against 20/30). Six equal-weight signals from
    per-cycle intraday data; a missing input contributes 0.5 (neutral), so the
    score degrades toward 50, never crashes. Spec:
    docs/superpowers/specs/2026-07-16-intraday-compass-design.md
    """
    if not intraday:
        return 50
    tf5  = intraday.get("5m")  or {}
    tf15 = intraday.get("15m") or {}
    price    = idx.get("price") or 0
    day_open = idx.get("day_open") or 0
    st5    = tf5.get("supertrend") or ""
    st15   = tf15.get("supertrend") or ""
    rsi15  = tf15.get("rsi")
    vwapp  = tf5.get("vwap_pos") or ""
    p15    = tf15.get("price") or 0
    ema21  = tf15.get("ema21") or 0
    signals = [
        0.5 if st5   not in ("LONG", "SHORT")   else float(st5 == "LONG"),
        0.5 if st15  not in ("LONG", "SHORT")   else float(st15 == "LONG"),
        0.5 if rsi15 is None                    else float(rsi15 > 50),
        0.5 if vwapp not in ("ABOVE", "BELOW")  else float(vwapp == "ABOVE"),
        0.5 if not (price > 0 and day_open > 0) else float(price > day_open),
        0.5 if not (p15 > 0 and ema21 > 0)      else float(p15 > ema21),
    ]
    return round(sum(signals) / 6 * 100)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests/test_intraday_score.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add backend/tests/test_intraday_score.py backend/services/trading_bot.py
git commit -m "feat(bot): intraday_trend_score — 6-signal intraday compass

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Rewire strategy gates (PDH/PDL, ORB main, inside-bar, mtf_sniper)

**Files:**
- Modify: `backend/services/trading_bot.py` (inside `_evaluate_strategy`)
- Test: `backend/tests/test_intraday_score.py` (append gate tests)

- [ ] **Step 1: Write the failing gate tests**

Append to `backend/tests/test_intraday_score.py`:

```python
# ── Gate rewiring tests ───────────────────────────────────────────────────────
# PDH/PDL is the cleanest strategy to test the swap through: no time-of-day gate,
# no monotonic hold state. The scenario that motivated the change: daily
# trend_score 70 (stale bull) on an intraday red day must now allow PE.
from services import trading_bot as tb


def _pdl_idx():
    # price broke below PDL 23900; opened above it; daily score stale-bullish 70
    return {
        "price": 23880.0, "day_open": 23950.0, "prev_close": 24000.0,
        "day_high": 23990.0, "day_low": 23870.0, "atr": 100.0,
        "trend_score": 70, "rsi": 45.0, "ema20": 24000.0, "ema50": 24000.0,
        "supertrend": "SHORT", "options_rec": {}, "smc": {}, "bb_pct": 40,
        "_session_id": "test",
    }


def _bear_intraday():
    return _intraday(st5="SHORT", st15="SHORT", rsi15=40.0, vwap_pos="BELOW",
                     p15=23880.0, ema21=23950.0)


def test_pdl_pe_fires_when_intraday_bearish_despite_bullish_daily_score(monkeypatch):
    monkeypatch.setattr(tb, "_get_prev_day_hilo", lambda name: (24100.0, 23900.0))
    result = tb._evaluate_strategy("pdh_pdl_break", _pdl_idx(), "trending",
                                   "NIFTY", _bear_intraday())
    assert result is not None and result[0] == "PE"


def test_pdl_pe_blocked_when_intraday_bullish(monkeypatch):
    monkeypatch.setattr(tb, "_get_prev_day_hilo", lambda name: (24100.0, 23900.0))
    idx = _pdl_idx()
    idx["trend_score"] = 30  # daily says bear — must no longer matter
    bull_itd = _intraday(vwap_pos="BELOW")  # score 67 (>45) → PE blocked
    result = tb._evaluate_strategy("pdh_pdl_break", idx, "trending", "NIFTY", bull_itd)
    assert result is None


def test_pdh_ce_blocked_when_intraday_bearish(monkeypatch):
    monkeypatch.setattr(tb, "_get_prev_day_hilo", lambda name: (23850.0, 23700.0))
    idx = _pdl_idx()
    idx.update({"price": 23860.0, "day_open": 23800.0, "trend_score": 70})
    itd = _bear_intraday()
    itd["5m"]["vwap_pos"] = "ABOVE"  # pass VWAP gate; score gate must still block
    result = tb._evaluate_strategy("pdh_pdl_break", idx, "trending", "NIFTY", itd)
    assert result is None
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests/test_intraday_score.py -v`
Expected: `test_pdl_pe_fires_when_intraday_bearish_despite_bullish_daily_score` FAILS (returns None — daily ts 70 blocks PE today); the two "blocked" tests may already pass.

- [ ] **Step 3: Compute the score once in `_evaluate_strategy`**

At line ~1234 (`trend_score = idx.get("trend_score", 50)`), add directly below:

```python
    trend_score = idx.get("trend_score", 50)
    i_score = intraday_trend_score(idx, intraday)  # intraday compass — gates below use this, not the daily score
```

- [ ] **Step 4: Swap the five gate sites**

All in `_evaluate_strategy`. Old strings are exact at `9c74fab2`.

**4a — PDH CE (~line 1285):**
```python
# old
                elif trend_score < 52:
                    blog(idx.get("_session_id", ""), "SKIP",
                         f"PDH CE blocked: trend_score {trend_score:.0f} — ranging/choppy day, no breakout edge",
# new
                elif i_score < 55:
                    blog(idx.get("_session_id", ""), "SKIP",
                         f"PDH CE blocked: intraday score {i_score} (daily ts {trend_score:.0f}) — no intraday breakout edge",
```

**4b — PDL PE (~line 1302):**
```python
# old
                elif trend_score > 48:
                    blog(idx.get("_session_id", ""), "SKIP",
                         f"PDL PE blocked: trend_score {trend_score:.0f} — ranging/choppy day, no breakdown edge",
# new
                elif i_score > 45:
                    blog(idx.get("_session_id", ""), "SKIP",
                         f"PDL PE blocked: intraday score {i_score} (daily ts {trend_score:.0f}) — no intraday breakdown edge",
```

**4c — mtf_sniper (~lines 1334-1337) — daily thesis kept, intraday confirm added:**
```python
# old
        if daily_bullish and 45 < rsi < 60 and price > ema20:
            _sig = ("CE", f"Daily uptrend (score {trend_score}) + RSI {rsi:.0f} pullback — sniper entry")
        elif daily_bearish and 38 < rsi < 58 and price < ema20:
            _sig = ("PE", f"Daily downtrend (score {trend_score}) + RSI {rsi:.0f} bounce — sniper entry")
# new
        if daily_bullish and 45 < rsi < 60 and price > ema20 and i_score >= 55:
            _sig = ("CE", f"Daily uptrend (score {trend_score}) + RSI {rsi:.0f} pullback — sniper entry (intraday {i_score})")
        elif daily_bearish and 38 < rsi < 58 and price < ema20 and i_score <= 45:
            _sig = ("PE", f"Daily downtrend (score {trend_score}) + RSI {rsi:.0f} bounce — sniper entry (intraday {i_score})")
```

**4d — inside-bar ORB (~lines 1394-1403):**
```python
# old
                if (orng.get("broke_above") and or_high > 0
                        and price - or_high <= or_high * CP_STALE_PCT
                        and trend_score >= 52
                        and (not vwap_pos_5m or vwap_pos_5m == "ABOVE")):
                    signal = ("CE", f"Inside-bar breakout — 5m close above OR high {or_high:,.0f} (first 3 candles), trend {trend_score:.0f}")
                elif (orng.get("broke_below") and or_low > 0
                        and or_low - price <= or_low * CP_STALE_PCT
                        and trend_score <= 48
                        and (not vwap_pos_5m or vwap_pos_5m == "BELOW")):
                    signal = ("PE", f"Inside-bar breakdown — 5m close below OR low {or_low:,.0f} (first 3 candles), trend {trend_score:.0f}")
# new
                if (orng.get("broke_above") and or_high > 0
                        and price - or_high <= or_high * CP_STALE_PCT
                        and i_score >= 55
                        and (not vwap_pos_5m or vwap_pos_5m == "ABOVE")):
                    signal = ("CE", f"Inside-bar breakout — 5m close above OR high {or_high:,.0f} (first 3 candles), intraday {i_score}")
                elif (orng.get("broke_below") and or_low > 0
                        and or_low - price <= or_low * CP_STALE_PCT
                        and i_score <= 45
                        and (not vwap_pos_5m or vwap_pos_5m == "BELOW")):
                    signal = ("PE", f"Inside-bar breakdown — 5m close below OR low {or_low:,.0f} (first 3 candles), intraday {i_score}")
```

**4e — ORB main CE (~line 1573) and PE (~line 1592):**
```python
# old (CE)
                    elif trend_score < 52:
                        blog(session_id_ctx, "SKIP",
                             f"ORB CE blocked: trend_score {trend_score:.0f} — ranging/choppy day, no breakout edge",
# new (CE)
                    elif i_score < 55:
                        blog(session_id_ctx, "SKIP",
                             f"ORB CE blocked: intraday score {i_score} (daily ts {trend_score:.0f}) — no intraday breakout edge",

# old (PE)
                    elif trend_score > 48:
                        blog(session_id_ctx, "SKIP",
                             f"ORB PE blocked: trend_score {trend_score:.0f} — ranging/choppy day, no breakdown edge",
# new (PE)
                    elif i_score > 45:
                        blog(session_id_ctx, "SKIP",
                             f"ORB PE blocked: intraday score {i_score} (daily ts {trend_score:.0f}) — no intraday breakdown edge",
```

Also update the two ORB signal-text lines (~1584, ~1603): replace `trend {trend_score:.0f}` with `intraday {i_score}` in both f-strings.

- [ ] **Step 5: Run the file's tests + strategy suites**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests/test_intraday_score.py backend/tests/test_strategy_logic.py backend/tests/test_nse_bot_fixes.py -v`
Expected: all pass. If an existing strategy test asserted the old SKIP message text, update that assertion to the new message.

- [ ] **Step 6: Commit**

```bash
git add backend/services/trading_bot.py backend/tests/test_intraday_score.py
git commit -m "feat(bot): intraday entry gates use intraday_trend_score, not daily trend_score

ORB main + inside-bar, PDH/PDL, mtf_sniper (added confirm). Daily score kept for
expiry_theta, candle_pattern counter-trend gates, 15m-RSI exemptions.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Daily-bias extreme override uses intraday score

**Files:**
- Modify: `backend/services/trading_bot.py` — `_get_or_set_daily_bias` (~line 338) and its caller (~line 4805)
- Test: `backend/tests/test_intraday_score.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_intraday_score.py`:

```python
# ── Daily-bias override tests ────────────────────────────────────────────────
def _bias_idx(price, prev_close, trend_score):
    return {"price": price, "prev_close": prev_close, "day_open": prev_close,
            "trend_score": trend_score}


def test_bias_override_ignores_stale_daily_score(monkeypatch):
    # Flat gap (no ±0.3% read) + daily ts 70 used to force CE_ONLY.
    # With the intraday override, an all-bear intraday (score 0) must give PE_ONLY.
    tb._daily_bias.clear()
    idx = _bias_idx(price=24000.0, prev_close=24010.0, trend_score=70)
    bias = tb._get_or_set_daily_bias("TEST_IDX_A", idx, _bear_intraday())
    assert bias == "PE_ONLY"


def test_bias_gap_read_unchanged(monkeypatch):
    # +0.5% gap up with neutral intraday (score 50, no extreme) stays CE_ONLY.
    tb._daily_bias.clear()
    idx = _bias_idx(price=24120.0, prev_close=24000.0, trend_score=50)
    bias = tb._get_or_set_daily_bias("TEST_IDX_B", idx, None)  # intraday None → 50, no override
    assert bias == "CE_ONLY"
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests/test_intraday_score.py -v -k bias`
Expected: `test_bias_override_ignores_stale_daily_score` FAILS with either `TypeError` (extra arg) or `CE_ONLY` — the current override reads the daily score.

- [ ] **Step 3: Implement**

In `_get_or_set_daily_bias` (~line 338), change the signature and the override block:

```python
# old
def _get_or_set_daily_bias(index_name: str, idx: dict) -> str:
# new
def _get_or_set_daily_bias(index_name: str, idx: dict, intraday: dict | None = None) -> str:
```

```python
# old
    # Trend-score extremes override the gap read: a flat open that has since
    # trended hard is a directional day regardless of where it opened.
    ts = idx.get("trend_score", 50)
    if ts <= 35:
        bias = "PE_ONLY"
    elif ts >= 65:
        bias = "CE_ONLY"
# new
    # Intraday-score extremes override the gap read: a flat open that has since
    # trended hard is a directional day regardless of where it opened. Switched
    # from the daily trend_score 2026-07-16 — the daily score stays >65 for weeks
    # after a bull run and was forcing CE_ONLY on red days (spec 2026-07-16).
    ts = intraday_trend_score(idx, intraday)
    if ts <= 35:
        bias = "PE_ONLY"
    elif ts >= 65:
        bias = "CE_ONLY"
```

(The log line below already prints `trend {ts:.0f}` — change its label to `intraday {ts:.0f}`.)

Caller at ~line 4805:
```python
# old
    bias = _get_or_set_daily_bias(index_name, idx)
# new
    bias = _get_or_set_daily_bias(index_name, idx, intraday)
```
Note: `intraday` is in scope in that function (used at ~line 4902). `intraday_trend_score` is defined above `_get_or_set_daily_bias`'s call sites at import time — but since Task 1 placed the function *after* `_get_or_set_daily_bias` in the file, Python resolves it at call time, which is fine (module-level name lookup).

- [ ] **Step 4: Run tests**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests/test_intraday_score.py -v`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add backend/services/trading_bot.py backend/tests/test_intraday_score.py
git commit -m "feat(bot): daily-bias extreme override reads intraday score, not daily trend_score

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Prune vol_flow

**Files:**
- Modify: `backend/services/trading_bot.py` — `DISABLED_STRATEGIES` (~line 904)
- Modify: `backend/CLAUDE.md` — strategy table
- Test: `backend/tests/test_intraday_score.py` (append one assertion)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_intraday_score.py`:

```python
def test_vol_flow_is_pruned():
    assert "vol_flow" in tb.DISABLED_STRATEGIES
```

- [ ] **Step 2: Run to verify it fails**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests/test_intraday_score.py -v -k vol_flow`
Expected: FAIL (`AssertionError`)

- [ ] **Step 3: Add to DISABLED_STRATEGIES**

In the `DISABLED_STRATEGIES` set (~line 904), add before the closing `}` (after the `oi_velocity` block):

```python
    # ── PRUNED 2026-07-16 — no edge in either direction ──────────────────────────
    "vol_flow",                # 2/15 WR, -₹5,190 (14d); 20/35 of all Jul trades, 97 CE /
                               # 0 PE signals generated (daily-ts gate starved the PE side).
                               # Decisive: shadow book shows CONTRA also negative
                               # (-₹4,153, n=72 ≥ n=40 threshold) — the signal is noise,
                               # not inverted. Option-volume delta is direction-ambiguous
                               # (writers print the same volume as buyers). Re-enable only
                               # with replay evidence ≥20 trades positive expectancy.
```

- [ ] **Step 4: Update `backend/CLAUDE.md`**

In the 16-strategy table, change the `vol_flow` row status:
```
old: | `vol_flow` | Options Flow | CE/PE options volume imbalance → directional signal; 30-min cooldown per direction | Active (observation — added 2026-06-15) |
new: | `vol_flow` | Options Flow | CE/PE options volume imbalance → directional signal | Disabled (no edge either direction — real 13% WR, contra shadow also negative n=72; pruned 2026-07-16) |
```
And the disabled-strategies line:
```
old: **Disabled strategies** (6): `ict_smc`, `option_premium_breakout`, `smart_money_divergence`, `supertrend_pure`, `supertrend_follow`, `oi_velocity`
new: **Disabled strategies** (7): `ict_smc`, `option_premium_breakout`, `smart_money_divergence`, `supertrend_pure`, `supertrend_follow`, `oi_velocity`, `vol_flow`
```

- [ ] **Step 5: Run tests**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests/test_intraday_score.py -v`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add backend/services/trading_bot.py backend/CLAUDE.md backend/tests/test_intraday_score.py
git commit -m "feat(bot): prune vol_flow — no edge in either direction (shadow n=72)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Record `intraday_score_entry` per trade

**Files:**
- Modify: `backend/db/database.py` — bot_trades migration list (~line 352)
- Modify: `backend/services/trading_bot.py` — `_place_bot_trade` (~line 3032, INSERT ~line 3162) and the signal-path caller (~lines 5047-5070)

- [ ] **Step 1: Add the column migration**

In `backend/db/database.py`, in the bot_trades analytics-columns list (~line 352), add after `("original_sl", "REAL"),`:

```python
            ("intraday_score_entry", "REAL"),         # intraday compass at entry (2026-07-16)
```

- [ ] **Step 2: Thread the score through `_place_bot_trade`**

Signature (~line 3032) — add parameter after `trend_score_entry`:
```python
# old
                           trend_score_entry: float = 0.0,
                           rsi_entry: float = 0.0,
# new
                           trend_score_entry: float = 0.0,
                           intraday_score_entry: float | None = None,
                           rsi_entry: float = 0.0,
```

INSERT (~lines 3162-3177):
```python
# old
                    confluence, trend_score_entry, rsi_entry, regime, strategy,
                    original_sl)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?,
                        ?, ?,
                        ?, ?, ?, ?, ?, ?)
            """, (session_id, trade_id, index_name, action, strike,
                  premium, sl, target, premium, lot_size,
                  f"[C{confluence}] {reason}", now, entry_index_px,
                  premium, premium,
                  confluence, trend_score_entry, rsi_entry, regime, strategy,
                  sl))
# new
                    confluence, trend_score_entry, intraday_score_entry,
                    rsi_entry, regime, strategy,
                    original_sl)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?,
                        ?, ?,
                        ?, ?, ?, ?, ?, ?, ?)
            """, (session_id, trade_id, index_name, action, strike,
                  premium, sl, target, premium, lot_size,
                  f"[C{confluence}] {reason}", now, entry_index_px,
                  premium, premium,
                  confluence, trend_score_entry, intraday_score_entry,
                  rsi_entry, regime, strategy,
                  sl))
```

- [ ] **Step 3: Pass it from the signal path**

At ~line 5047 (`dyn_sl, dyn_tgt = _dynamic_sl_tgt(...)`), add below:
```python
    _i_score_entry = intraday_trend_score(idx, intraday)
```
Update the SIGNAL blog line (~5050) message: change `f"{action} {index_name} @{price:.0f} score={trend_score} "` to `f"{action} {index_name} @{price:.0f} score={trend_score} iscore={_i_score_entry} "`.

Update the `_place_bot_trade` call (~5064):
```python
# old
                                     trend_score_entry=float(trend_score),
# new
                                     trend_score_entry=float(trend_score),
                                     intraday_score_entry=float(_i_score_entry),
```

- [ ] **Step 4: Run the DB-touching suites**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests/test_ledger_math.py backend/tests/test_startup_squareoff.py backend/tests/test_intraday_score.py -v`
Expected: all pass (column is additive; old rows read NULL)

- [ ] **Step 5: Commit**

```bash
git add backend/db/database.py backend/services/trading_bot.py
git commit -m "feat(bot): record intraday_score_entry per trade for compass validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Full suite, docs, and memory updates

**Files:**
- Modify: `C:\Users\Imran\.claude\projects\d--TradingApp\memory\code_map.md` (new column + function)
- Modify: `C:\Users\Imran\.claude\projects\d--TradingApp\memory\project_strategy_prune_log.md` (vol_flow entry)

- [ ] **Step 1: Run the full backend suite**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests/ -q`
Expected: all pass, no new failures vs. baseline. If a pre-existing test fails for unrelated reasons, note it — do not fix unrelated tests in this change.

- [ ] **Step 2: Update memory files**

- `project_strategy_prune_log.md`: add a vol_flow section — pruned 2026-07-16; evidence: 14d real 2/15 WR -₹5,190; since Jul 1 97 CE / 0 PE signals; shadow contra -₹4,153 n=72 (past n≥40 judgment threshold) → noise both directions; re-enable bar: replay ≥20 trades positive expectancy.
- `code_map.md`: under trading_bot.py add `intraday_trend_score()` (6-signal intraday compass, gates ORB/PDH/mtf/bias since 2026-07-16); under bot_trades columns add `intraday_score_entry`.

- [ ] **Step 3: Verify no stray working-tree changes and report**

```bash
git status --short
git log --oneline -6
```
Expected: clean tree, 5 commits from Tasks 1-5 (memory files live outside the repo). Do NOT push.

- [ ] **Step 4: Report completion**

End with the CLAUDE.md-required summary: Files changed / What was modified / Files intentionally not touched (expiry_theta gates, candle_pattern counter-trend gates, 5m-ST gate, 15m-RSI gates, SL-widening check, snapback exemptions, inst_flow) / Follow-up: judge at next two Monday weekly reviews via `intraday_score_entry`.
