# US Stocks — Symmetric Short-Selling (Sub-project A)

_Design spec · 2026-07-06_

## Context

Sub-project A of the four-part US-market effort (A short-selling → B analytics →
C context → D strategies). **B shipped first** (analytics, merged 2026-07-05);
A is now the first *build-order* item. Goal: let the US paper bot trade the SHORT
setups the scanner already finds — doubling the tradeable universe.

### Decisions locked during brainstorming
- **Direction-agnostic sessions**: each strategy evaluates both its long and short
  condition every tick and fires whichever triggers. One session can go long one
  day, short the next. No pinned-direction session param. This also makes the
  `by_direction` split in the B analytics meaningful.
- **Symmetric-mirror short conditions**: each short is the exact inverse of its
  long, reusing thresholds already present in the codebase.

### Phase constraint
A modifies the **live paper bot loop** (`us_stocks_bot.py`). This is allowed
because US/Alpaca is paper-only and separate from the NSE Phase-3 gate, and
**no real Alpaca short orders are wired** — order routing stays the same stubbed
paper simulation used for longs today (`us_stocks_live_trading` order path is
still "v2 wiring", untouched here).

### What exists today
- `us_stocks_bot.py` — 3 long-only strategies. Every exit/PnL/trail calc is
  hardcoded long: `price >= target`, `price <= sl`, `pnl = (exit − entry)×qty`,
  SL trails *up* to breakeven at 1R. `_place_paper_trade` hardcodes `action='LONG'`.
- `us_stocks_context.build_us_stock_data` already exposes every field a short
  mirror needs: `bb_up` (upper band), `ema20`, `rsi`, `atr`, `trend` (incl.
  `DOWN`/`STRONG_DOWN`), and `opening_range.broke_below`.
- `us_scanner.py` already detects short setups (`BREAKDOWN`, `BEAR_RALLY`,
  `OVERBOUGHT_FADE`, `GAP_DOWN_HOLD`, `GAP_UP_FADE`, `NEAR_RECENT_LOW`) but
  `SETUP_TO_STRATEGY` maps them all to `None` with the comment "long-only bots".
- `page.tsx` scanner cards show "SHORT signal · v1 is long-only" and disable the
  Start button when `bias === "SHORT"`; the trade/action badge is always green.
- Risk gates in the bot loop (entry window, daily loss cap, trade cap,
  consecutive-loss breaker, post-entry cooldown) are all direction-agnostic
  already — no change needed. There is no NSE-style daily bias gate on US.

## Design

### 1. Direction-aware trade mechanics (correctness-critical)

Introduce a direction sign derived from the trade's stored `action`:
`LONG → +1`, `SHORT → −1`. Add a helper:

```python
def _dir_sign(action: str) -> int:
    return -1 if action == "SHORT" else 1
```

Thread it through every price comparison and PnL calc:

| Calc | Today (long-only) | Generalized (sign `s`) |
|---|---|---|
| Entry re-anchor (`_bot_loop`) | `sl=entry−slΔ`, `tgt=entry+tgtΔ` | `sl=entry − s·slΔ`, `tgt=entry + s·tgtΔ` |
| Target hit (`_manage_open_trade`) | `price >= target` | `s·(price − target) >= 0` |
| SL hit | `price <= eff_sl` | `s·(price − eff_sl) <= 0` |
| Unrealized/realized PnL | `(exit − entry)·qty` | `(exit − entry)·qty·s` |
| Trail → BE at 1R (`_trail_sl`) | ratchet SL *up* to entry | ratchet SL to entry; `max` for long, `min` for short |

`_trail_sl` becomes direction-aware:

```python
def _trail_sl(entry, current, original_sl, sign):
    risk = abs(entry - original_sl)
    if risk <= 0:
        return original_sl
    if sign * (current - entry) / risk >= TRAIL_BE_R:
        return entry            # breakeven
    return original_sl
```

and the caller ratchets by sign:

```python
trailing = _trail_sl(entry, price, original_sl, sign)
effective_sl = max(trailing, original_sl) if sign > 0 else min(trailing, original_sl)
```

`_place_paper_trade(session_id, symbol, action, entry, sl, target, reason, confluence)`
gains an `action` param and inserts it instead of the literal `'LONG'`.
`_close_paper_trade` reads `action` from the open-trade row for the PnL sign.
`_manage_open_trade` reads `action` from the row it already SELECTs.
`_position_size(entry)` is unchanged — share count by notional works for both.

### 2. Short conditions — exact mirrors

Each evaluator picks long *or* short from the same tick; a symbol cannot satisfy
both sides simultaneously (opposite RSI/band/trend regimes), so no conflict.

