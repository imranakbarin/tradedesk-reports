# US Stocks — Per-Strategy Analytics (Sub-project B)

_Design spec · 2026-07-05_

## Context

The user is expanding into US market trading and wants to sharpen the existing
`/us-stocks` paper-trading surface into a serious practice ground before risking
real money. That effort decomposes into four independent sub-projects:

| # | Sub-project | Build order | Notes |
|---|---|---|---|
| A | Short-selling (symmetric long+short, same 3 strategies) | 1st to build | Biggest edge unlock; touches the live bot loop |
| **B** | **Per-strategy analytics** | **designed first** | Zero-risk, read-only; establishes the measurement baseline |
| C | Richer market context (SPY/QQQ regime, RS, gaps) | 3rd | Feeds D |
| D | More / better strategies | 4th | Wants A + C first |

**Build order is A → B → C → D**, but **B is designed and shipped first** because
it is read-only (no trading-loop risk) and every later change becomes measurable
once it exists. This spec covers **B only**.

### Phase constraint
The project is in **Stabilization Phase 2**. This sub-project stays inside the
rails: it adds no new page (a tab on the existing `/us-stocks` page), no new
scheduler job, and no broker integration. It only reads existing data.

### What exists today
- `/us-stocks` page with 3 tabs: Strategies · Scanner · Sessions (light theme,
  inline CSS, local `fetch` + visibility-poll pattern — predates the `useAPI` rule).
- `us_stocks_bot.py` — 3 long-only strategies (`us_orb`, `us_trend_pullback`,
  `us_mean_reversion`). Paper trades land in the shared `bot_trades` table with
  `action='LONG'`, `strike=0`; sessions in `bot_sessions`. **`venue` and
  `strategy` live only on `bot_sessions`** — there is no trade-level column for
  either, so the session JOIN below is mandatory, not an optimization.
- `bot_trades` stores `entry_price`, `sl_price`, `target_price`, `exit_price`,
  `pnl`, `lot_size` (share qty for US), `status`, `action`, `index_name` (symbol
  here), `placed_at`, `closed_at`, `reason`. PnL is clean `(exit − entry) × qty`
  with no fees/slippage modeled. That's enough to compute R-multiples and
  expectancy.
- **Real data already exists** (verified 2026-07-05 against the live DB): 337
  closed US trades across all 3 strategies and 8 symbols — status mix
  TARGET_HIT 186 · SL_HIT 82 · **STARTUP_SQUARE_OFF 46** · EOD_CLOSE 23, plus
  16 trades with `entry_price == sl_price` (the R div-zero guard is not
  hypothetical). Analytics will be meaningful on day one; the empty state still
  matters for short `days` windows.
- ⚠️ **DB path gotcha for verification**: `SQLITE_PATH=./db/trades.sqlite` is
  cwd-relative and the backend runs from the repo root, so the live DB is
  `d:\TradingApp\db\trades.sqlite` — `backend/db/trades.sqlite` is a stale copy.
  The endpoint is unaffected (it uses `_settings.sqlite_path`), but ad-hoc
  check queries must hit the root copy.
- `scripts/bot_analysis.py` is the NSE analog to mirror (strategy P&L, exit-reason
  breakdown, WR bars) — but it excludes forced square-offs, a rule that must be
  adapted for US (see edge-math below).

## Goal

An **Analytics tab** on `/us-stocks`, backed by a new endpoint, that tells the
user which strategies / directions / symbols actually have edge — using
expectancy, R-multiples, profit factor, an equity curve, and an exit-reason mix.

## Design

### 1. Backend — service module + one endpoint

**New module `backend/services/us_stocks_analytics.py`** holds all query and math
so it is unit-testable in isolation and keeps the router thin. Single public
function, e.g. `async def compute_analytics(days: int | None) -> dict`.

