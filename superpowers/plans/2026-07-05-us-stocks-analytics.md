# US Stocks Analytics Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only "Analytics" tab to `/us-stocks` that reports per-strategy / -direction / -symbol edge metrics (win rate, expectancy USD + R, profit factor, equity curve, exit-reason mix) from the existing `bot_trades` data.

**Architecture:** A pure compute module (`us_stocks_analytics.py`) does the query + math; a thin cached router endpoint (`GET /us-stocks/analytics`) exposes it; a self-contained React component (`AnalyticsTab.tsx`) renders it as a 4th tab. No trading-loop changes, no scheduler, no broker calls.

**Tech Stack:** FastAPI + aiosqlite (backend), pytest (tests), Next.js 14 + React + inline CSS (frontend).

**Spec:** `docs/superpowers/specs/2026-07-05-us-stocks-analytics-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/services/us_stocks_analytics.py` | **new** — `compute_analytics(days)`: query US trades, compute all blocks. Pure (no cache). |
| `backend/tests/test_us_stocks_analytics.py` | **new** — seed DB, assert the edge math + exclusion rules. |
| `backend/routers/us_stocks.py` | **modify** — add `GET /analytics` with a 15s router-level cache. |
| `frontend/src/components/us-stocks/AnalyticsTab.tsx` | **new** — the tab UI (fetch + render). |
| `frontend/src/app/us-stocks/page.tsx` | **modify** — register the `Analytics` tab + mount the component. |

**Attribution rule (applies throughout):** "Strategy trades" = closed trades **excluding** `STARTUP_SQUARE_OFF`, `STOPPED`, `MANUAL_CLOSE`, `RESTART_CLOSE`. All edge metrics (WR, expectancy, R, profit factor, by_strategy/direction/symbol) use this set. `net_pnl`, `equity_curve`, and `exit_reasons` use **all** closed trades (that money is real). `OPEN` trades are excluded from everything except the `open_trades` count.

---

## Task 1: Analytics compute module

**Files:**
- Create: `backend/services/us_stocks_analytics.py`
- Test: `backend/tests/test_us_stocks_analytics.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_us_stocks_analytics.py`:

