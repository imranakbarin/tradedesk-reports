# Option A — vol_flow prune + intraday trend compass

**Date:** 2026-07-16
**Status:** Approved design, pending implementation
**Class:** Strategy prune + strategy param changes (always allowed under Phase 2 rules)

## Problem

Deep review (2026-07-16, data 2026-07-01 → 07-15) found the bots structurally long-biased:

- 29 of 34 closed trades were CE; index moved *against* the trade in 20 of 30 measurable trades.
- The common gate on every losing entry is the **daily** `trend_score` (`market_intelligence.py` — daily EMA20/50/200, daily RSI/MACD). After a bull run it stays >50 for weeks, so:
  - vol_flow generated 97 CE signals and 0 PE signals since Jul 1;
  - ORB/PDH PE conditions (`ts ≤ 48`) were unreachable;
  - the daily-bias override (`ts ≥ 65 → CE_ONLY`) forced call-only days on red days.
- vol_flow itself has no edge in either direction: 20 trades, 13% WR, ≈-7,400 real; shadow book contra also negative (-4,153, n=72 ≥ the n=40 judgment threshold).
- Net: -9,830 over 14 days; contra outperformed real by +12,476.

Two changes: **(1) prune vol_flow, (2) replace the daily trend_score with an intraday
trend score in intraday entry gates**, so PE entries become reachable on down days
while keeping the evidence-backed timing gates (5m-ST, 15m-RSI) intact.

## Change 1 — Prune vol_flow

- Disable `vol_flow` in the `STRATEGIES` dict in `backend/services/trading_bot.py`
  (same mechanism as prior prunes: `oi_velocity`, `smart_money_divergence`, …).
- Update the 16-strategy table in `backend/CLAUDE.md` (7 disabled after this).
- Record evidence in memory `project_strategy_prune_log.md`.
- Shadow/contra logging for vol_flow stops with it (no signals → no shadow rows);
  the n=72 shadow verdict is already recorded.
- Re-enable bar (standard): replay evidence, ≥20 trades, positive expectancy.

## Change 2 — `intraday_trend_score`

### Function

New pure function in `backend/services/trading_bot.py`:

```python
def intraday_trend_score(idx: dict, intraday: dict | None) -> int
```

Six binary bullish signals, equal weight, all from data already fetched per bot cycle
(no new API calls). Field names verified against `intraday_signals.py` output:

| # | Signal | Source |
|---|---|---|
| 1 | 5m Supertrend LONG | `intraday["5m"]["supertrend"]` |
| 2 | 15m Supertrend LONG | `intraday["15m"]["supertrend"]` |
| 3 | 15m RSI > 50 | `intraday["15m"]["rsi"]` |
| 4 | Price above VWAP | `intraday["5m"]["vwap_pos"] == "ABOVE"` |
| 5 | Price > day open | `idx["price"]`, `idx["day_open"]` |
| 6 | 15m price > 15m EMA21 | `intraday["15m"]["price"]`, `intraday["15m"]["ema21"]` |

`score = round((bulls + 0.5 * missing) / 6 * 100)` — denominator is always 6; a
**missing input contributes 0.5** (neutral — pulls toward 50, never crashes; if
`intraday` is None entirely, return 50).

Threshold conventions mirror today's daily-score usage so gate rewiring is mechanical:
≥55 bull gate · ≤45 bear gate · ≥65 / ≤35 extremes.

### Gate rewiring

| Gate (location as of 9c74fab2) | Today | After |
|---|---|---|
| PDH CE / PDL PE (`~1285`, `~1302`) | daily ts ≥52 / ≤48 | intraday ≥55 / ≤45 |
| ORB inside-bar CE/PE (`~1396`, `~1401`) | daily ts ≥52 / ≤48 | intraday ≥55 / ≤45 |
| ORB main CE/PE (`~1573`, `~1592`) | daily ts ≥52 / ≤48 | intraday ≥55 / ≤45 |
| Daily-bias extreme override (`~357-361`) | daily ts ≥65→CE_ONLY, ≤35→PE_ONLY | same thresholds on intraday score; gap-based ±0.3% bias unchanged |
| mtf_sniper (`~1331`) | daily ts>70 + price>ema50 | **keep daily condition** (multi-TF thesis) + require intraday ≥55 for CE / ≤45 for PE as added confirm |

### Explicitly unchanged

- `expiry_theta` (`ts >65 / <35`) — daily-regime strategy, only current winner.
- `candle_pattern` counter-trend safety gates (`ts ≥ 40`).
- 5m-Supertrend direction gate (issue #64 — kept with replay evidence 2026-06-30).
- 15m-RSI overbought/oversold gates and their daily-ts exemptions (`~4926`, `~4934`).
- SL-widening trend check (`~2582-2590`).
- snapback_scalper exemptions.
- vol_flow gate logic (moot — pruned).
- inst_flow — correction during planning: it has no trend_score gate (the `ts ≤55/≥45`
  bounds at ~1716/1733 belong to the already-pruned oi_velocity). Nothing to rewire.

### Observability

- New nullable column `bot_trades.intraday_score_entry` (additive `ALTER TABLE`,
  same pattern as `trend_score_entry`; backfilled NULL for old rows).
- Score included in SIGNAL/SKIP `bot_log` messages for the rewired gates.
- Purpose: weekly review can measure whether intraday score at entry predicts outcome.

## Testing

- Unit tests (new file under `backend/tests/`): score computation — all-bull → 100,
  all-bear → 0, mixed, missing 15m block, `intraday=None` → 50, missing single field.
- Gate direction tests for ORB / PDH / bias-override with synthetic `idx`/`intraday`
  dicts: verify PE reachable when intraday score ≤45 even if daily ts >65, and the
  reverse for CE.
- Full existing suite must pass (incl. ledger math + startup square-off suites).

## Rollout / rollback

- One commit. Rollback = revert that commit (column is additive; leaving it in place
  on revert is harmless).
- Judged at the next two weekly Monday reviews via `bot_analysis.py` + the new column.
- Success criteria: PE/CE trade mix reflects actual market direction; contra
  outperformance gap shrinks; Phase-3 gate weeks measured on the honest compass.

## Out of scope

- Charge-aware frequency caps (discussed, deferred).
- mtf_sniper redesign, log-table growth, stale `backend/db/trades.sqlite` doc fix
  (noted in review; separate items).