**New endpoint `GET /us-stocks/analytics?days=N`** in `routers/us_stocks.py`:
- `days` default `30`; accept `days=0` or a sentinel to mean "all".
- Reads `bot_trades bt JOIN bot_sessions bs ON bt.session_id = bs.session_id`
  filtered to `bs.venue = 'US_STOCKS'` and `bt.placed_at >= <since>`.
- 15s server-side cache keyed by the `days` argument (mirrors `_quotes_cache` /
  `_rec_cache` pattern already in the router).
- No scheduler job, no broker call.

**Response shape:**
```jsonc
{
  "days": 30,
  "generated_at": "2026-07-05T...",
  "summary": {
    "closed_trades": 0, "open_trades": 0,
    "win_rate": 0.0, "net_pnl": 0.0,
    "expectancy_usd": 0.0, "expectancy_r": 0.0,
    "profit_factor": 0.0, "avg_win": 0.0, "avg_loss": 0.0,
    "avg_hold_min": 0.0
  },
  "by_strategy": [
    { "strategy": "us_orb", "trades": 0, "win_rate": 0.0,
      "pnl": 0.0, "expectancy_r": 0.0, "profit_factor": 0.0 }
  ],
  "by_direction": [
    { "direction": "LONG", "trades": 0, "win_rate": 0.0, "pnl": 0.0, "avg_r": 0.0 }
    // SHORT row appears automatically once sub-project A produces SHORT trades
  ],
  "by_symbol": [
    { "symbol": "AAPL", "trades": 0, "win_rate": 0.0, "pnl": 0.0, "avg_r": 0.0 }
  ],
  "exit_reasons": [
    { "status": "TARGET_HIT", "n": 0, "total_pnl": 0.0, "avg_pnl": 0.0 }
  ],
  "equity_curve": [
    { "t": "2026-07-05T14:31:00", "cum_pnl": 0.0 }
  ]
}
```

### 2. Edge-math decisions (must be correct)

- **R-multiple per trade** = `pnl / (abs(entry_price − sl_price) × lot_size)`.
  Trades where `entry_price == sl_price` (risk 0) are dropped from **R stats only**
  (div-zero guard), never from PnL or WR.
- **Expectancy-R** = arithmetic mean of R over the qualifying closed trades.
- **Expectancy-USD** = mean `pnl` over closed trades.
- **Profit factor** = `sum(pnl where pnl>0) / abs(sum(pnl where pnl<0))`.
  If there are no losses, report `profit_factor = null`/`inf`-sentinel and let the
  UI show `∞` — do not divide by zero.
- **Win-rate denominator** = closed strategy trades, **excluding `OPEN`,
  `STARTUP_SQUARE_OFF`, `STOPPED`, and `MANUAL_CLOSE`**. A **win** is `pnl > 0`
  over that set (`pnl <= 0` counts as a loss, matching the bot's own session
  counters).
  - **`STARTUP_SQUARE_OFF` excluded from WR / expectancy / R / per-strategy
    rows** — 46 of the 337 real US trades (14%) carry it. The startup
    square-off in `database.py` is venue-agnostic, so every server restart
    (frequent, per the Fyers token issue) force-closes stale US trades too.
    These are restart artifacts, not strategy exits — same category
    `bot_analysis.py` excludes for NSE. They **stay in net PnL** (the money is
    real) and appear in the exit-reason table so the damage is visible, but are
    never attributed to strategy skill.
  - (`STOPPED` / `MANUAL_CLOSE` never actually occur on US trades today —
    stopping a session just cancels the task and the open trade sits until
    startup square-off catches it. Listed as excluded for future-proofing only.)
  - **`EOD_CLOSE` is KEPT** — divergence from `bot_analysis.py`, which excludes
    forced NSE square-offs. On the US side an EOD liquidation at 15:55 ET is a
    normal intraday exit, so excluding it would understate real performance.
    `TARGET_HIT`, `SL_HIT`, `TRAIL_SL`, `EOD_CLOSE` all count.
