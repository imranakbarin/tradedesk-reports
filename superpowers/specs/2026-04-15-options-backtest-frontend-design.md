# Options Backtest Frontend — Design Spec
**Date:** 2026-04-15
**Status:** Approved

## Goal

Replay NSE bot strategies against real logged options tick data (from `options_tick.sqlite`) so trades are simulated using actual CE/PE premiums, OI, and IV — not synthetic yfinance price estimates. Surface the results in a new tab on the existing backtest page.

## Scope

- **Strategies:** All 8 NSE bot strategies (mtf_sniper, oi_sr_simple, ema_reversion, rsi_extremes, bb_squeeze, vwap_pull, trend_pullback, momentum_burst)
- **Indices:** NIFTY and SENSEX
- **Expiry selection:** Front-week or next-week (user-selectable)
- **Entry/exit pricing:** CE/PE LTP from `options_tick.sqlite` at the signal bar and exit bar
- **P&L denomination:** Option premium terms — `(exit_ltp − entry_ltp) × lot_size`
- **SL/target trigger:** Spot price movement (1.5× ATR stop, 2.5× ATR target) — same as live bot
- **UI placement:** New "Options Backtest" tab on the existing `/backtest` page

## What Is NOT in Scope

- Crypto backtesting against options data
- All-strikes P&L (only ATM strike is traded)
- Strategy comparison (one strategy per run)
- Real-time streaming of backtest progress
- Any changes to the existing "Price Backtest" tab

## Architecture

### New files

```
backend/services/options_backtest_engine.py   — core replay engine
backend/routers/options_backtest.py           — API endpoints
```

### Modified files

```
backend/main.py                               — register new router
backend/models/backtest.py                    — add OptionsBacktestRequest
frontend/src/app/backtest/page.tsx            — add Options Backtest tab
```

### Data flow

```
POST /options-backtest/run
  └── options_backtest_engine.run_options_backtest(request)
        ├── query options_tick.sqlite → minute bars (spot + ATM CE/PE LTP + OI/IV)
        ├── compute RSI(14), EMA(20/50), ATR(14), BB(20,2σ), trend_score on spot
        ├── bar-by-bar replay (start at bar 35):
        │     ├── if in_trade: check spot vs SL/target → exit at CE/PE LTP
        │     └── if flat: run strategy signal fn → enter at CE/PE LTP
        └── return BacktestResponse (metrics + trades + equity_curve)
```

### ATM strike selection

At each bar: `atm = round(spot / step) * step` (step=50 NIFTY, 100 SENSEX). Look up that strike's CE/PE LTP from the tick log. If ATM strike is not present in the tick (edge case: sparse data), use the nearest available strike.

### Lot sizes

NIFTY = 65, SENSEX = 20. Sourced from existing `nse_lot_sizes` constant. Never hardcoded.

## Data Model

### `OptionsBacktestRequest` (new, in `backend/models/backtest.py`)

```python
class OptionsBacktestRequest(BaseModel):
    index_name:  str            # "NIFTY" | "SENSEX"
    strategy:    str            # e.g. "mtf_sniper"
    from_date:   str            # YYYY-MM-DD
    to_date:     str            # YYYY-MM-DD
    expiry_type: str = "front"  # "front" | "next"
    capital:     float = 100_000.0
```

### Response

Reuses existing `BacktestResponse`. Option type (CE/PE), strike, and expiry are carried in `TradeRecord.strategies` as a list entry, e.g. `["mtf_sniper", "CE@24000", "exp:2026-04-17"]`. This avoids schema changes to `TradeRecord` while preserving all context.

## API Endpoints

Both in `backend/routers/options_backtest.py`, mounted at `/options-backtest`.

### `POST /options-backtest/run`

- **Body:** `OptionsBacktestRequest`
- **Response:** `BacktestResponse`
- **Errors:**
  - 400 if no tick data exists for the requested index/date range
  - 400 if fewer than 35 bars available (not enough to compute indicators)
  - 500 on engine failure

### `GET /options-backtest/available`

Queries `options_tick.sqlite` to return what data exists. Used by the frontend to populate dropdowns and disable the form when no data is available.

```json
{
  "NIFTY":  { "min_date": "2026-04-15", "max_date": "2026-04-15", "expiries": ["2026-04-17", "2026-04-24"] },
  "SENSEX": { "min_date": "2026-04-15", "max_date": "2026-04-15", "expiries": ["2026-04-18", "2026-04-25"] }
}
```

