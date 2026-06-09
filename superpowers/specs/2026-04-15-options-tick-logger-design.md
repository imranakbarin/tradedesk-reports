# Options Tick Logger — Design Spec
**Date:** 2026-04-15
**Status:** Approved

## Goal

Log real-time NSE options chain data every minute during market hours so trades can be backtested against actual historical premiums, OI, IV, and Greeks instead of synthetic estimates.

## Scope

- **Indices:** NIFTY and SENSEX
- **Expiries:** Front-week + next-week (2 per index = 4 chains total)
- **Strikes:** ATM ± 5 (11 strikes per chain snapshot: ATM itself + 5 above + 5 below)
- **Frequency:** Every 60 seconds during market hours (9:15–15:30 IST)
- **Storage:** Separate SQLite file — `db/options_tick.sqlite`

## Architecture

### New service: `backend/services/options_logger.py`

A single `asyncio` background loop with one responsibility: fetch option chain data and persist it. Started once at app startup via FastAPI `lifespan`. Completely decoupled from bot logic — runs whether or not any trading bot is active.

```
FastAPI lifespan startup
  └── asyncio.create_task(options_logger.run())
        └── loop every 60s (market hours only)
              ├── fetch NIFTY front-week chain
              ├── fetch NIFTY next-week chain
              ├── fetch SENSEX front-week chain
              ├── fetch SENSEX next-week chain
              └── bulk INSERT ATM ± 5 strikes into options_tick.sqlite
```

The loop:
1. Checks if current time is within market hours (9:15–15:30 IST)
2. If outside hours: sleeps 60s and re-checks
3. If inside hours: fetches 4 chains via existing `broker.get_options_chain()` and `broker.get_expiries()`
4. For each chain, computes ATM = `round(spot / step) * step` (step=50 for NIFTY, 100 for SENSEX)
5. Filters to ATM ± 5 strikes
6. Bulk-inserts all rows in a single transaction
7. Sleeps 60s

### Database: `db/options_tick.sqlite`

Single table `options_ticks`:

```sql
CREATE TABLE options_ticks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,        -- ISO 8601: "2026-04-15T10:05:00"
    index_name  TEXT NOT NULL,        -- "NIFTY" | "SENSEX"
    expiry      TEXT NOT NULL,        -- "2026-04-17"
    spot        REAL NOT NULL,        -- underlying spot price
    strike      REAL NOT NULL,        -- option strike
    ce_ltp      REAL,
    ce_oi       INTEGER,
    ce_volume   INTEGER,
    ce_iv       REAL,
    ce_delta    REAL,
    ce_gamma    REAL,
    ce_theta    REAL,
    ce_vega     REAL,
    pe_ltp      REAL,
    pe_oi       INTEGER,
    pe_volume   INTEGER,
    pe_iv       REAL,
    pe_delta    REAL,
    pe_gamma    REAL,
    pe_theta    REAL,
    pe_vega     REAL,
    pcr         REAL,                 -- chain-level put-call ratio
    max_pain    REAL
);

CREATE INDEX idx_options_ticks_lookup
    ON options_ticks (index_name, expiry, strike, ts);

CREATE INDEX idx_options_ticks_ts
    ON options_ticks (ts);
```

**Size estimate:** 11 strikes × 4 chains × 375 min/day = ~16,500 rows/day @ ~200 bytes/row = ~3.3 MB/day, ~66 MB/month.

### API: `GET /options/ticks`

Added to existing `backend/routers/options.py`.

Query params:
- `index` — "NIFTY" | "SENSEX" (required)
- `date` — "YYYY-MM-DD" (required)
- `expiry` — "YYYY-MM-DD" (optional, defaults to first available that day)
- `strike` — float (optional, returns all ATM ± 5 if omitted)

Returns: array of tick rows sorted by `ts`, ready for charting or pandas ingestion.

## Startup Integration

In `backend/main.py`, inside the `lifespan` async context manager:

```python
from backend.services import options_logger
asyncio.create_task(options_logger.run())
```

No new dependencies — reuses existing broker adapters and `aiosqlite`.

## Error Handling

- If a chain fetch fails (broker error / timeout): log warning, skip that chain for this tick, continue
- If DB write fails: log error, skip, do not crash the loop
- If broker returns an empty chain: skip silently
- The loop never raises — a single failed tick is discarded, not retried

## What Is NOT in Scope

- Logging crypto options (no options chain available via broker)
- All expiries (only front-week + next-week)
- All strikes (only ATM ± 5)
- Real-time WebSocket streaming (polling every 60s is sufficient)
- A dedicated backtest UI (existing backtest page can query the new endpoint)