- **Direction** is read from `bot_trades.action` (`LONG` today; `SHORT` after
  sub-project A). The math is direction-agnostic because R uses `abs(entry − sl)`
  and `pnl` already carries the correct sign — **no rework needed when shorts land.**
- **Hold time** = `closed_at − placed_at` in minutes, averaged over closed trades.
- **Equity curve** = cumulative **realized** PnL over closed trades only,
  ordered by `closed_at` (t = `closed_at`).

### 3. Frontend — 4th "Analytics" tab

- Add `Analytics` to the existing tab bar in `app/us-stocks/page.tsx`.
- The tab body lives in a **new component
  `frontend/src/components/us-stocks/AnalyticsTab.tsx`** to avoid growing
  `page.tsx` (already ~700 lines). This is a targeted extraction of just the new
  surface — not a refactor of the existing tabs.
- `AnalyticsTab` fetches `GET /us-stocks/analytics?days=<sel>` using the same
  local `fetch` + `document.hidden` visibility-poll pattern the page already uses,
  and inline CSS (matches the file; the page predates the `useAPI` rule).
- Layout, top to bottom:
  1. **Day selector** `7 / 30 / All`.
  2. **Summary stat-card row** — Net PnL, Win rate, Expectancy (R), Profit factor,
     Avg win / Avg loss, Avg hold.
  3. **Equity curve** — inline SVG line built from `equity_curve` (same technique
     as the `/bots` HeroRow sparkline; no chart library). Consult the `dataviz`
     skill for color/axis choices at build time.
  4. **Strategy table** — trades, WR, PnL, expectancy-R, profit factor, with the
     `+/-#` PnL bar style from `bot_analysis.py`.
  5. **Direction split** — LONG / SHORT (SHORT shows "—" until A ships).
  6. **Symbol table** — best/worst by PnL.
  7. **Exit-reason breakdown** — status, n, total, avg.
- Empty state: every block must render a clean "no closed trades yet"
  placeholder rather than NaN/blank. (Historical data exists — 337 closed
  trades as of 2026-07-05 — but a short `days` window can still be empty.)

### 4. Testing

Per the project's TDD discipline, write the test first:
`backend/tests/test_us_stocks_analytics.py` seeds a handful of `US_STOCKS`
`bot_trades` (a mix of TARGET_HIT / SL_HIT / EOD_CLOSE / one OPEN / one
**STARTUP_SQUARE_OFF** — the forced-close status that actually occurs on US
trades, unlike STOPPED/MANUAL_CLOSE) across two strategies and two symbols,
then asserts:
- expectancy-R and expectancy-USD,
- profit factor (incl. the no-losses `∞` path),
- the WR exclusion rule (OPEN/STARTUP_SQUARE_OFF/STOPPED/MANUAL_CLOSE excluded;
  EOD_CLOSE included; STARTUP_SQUARE_OFF PnL still present in net PnL and in
  the exit-reason table),
- R div-zero guard (entry == sl trade excluded from R but present in PnL),
- equity-curve cumulative sum ordering (by `closed_at`).

## Out of scope (explicit)

- No CLI script (tab-only was chosen).
- **Zero changes to the trading loop** (`us_stocks_bot.py` untouched).
- No short-selling logic — that is sub-project A.
- No new scheduler job, no broker wiring, no new page.
- Richer context (C) and new strategies (D) are separate specs.

## Files touched

| File | Change |
|---|---|
| `backend/services/us_stocks_analytics.py` | **new** — query + edge math |
| `backend/routers/us_stocks.py` | add `GET /analytics` endpoint + cache |
| `frontend/src/components/us-stocks/AnalyticsTab.tsx` | **new** — tab UI |
| `frontend/src/app/us-stocks/page.tsx` | add `Analytics` tab + wire component |
| `backend/tests/test_us_stocks_analytics.py` | **new** — math + exclusion tests |

## Follow-up / next sub-projects

After B ships and accrues a few sessions of data: **A (short-selling)** →
**C (richer context)** → **D (new strategies)**, each its own spec → plan → build.