```python
"""Tests for us_stocks_analytics.compute_analytics — edge math + exclusion rules.

Seeds a fixed set of US_STOCKS trades into a temp DB and asserts the derived
metrics. Data model reminder: venue + strategy live on bot_sessions; the trade
carries entry/sl/pnl/lot_size/status/action/index_name/placed_at/closed_at.
"""
import asyncio
import sqlite3
from datetime import datetime

import pytest

from backend.config import settings
from backend.db.database import init_db
from backend.services import us_stocks_analytics as A


def _seed_session(db, session_id, strategy):
    db.execute(
        "INSERT INTO bot_sessions (session_id, index_name, strategy, lot_size, "
        "status, started_at, venue, symbol, capital) "
        "VALUES (?,?,?,0,'STOPPED',?,?,?,?)",
        (session_id, "US", strategy, "2026-07-01T09:30:00", "US_STOCKS", "US", 10000),
    )


def _seed_trade(db, session_id, trade_id, symbol, action, entry, sl, pnl,
                status, placed_at, closed_at, qty=10):
    db.execute(
        "INSERT INTO bot_trades (session_id, trade_id, index_name, action, strike, "
        "entry_price, sl_price, target_price, current_price, lot_size, status, "
        "pnl, placed_at, closed_at) "
        "VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?)",
        (session_id, trade_id, symbol, action, entry, sl, entry + 2, entry,
         qty, status, pnl, placed_at, closed_at),
    )


@pytest.fixture
def db_env(tmp_path, monkeypatch):
    db_path = str(tmp_path / "analytics_test.sqlite")
    monkeypatch.setattr(settings, "sqlite_path", db_path)
    asyncio.run(init_db())  # create schema
    con = sqlite3.connect(db_path)
    _seed_session(con, "s_orb", "us_orb")
    _seed_session(con, "s_rev", "us_mean_reversion")
    # us_orb on AAPL: 1 win (+100, R=+2.0), 1 loss (-50, R=-1.0)
    _seed_trade(con, "s_orb", "t1", "AAPL", "LONG", 100.0, 95.0, 100.0,
                "TARGET_HIT", "2026-07-01T09:46:00", "2026-07-01T10:16:00")
    _seed_trade(con, "s_orb", "t2", "AAPL", "LONG", 100.0, 95.0, -50.0,
                "SL_HIT", "2026-07-01T11:00:00", "2026-07-01T11:20:00")
    # us_mean_reversion on TSLA: 1 win via EOD_CLOSE (must COUNT) +30, R=+0.6
    _seed_trade(con, "s_rev", "t3", "TSLA", "LONG", 200.0, 195.0, 30.0,
                "EOD_CLOSE", "2026-07-01T14:00:00", "2026-07-01T15:55:00")
    # STARTUP_SQUARE_OFF: -80 — MUST be excluded from WR/expectancy but IN net_pnl
    _seed_trade(con, "s_rev", "t4", "TSLA", "LONG", 200.0, 195.0, -80.0,
                "STARTUP_SQUARE_OFF", "2026-07-01T13:00:00", "2026-07-02T09:16:00")
    # entry == sl: excluded from R only, present in PnL/WR
    _seed_trade(con, "s_orb", "t5", "AAPL", "LONG", 100.0, 100.0, 20.0,
                "TARGET_HIT", "2026-07-01T12:00:00", "2026-07-01T12:10:00")
    # OPEN: excluded from everything but open_trades count
    _seed_trade(con, "s_orb", "t6", "AAPL", "LONG", 100.0, 95.0, 0.0,
                "OPEN", "2026-07-01T12:30:00", None)
    con.commit()
    con.close()
    return db_path


def _run(days=None):
    return asyncio.run(A.compute_analytics(days))


def test_summary_counts_and_net_pnl(db_env):
    r = _run()
    s = r["summary"]
    # Strategy (scored) set = t1,t2,t3,t5 = 4 ; STARTUP_SQUARE_OFF + OPEN excluded
    assert s["scored_trades"] == 4
    assert s["open_trades"] == 1
    # net_pnl includes STARTUP_SQUARE_OFF (-80): 100-50+30-80+20 = 20
    assert s["net_pnl"] == 20.0
    # wins over scored set: t1,t3,t5 = 3 of 4 = 75%
    assert s["win_rate"] == 75.0


def test_expectancy_and_profit_factor(db_env):
    s = _run()["summary"]
    # expectancy_usd over scored (t1,t2,t3,t5): (100-50+30+20)/4 = 25.0
    assert s["expectancy_usd"] == 25.0
    # R values (t5 excluded, risk 0): t1=+2.0, t2=-1.0, t3=30/(5*10)=+0.6
    # mean = (2.0 -1.0 +0.6)/3 = 0.5333 -> 0.533
    assert s["expectancy_r"] == 0.533
    # profit factor = gross_win/|gross_loss| = (100+30+20)/50 = 3.0
    assert s["profit_factor"] == 3.0


def test_startup_squareoff_excluded_but_in_exit_reasons(db_env):
    r = _run()
    strat_names = {row["strategy"] for row in r["by_strategy"]}
    assert strat_names == {"us_orb", "us_mean_reversion"}
    # STARTUP_SQUARE_OFF trade must NOT inflate us_mean_reversion trade count:
    rev = next(x for x in r["by_strategy"] if x["strategy"] == "us_mean_reversion")
    assert rev["trades"] == 1  # only t3 (EOD_CLOSE), not t4 (SSO)
    # but it appears in the exit-reason table
    statuses = {er["status"] for er in r["exit_reasons"]}
    assert "STARTUP_SQUARE_OFF" in statuses
    assert "EOD_CLOSE" in statuses


def test_no_losses_profit_factor_is_none(db_env, tmp_path, monkeypatch):
    # Fresh DB with only wins -> profit_factor None (UI shows infinity)
    db_path = str(tmp_path / "wins_only.sqlite")
    monkeypatch.setattr(settings, "sqlite_path", db_path)
    asyncio.run(init_db())
    con = sqlite3.connect(db_path)
    _seed_session(con, "s1", "us_orb")
    _seed_trade(con, "s1", "w1", "AAPL", "LONG", 100.0, 95.0, 40.0,
                "TARGET_HIT", "2026-07-01T09:46:00", "2026-07-01T10:00:00")
    con.commit(); con.close()
    assert _run()["summary"]["profit_factor"] is None


def test_equity_curve_cumulative_and_ordered(db_env):
    curve = _run()["equity_curve"]
    # ordered by closed_at ascending; cum_pnl is a running realized total over
    # ALL closed trades (incl STARTUP_SQUARE_OFF), final point == net_pnl
    ts = [p["t"] for p in curve]
    assert ts == sorted(ts)
    assert curve[-1]["cum_pnl"] == 20.0


def test_by_symbol_and_direction_present(db_env):
    r = _run()
    syms = {x["symbol"] for x in r["by_symbol"]}
    assert syms == {"AAPL", "TSLA"}
    dirs = {x["direction"] for x in r["by_direction"]}
    assert dirs == {"LONG"}  # SHORT appears only after sub-project A
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv\Scripts\python -m pytest tests/test_us_stocks_analytics.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.services.us_stocks_analytics'` (or AttributeError on `compute_analytics`).