- **`_eval_us_orb`** — add a `broke_below` branch mirroring `broke_above`:
  `orng.broke_below` true, `or_low > 0`, extension guard
  `(or_low − price)/or_low <= 0.005` (don't chase), `vol_ratio >= 1.0`, `atr > 0`.
  `sl = price + atr·SL_R_MULT`, `tgt = price − atr·SL_R_MULT·TGT_R_MULT`.
  Confluence base 4; +1 if 1h trend in `("DOWN","STRONG_DOWN")`; +1 if
  `vol_ratio >= 1.5`; +1 if extension `< 0.002`. Sets `orb_fired[symbol]=today`
  (one ORB trade per symbol/day, either direction).
- **`_eval_us_trend_pullback`** — mirror of the long:
  long branch when 1h `UP/STRONG_UP` + 5m RSI 35–48 + `price >= ema20·0.998`;
  **short branch** when 1h `DOWN/STRONG_DOWN` + 5m RSI **52–65** +
  `price <= ema20·1.002` (rejection at EMA). `sl = price + atr·SL_R_MULT`,
  `tgt = price − atr·SL_R_MULT·TGT_R_MULT`. Confluence base 4; +1 if `STRONG_DOWN`;
  +1 if `vol_ratio >= 1.2`; +1 if `56 <= rsi <= 62`.
- **`_eval_us_mean_reversion`** — mirror of the long:
  short branch when 1h **not** in `("STRONG_UP","UP")`, `price >= bb_up·0.995`,
  `rsi > 70`. `sl = price + atr·SL_R_MULT`; `tgt = bb_mid`; if `tgt >= price`
  fall back to `price − atr·SL_R_MULT·TGT_R_MULT` (target must be below entry for a
  short). Confluence base 4; +1 if `rsi > 75`; +1 if 1h in `("DOWN","STRONG_DOWN")`;
  +1 if `price > bb_up`.

The existing `recommend` endpoint's `_suitability`/`waiting_for` hints stay
long-worded for now (display only; not blocking) — optional polish, not required.

### 3. Scanner + UI un-gating

- `us_scanner.SETUP_TO_STRATEGY`: replace the `None`s for short setups:
  `BREAKDOWN`, `BREAKDOWN_LOW_VOL`, `GAP_DOWN_HOLD`, `GAP_UP_FADE` → `us_orb`;
  `BEAR_RALLY`, `NEAR_RECENT_LOW` → `us_trend_pullback`;
  `OVERBOUGHT_FADE` → `us_mean_reversion`. `VOLUME_SURGE` stays `None`
  (bias ambiguous, no clean strategy — same treatment as the long side).
- `page.tsx`:
  - The Start button already lights up when `suggested_strategy && account?.ok`,
    so mapping the setups is most of the work. Remove the now-stale
    `r.bias === "SHORT" ? "SHORT signal · v1 is long-only"` fallback branch
    (keep the "Connect Alpaca" and "No matching bot strategy" fallbacks).
  - Color the SHORT action badge red (`#b91c1c` on `#fee2e2`) in the trades
    table and anywhere the action chip renders; LONG stays green.

### 4. Testing

`backend/tests/test_us_stocks_shorts.py` (new), TDD, written first:
- **Eval**: each strategy returns a `SHORT` tuple with `sl > entry > target` when
  fed mirrored inputs (downtrend / upper-band / break-below fixtures); returns the
  existing `LONG` tuple on long inputs (no regression).
- **`_trail_sl`**: short at 1R profit returns entry (BE); the caller's `min`
  ratchet holds SL from loosening.
- **`_manage_open_trade`**: seed a SHORT `bot_trades` row, monkeypatch
  `get_latest_trade_price`; assert exit as `TARGET_HIT` when `price <= target`,
  as `SL_HIT` when `price >= effective_sl`, and correct PnL sign
  (`(entry − exit)·qty > 0` for a winning short).
- **`_place_paper_trade`**: persists `action='SHORT'` and positive qty.
- Existing US analytics tests and the strategy pre-commit suite stay green.

## Out of scope (explicit)

- No real Alpaca short-order routing — paper simulation only (same as longs).
- No market-regime / SPY-QQQ filter (sub-project C).
- No pinned-direction session param (agnostic chosen).
- No new page, scheduler job, or broker integration.

## Files touched

| File | Change |
|---|---|
| `backend/services/us_stocks_bot.py` | direction sign helper; 3 short eval branches; direction-aware `_place_paper_trade` / `_close_paper_trade` / `_manage_open_trade` / `_trail_sl` / entry re-anchor |
| `backend/services/us_scanner.py` | map short setups → strategies in `SETUP_TO_STRATEGY` |
| `frontend/src/app/us-stocks/page.tsx` | drop stale "long-only" fallback; red SHORT badge |
| `backend/tests/test_us_stocks_shorts.py` | **new** — short eval + mechanics + no-regression |
| `code_map.md` (memory) | note US bot is now long+short |

## Follow-up / next sub-projects

After A: **C (richer context — SPY/QQQ regime, RS, gaps)** → **D (new
strategies)**, each its own spec → plan → build. Re-run the B analytics
`by_direction` split after a few short sessions to judge whether the short side
carries edge.