## Engine: `options_backtest_engine.py`

### Step 1 — Load ticks

```python
SELECT ts, spot, strike, ce_ltp, pe_ltp, ce_oi, pe_oi, ce_iv, pe_iv
FROM options_ticks
WHERE index_name = ? AND expiry = ? AND ts BETWEEN ? AND ?
ORDER BY ts
```

Group by timestamp. At each timestamp, identify the ATM strike and pull its CE/PE LTP. Build a DataFrame of minute bars: `(ts, spot, ce_ltp, pe_ltp, ce_oi, pe_oi, ce_iv)`.

### Step 2 — Compute indicators

On the `spot` column:
- `rsi` — RSI(14), Wilder smoothing
- `ema20`, `ema50` — exponential moving averages
- `atr` — ATR(14) using high/low approximated as `spot ± 0.001 × spot` (tick data has no OHLC; use spot as proxy with a ±0.1% band)
- `bb_upper`, `bb_lower` — Bollinger Bands (20-bar SMA ± 2σ)
- `trend_score` — 0–100: +25 each for (spot > ema20), (ema20 > ema50), (rsi > 50), (spot in upper BB half)

### Step 3 — Signal functions

One pure function per strategy. Signature:

```python
def signal_<name>(bar: dict, indicators: dict) -> tuple[str, str] | None:
    # Returns ("CE"|"PE", reason_string) or None
```

`bar` contains: `ts, spot, ce_ltp, pe_ltp, ce_oi, pe_oi, ce_iv`
`indicators` contains: `rsi, ema20, ema50, atr, bb_upper, bb_lower, trend_score`

Strategies that use OI (`oi_sr_simple`) read real OI from the bar dict — key advantage over the yfinance engine which had no OI data.

### Step 4 — Replay loop

```
equity = capital
lot_size = LOT_SIZES[index_name]

for i in range(35, len(bars)):
    bar = bars[i]
    indicators = computed_indicators[i]

    if in_trade:
        if spot <= sl_spot:   exit at bar.ce_ltp or bar.pe_ltp; result = LOSS
        if spot >= tgt_spot:  exit at bar.ce_ltp or bar.pe_ltp; result = WIN
        if i == last_bar:     exit at close ltp; result = TIMEOUT

    else:
        signal = signal_fn(bar, indicators)
        if signal:
            option_type, reason = signal
            entry_ltp = bar.ce_ltp if option_type == "CE" else bar.pe_ltp
            sl_spot   = spot - 1.5 * atr   (CE) | spot + 1.5 * atr (PE)
            tgt_spot  = spot + 2.5 * atr   (CE) | spot - 2.5 * atr (PE)
            in_trade  = True
```

P&L on exit: `(exit_ltp - entry_ltp) * lot_size` (CE and PE both profit when premium rises relative to entry).

### Error handling

- If ATM strike missing for a bar: skip that bar (do not enter, do not exit early)
- If entry_ltp is zero or None: skip signal
- Engine never raises — errors are logged and the bar is skipped

## Frontend: Options Backtest Tab

**File:** `frontend/src/app/backtest/page.tsx`

Add a tab switcher at the top: `[ Price Backtest ] [ Options Backtest ]`

Options Backtest tab form fields:
| Field | Type | Notes |
|---|---|---|
| Index | Toggle | NIFTY / SENSEX |
| Strategy | Dropdown | All 8 NSE bot strategy names |
| Expiry | Toggle | Front-week / Next-week |
| Date range | Date pickers | Clamped to `available.min_date` / `available.max_date` |
| Capital | Number input | Default 100,000 |

**Empty state:** If `GET /options-backtest/available` returns no data for the selected index, show:
> "No options tick data logged yet. The logger runs automatically during market hours (9:15–15:30 IST)."

**Results:** Renders the same equity curve SVG and metrics grid already built into the page. No new UI components.

## Startup

New router registered in `backend/main.py`:

```python
from backend.routers import options_backtest
app.include_router(options_backtest.router, prefix="/options-backtest", tags=["options-backtest"])
```

No new dependencies. Uses `aiosqlite` (already present) for tick reads and `pandas`/`numpy` (already present) for indicator computation.