- [ ] **Step 3: Write minimal implementation**

Create `backend/services/us_stocks_analytics.py`:

```python
"""US Stocks per-strategy analytics — read-only edge metrics.

Reads the shared bot_trades / bot_sessions tables (venue='US_STOCKS') and
computes win rate, expectancy (USD + R), profit factor, per-strategy /
-direction / -symbol breakdowns, an exit-reason mix, and a realized-PnL
equity curve.

Attribution: edge metrics use "strategy trades" = closed trades EXCLUDING
restart/admin artifacts (STARTUP_SQUARE_OFF, STOPPED, MANUAL_CLOSE,
RESTART_CLOSE). net_pnl / equity_curve / exit_reasons include ALL closed
trades because that money is economically real. No caching here — the router
owns the cache so this stays pure and test-isolated.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import aiosqlite

from backend.config import settings as _settings

# Closed statuses that are NOT strategy outcomes. STARTUP_SQUARE_OFF is
# venue-agnostic in database.py and fires on every server restart, so US trades
# accumulate it too (~14% of live US trades as of 2026-07-05).
_NON_STRATEGY_STATUSES = {
    "STARTUP_SQUARE_OFF", "STOPPED", "MANUAL_CLOSE", "RESTART_CLOSE",
}


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _pnl(r: dict) -> float:
    return r["pnl"] or 0.0


def _r_multiple(r: dict) -> float | None:
    """Realized R = pnl / (|entry - sl| * qty). None when risk is 0."""
    risk = abs((r["entry_price"] or 0) - (r["sl_price"] or 0)) * (r["lot_size"] or 0)
    if risk <= 0:
        return None
    return _pnl(r) / risk


def _hold_minutes(r: dict) -> float | None:
    if not r["closed_at"]:
        return None
    try:
        p = datetime.fromisoformat(r["placed_at"])
        c = datetime.fromisoformat(r["closed_at"])
    except (ValueError, TypeError):
        return None
    return (c - p).total_seconds() / 60.0


def _profit_factor(rows: list[dict]) -> float | None:
    gross_win = sum(_pnl(r) for r in rows if _pnl(r) > 0)
    gross_loss = sum(_pnl(r) for r in rows if _pnl(r) < 0)  # negative
    if gross_loss >= 0:  # no losses
        return None
    return round(gross_win / abs(gross_loss), 2)


def _group(rows: list[dict], name_key: str) -> list[dict]:
    """Group strategy trades by a field, sorted by pnl desc. Each row carries
    both expectancy_r and avg_r (same value) so every table can label freely."""
    groups: dict[str, list[dict]] = {}
    for r in rows:
        groups.setdefault(r[name_key], []).append(r)
    out = []
    for name, items in groups.items():
        wins = [r for r in items if _pnl(r) > 0]
        rs = [rm for r in items if (rm := _r_multiple(r)) is not None]
        mean_r = round(_mean(rs), 3)
        out.append({
            name_key: name,
            "trades": len(items),
            "win_rate": round(len(wins) / len(items) * 100, 1) if items else 0.0,
            "pnl": round(sum(_pnl(r) for r in items), 2),
            "expectancy_r": mean_r,
            "avg_r": mean_r,
            "profit_factor": _profit_factor(items),
        })
    out.sort(key=lambda x: -x["pnl"])
    return out


def _build(rows: list[dict], days: int | None) -> dict:
    open_trades = [r for r in rows if r["status"] == "OPEN"]
    closed = [r for r in rows if r["status"] != "OPEN"]
    strat = [r for r in closed if r["status"] not in _NON_STRATEGY_STATUSES]

    wins = [r for r in strat if _pnl(r) > 0]
    rs = [rm for r in strat if (rm := _r_multiple(r)) is not None]
    holds = [h for r in strat if (h := _hold_minutes(r)) is not None]
    losses = [r for r in strat if _pnl(r) <= 0]

    summary = {
        "closed_trades": len(closed),          # all closed (incl artifacts)
        "scored_trades": len(strat),           # attribution denominator
        "open_trades": len(open_trades),
        "win_rate": round(len(wins) / len(strat) * 100, 1) if strat else 0.0,
        "net_pnl": round(sum(_pnl(r) for r in closed), 2),
        "expectancy_usd": round(_mean([_pnl(r) for r in strat]), 2),
        "expectancy_r": round(_mean(rs), 3),
        "profit_factor": _profit_factor(strat),
        "avg_win": round(_mean([_pnl(r) for r in wins]), 2),
        "avg_loss": round(_mean([_pnl(r) for r in losses]), 2),
        "avg_hold_min": round(_mean(holds), 1),
    }

    # Exit reasons — over ALL closed trades.
    reasons: dict[str, dict] = {}
    for r in closed:
        g = reasons.setdefault(r["status"], {"n": 0, "total": 0.0})
        g["n"] += 1
        g["total"] += _pnl(r)
    exit_reasons = [
        {"status": s, "n": v["n"], "total_pnl": round(v["total"], 2),
         "avg_pnl": round(v["total"] / v["n"], 2) if v["n"] else 0.0}
        for s, v in reasons.items()
    ]
    exit_reasons.sort(key=lambda x: -x["total_pnl"])

    # Equity curve — realized cumulative PnL over ALL closed trades by close time.
    equity = []
    cum = 0.0
    for r in sorted(closed, key=lambda x: (x["closed_at"] or x["placed_at"])):
        cum += _pnl(r)
        equity.append({"t": r["closed_at"] or r["placed_at"], "cum_pnl": round(cum, 2)})

    return {
        "days": days,
        "generated_at": datetime.now().isoformat(),
        "summary": summary,
        "by_strategy": _group(strat, "strategy"),
        "by_direction": _group(strat, "action_dir"),
        "by_symbol": _group(strat, "symbol"),
        "exit_reasons": exit_reasons,
        "equity_curve": equity,
    }


async def compute_analytics(days: int | None = 30) -> dict:
    """days>0 => last N days; days<=0 or None => all history."""
    if days and days > 0:
        since = (datetime.now() - timedelta(days=days)).date().isoformat()
    else:
        since = "1970-01-01"

    async with aiosqlite.connect(_settings.sqlite_path, timeout=10) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("""
            SELECT bs.strategy, bt.action, bt.action AS action_dir,
                   bt.index_name AS symbol, bt.status,
                   bt.entry_price, bt.sl_price, bt.pnl, bt.lot_size,
                   bt.placed_at, bt.closed_at
            FROM bot_trades bt
            JOIN bot_sessions bs ON bt.session_id = bs.session_id
            WHERE bs.venue = 'US_STOCKS' AND bt.placed_at >= ?
            ORDER BY bt.placed_at ASC
        """, (since,))
        rows = [dict(r) for r in await cur.fetchall()]

    return _build(rows, days)
```

Note: the SQL aliases `bt.action` twice — as `action` and `action_dir` — so `_group(strat, "action_dir")` yields rows keyed `{"direction": ...}`? No — it keys on the literal column name. To get the `direction` label the frontend expects, the group is keyed on `action_dir`; **rename that key to `direction` in `_build`** before returning. Adjust the `by_direction` line to:

```python
        "by_direction": [
            {"direction": g.pop("action_dir"), **g} for g in _group(strat, "action_dir")
        ],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv\Scripts\python -m pytest tests/test_us_stocks_analytics.py -v`
Expected: PASS (6 tests). The `by_direction` assertion checks `x["direction"]`, matching the rename above.

- [ ] **Step 5: Commit**

```bash
git add backend/services/us_stocks_analytics.py backend/tests/test_us_stocks_analytics.py
git commit -m "feat(us-stocks): analytics compute module with edge metrics + tests"
```

---

## Task 2: Analytics endpoint

**Files:**
- Modify: `backend/routers/us_stocks.py` (add endpoint near the other cached GETs)
- Test: `backend/tests/test_us_stocks_analytics.py` (append a router test)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_us_stocks_analytics.py`:

```python
from fastapi.testclient import TestClient
from backend.main import app


def test_analytics_endpoint_returns_payload(db_env):
    client = TestClient(app)
    resp = client.get("/us-stocks/analytics?days=0")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) >= {"summary", "by_strategy", "by_direction",
                         "by_symbol", "exit_reasons", "equity_curve"}
    assert body["summary"]["net_pnl"] == 20.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv\Scripts\python -m pytest tests/test_us_stocks_analytics.py::test_analytics_endpoint_returns_payload -v`
Expected: FAIL with 404 (route not registered).

- [ ] **Step 3: Add the endpoint**

In `backend/routers/us_stocks.py`, add to the imports block (near `from backend.services import us_scanner`):

```python
from backend.services import us_stocks_analytics
```

Add a cache dict beside the existing `_rec_cache` declaration:

```python
_analytics_cache: dict = {}   # days -> {"at": float, "data": dict}
```

Add the endpoint after the `/recommend` handler (before the Bot lifecycle section):

```python
@router.get("/analytics")
async def analytics(days: int = Query(30, description="Lookback days; 0 = all history")):
    """Per-strategy / -direction / -symbol edge metrics for the US paper book.
    Read-only; 15s server-side cache keyed by the days window."""
    now = time.monotonic()
    hit = _analytics_cache.get(days)
    if hit and now - hit["at"] < 15:
        return hit["data"]
    data = await us_stocks_analytics.compute_analytics(days)
    _analytics_cache[days] = {"at": now, "data": data}
    return data
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv\Scripts\python -m pytest tests/test_us_stocks_analytics.py -v`
Expected: PASS (7 tests).

Note on cache + tests: the router cache is keyed by `days`; this test uses `days=0` and Task 1 tests call `compute_analytics` directly, so there is no cross-test staleness. If a future test needs a fresh endpoint read, clear `us_stocks._analytics_cache` in its setup.

- [ ] **Step 5: Commit**

```bash
git add backend/routers/us_stocks.py backend/tests/test_us_stocks_analytics.py
git commit -m "feat(us-stocks): GET /us-stocks/analytics endpoint (15s cache)"
```

---

## Task 3: AnalyticsTab component

**Files:**
- Create: `frontend/src/components/us-stocks/AnalyticsTab.tsx`

- [ ] **Step 1: Write the component**

Create `frontend/src/components/us-stocks/AnalyticsTab.tsx`:

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface Summary {
  closed_trades: number; scored_trades: number; open_trades: number;
  win_rate: number; net_pnl: number; expectancy_usd: number;
  expectancy_r: number; profit_factor: number | null;
  avg_win: number; avg_loss: number; avg_hold_min: number;
}
interface GroupRow {
  strategy?: string; direction?: string; symbol?: string;
  trades: number; win_rate: number; pnl: number;
  expectancy_r: number; avg_r: number; profit_factor: number | null;
}
interface ExitReason { status: string; n: number; total_pnl: number; avg_pnl: number; }
interface EquityPt { t: string; cum_pnl: number; }
interface Analytics {
  summary: Summary;
  by_strategy: GroupRow[];
  by_direction: GroupRow[];
  by_symbol: GroupRow[];
  exit_reasons: ExitReason[];
  equity_curve: EquityPt[];
}

const fmtUSD = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pnlColor = (n: number) => (n > 0 ? "#16a34a" : n < 0 ? "#dc2626" : "#64748b");
const fmtPF = (n: number | null) => (n == null ? "∞" : n.toFixed(2));

function EquityCurve({ pts }: { pts: EquityPt[] }) {
  if (pts.length < 2) {
    return <div style={{ padding: 24, color: "#94a3b8", fontSize: 12, textAlign: "center" }}>
      Not enough closed trades to plot an equity curve yet.
    </div>;
  }
  const W = 720, H = 160, PAD = 8;
  const ys = pts.map(p => p.cum_pnl);
  const min = Math.min(0, ...ys), max = Math.max(0, ...ys);
  const range = max - min || 1;
  const x = (i: number) => PAD + (i / (pts.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - min) / range) * (H - 2 * PAD);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.cum_pnl).toFixed(1)}`).join(" ");
  const last = ys[ys.length - 1];
  const stroke = last >= 0 ? "#16a34a" : "#dc2626";
  const zeroY = y(0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 160 }} preserveAspectRatio="none">
      <line x1={PAD} x2={W - PAD} y1={zeroY} y2={zeroY} stroke="#e2e8f0" strokeWidth={1} />
      <path d={`${d} L${x(pts.length - 1)},${zeroY} L${x(0)},${zeroY} Z`} fill={stroke} opacity={0.08} />
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.75} />
    </svg>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: "10px 14px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, minWidth: 110 }}>
      <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: color || "#0f172a", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

export default function AnalyticsTab({ configured }: { configured: boolean }) {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Analytics | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const r = await fetch(`${API}/us-stocks/analytics?days=${days}`).then(r => r.json());
      setData(r);
    } catch { /* keep stale */ }
  }, [days]);

  useEffect(() => {
    fetchData();
    const id = setInterval(() => { if (!document.hidden) fetchData(); }, 30_000);
    const onVis = () => { if (!document.hidden) fetchData(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [fetchData]);

  const s = data?.summary;
  const empty = s && s.scored_trades === 0;

  return (
    <div>
      {/* Day selector */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {[{ l: "7D", v: 7 }, { l: "30D", v: 30 }, { l: "All", v: 0 }].map(o => (
          <button key={o.v} onClick={() => setDays(o.v)} style={{
            padding: "5px 12px", borderRadius: 6,
            border: days === o.v ? "1.5px solid #2962ff" : "1px solid #e2e8f0",
            background: days === o.v ? "#eff6ff" : "#fff",
            color: days === o.v ? "#1d4ed8" : "#475569",
            fontWeight: 600, fontSize: 12, cursor: "pointer",
          }}>{o.l}</button>
        ))}
      </div>

      {!s ? (
        <div style={emptyBox}>Loading…</div>
      ) : empty ? (
        <div style={emptyBox}>No closed trades in this window yet. Widen the range or run a bot.</div>
      ) : (
        <>
          {/* Summary cards */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            <StatCard label="Net P&L" value={fmtUSD(s.net_pnl)} color={pnlColor(s.net_pnl)} />
            <StatCard label="Win Rate" value={`${s.win_rate}%`} />
            <StatCard label="Expectancy R" value={s.expectancy_r.toFixed(2)} color={pnlColor(s.expectancy_r)} />
            <StatCard label="Profit Factor" value={fmtPF(s.profit_factor)} />
            <StatCard label="Avg Win" value={fmtUSD(s.avg_win)} color="#16a34a" />
            <StatCard label="Avg Loss" value={fmtUSD(s.avg_loss)} color="#dc2626" />
            <StatCard label="Avg Hold" value={`${s.avg_hold_min.toFixed(0)}m`} />
            <StatCard label="Scored / Closed" value={`${s.scored_trades} / ${s.closed_trades}`} />
          </div>

          {/* Equity curve */}
          <Section title="Equity Curve (realized)">
            <EquityCurve pts={data!.equity_curve} />
          </Section>

          {/* Strategy table */}
          <Section title="By Strategy">
            <GroupTable rows={data!.by_strategy} nameKey="strategy" nameLabel="Strategy" showPF />
          </Section>

          {/* Direction + Symbol side by side */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <Section title="By Direction">
              <GroupTable rows={data!.by_direction} nameKey="direction" nameLabel="Dir" />
            </Section>
            <Section title="By Symbol">
              <GroupTable rows={data!.by_symbol} nameKey="symbol" nameLabel="Symbol" />
            </Section>
          </div>

          {/* Exit reasons */}
          <Section title="Exit Reasons (all closed)">
            <table style={tbl}>
              <thead><tr style={trHead}>
                <th style={thc}>Status</th><th style={{ ...thc, textAlign: "right" }}>N</th>
                <th style={{ ...thc, textAlign: "right" }}>Total</th><th style={{ ...thc, textAlign: "right" }}>Avg</th>
              </tr></thead>
              <tbody>
                {data!.exit_reasons.map(e => (
                  <tr key={e.status} style={trBody}>
                    <td style={tdc}>{e.status}</td>
                    <td style={{ ...tdc, textAlign: "right" }}>{e.n}</td>
                    <td style={{ ...tdc, textAlign: "right", color: pnlColor(e.total_pnl) }}>{fmtUSD(e.total_pnl)}</td>
                    <td style={{ ...tdc, textAlign: "right", color: pnlColor(e.avg_pnl) }}>{fmtUSD(e.avg_pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8,
        textTransform: "uppercase", letterSpacing: "0.05em" }}>{title}</div>
      {children}
    </div>
  );
}

function GroupTable({ rows, nameKey, nameLabel, showPF }: {
  rows: GroupRow[]; nameKey: "strategy" | "direction" | "symbol"; nameLabel: string; showPF?: boolean;
}) {
  if (!rows.length) return <div style={emptyBox}>No data.</div>;
  const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.pnl)));
  return (
    <table style={tbl}>
      <thead><tr style={trHead}>
        <th style={thc}>{nameLabel}</th>
        <th style={{ ...thc, textAlign: "right" }}>Trades</th>
        <th style={{ ...thc, textAlign: "right" }}>WR</th>
        <th style={{ ...thc, textAlign: "right" }}>Exp R</th>
        {showPF && <th style={{ ...thc, textAlign: "right" }}>PF</th>}
        <th style={{ ...thc, textAlign: "right" }}>P&L</th>
        <th style={thc}></th>
      </tr></thead>
      <tbody>
        {rows.map(r => {
          const name = r[nameKey] ?? "—";
          const w = Math.round((Math.abs(r.pnl) / maxAbs) * 60);
          return (
            <tr key={name} style={trBody}>
              <td style={{ ...tdc, fontWeight: 600 }}>{name}</td>
              <td style={{ ...tdc, textAlign: "right" }}>{r.trades}</td>
              <td style={{ ...tdc, textAlign: "right" }}>{r.win_rate}%</td>
              <td style={{ ...tdc, textAlign: "right", color: pnlColor(r.expectancy_r) }}>{r.expectancy_r.toFixed(2)}</td>
              {showPF && <td style={{ ...tdc, textAlign: "right" }}>{fmtPF(r.profit_factor)}</td>}
              <td style={{ ...tdc, textAlign: "right", color: pnlColor(r.pnl), fontWeight: 600 }}>{fmtUSD(r.pnl)}</td>
              <td style={tdc}>
                <div style={{ height: 8, width: w, borderRadius: 2, background: pnlColor(r.pnl), opacity: 0.5 }} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const emptyBox: React.CSSProperties = { padding: 24, background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 10, textAlign: "center", color: "#64748b", fontSize: 13 };
const tbl: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" };
const trHead: React.CSSProperties = { background: "#f8fafc", color: "#64748b", fontWeight: 600 };
const trBody: React.CSSProperties = { borderTop: "1px solid #e2e8f0" };
const thc: React.CSSProperties = { padding: "8px 12px", textAlign: "left", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" };
const tdc: React.CSSProperties = { padding: "8px 12px", color: "#0f172a", fontVariantNumeric: "tabular-nums" };
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors referencing `AnalyticsTab.tsx`. (`configured` prop is accepted for future use even though the component does not gate on it — leave it wired for parity with the page's account state.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/us-stocks/AnalyticsTab.tsx
git commit -m "feat(us-stocks): AnalyticsTab component (summary, equity curve, tables)"
```

---

## Task 4: Wire the tab into the page

**Files:**
- Modify: `frontend/src/app/us-stocks/page.tsx`

- [ ] **Step 1: Import the component**

At the top of `frontend/src/app/us-stocks/page.tsx`, add after the existing imports:

```tsx
import AnalyticsTab from "@/components/us-stocks/AnalyticsTab";
```

- [ ] **Step 2: Add the tab to the union type + tab bar**

Change the `tab` state type (currently `"strategies" | "scanner" | "sessions"`) to include analytics:

```tsx
  const [tab, setTab] = useState<"strategies" | "scanner" | "sessions" | "analytics">("strategies");
```

In the tab-bar `.map` array, add an `analytics` entry after `sessions`:

```tsx
          { key: "sessions", label: `Sessions${activeSessions.length ? ` (${activeSessions.length})` : ""}` },
          { key: "analytics", label: "Analytics" },
```

- [ ] **Step 3: Render the tab body**

After the closing of the `{tab === "scanner" && (…)}` block (just before the final `</div>` of the page), add:

```tsx
      {tab === "analytics" && <AnalyticsTab configured={!!account?.ok} />}
```

- [ ] **Step 4: Type-check + visual verification**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

Then verify in the running app (use the `run` skill or existing dev servers): open `http://localhost:3000/us-stocks`, click the **Analytics** tab, confirm the summary cards, equity curve, and the strategy/direction/symbol/exit-reason tables render against live data (337 closed US trades exist as of 2026-07-05), and that switching 7D/30D/All refetches. Confirm `STARTUP_SQUARE_OFF` shows in the exit-reason table but not in the by-strategy rows.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/us-stocks/page.tsx
git commit -m "feat(us-stocks): add Analytics tab to /us-stocks page"
```

---

## Task 5: Update code map

**Files:**
- Modify: `C:\Users\Imran\.claude\projects\d--TradingApp\memory\code_map.md`

- [ ] **Step 1: Document the new surface**

In `code_map.md`: add `us_stocks_analytics.py` to the Services table ("US paper-book edge metrics — read-only"); note the `GET /us-stocks/analytics` route under the us_stocks router row; add `AnalyticsTab.tsx` under a us-stocks components note; bump the "Last updated" date.

- [ ] **Step 2: Commit** (code_map.md is under the memory dir, tracked separately — commit if in a git repo, otherwise it is a loose memory file and no commit is needed)

```bash
git add -A && git commit -m "docs: code_map — US analytics endpoint + tab" || echo "memory dir not tracked; skip"
```

---

## Self-Review

**Spec coverage:**
- Endpoint + service → Tasks 1–2 ✓
- Expectancy/R/profit factor, EOD_CLOSE kept, STARTUP_SQUARE_OFF excluded-but-in-net-pnl → Task 1 tests ✓
- by_strategy/direction/symbol, exit reasons, equity curve → Task 1 `_build` ✓
- Analytics tab + equity SVG + day selector + empty state → Tasks 3–4 ✓
- TDD, forward-compatible SHORT (`by_direction` from `action`) → Task 1 ✓
- Out of scope respected: no trading-loop, scheduler, broker, or CLI changes ✓

**Placeholder scan:** none — all steps contain runnable code/commands.

**Type consistency:** `compute_analytics(days)` returns the exact keys the endpoint passes through and `AnalyticsTab`'s `Analytics` interface consumes (`summary`, `by_strategy`, `by_direction`, `by_symbol`, `exit_reasons`, `equity_curve`); `GroupRow` carries both `expectancy_r` and `avg_r` as the service emits; `profit_factor` is `number | null` on both sides (`∞` rendered by `fmtPF`).
