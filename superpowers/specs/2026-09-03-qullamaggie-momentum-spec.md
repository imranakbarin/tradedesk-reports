# Qullamaggie Momentum Rules — Reference Spec

Compact, implementation-ready summary of Kristjan Kullamägi's ("Qullamaggie")
three setups, for use as input when adapting entry/exit/risk logic in our bots.

## Source caveat (governs how this is read)

`qullamaggie.com` is egress-blocked from the session that compiled this, so
every rule below comes from **secondary sources** (his quoted posts, interview
transcripts, TradingView scripts documenting his rules), cross-referenced
across 3+ independent sources per claim. Where sources disagree the range is
given rather than a single number. Treat exact constants as approximate;
treat the *structure* (which gates exist, in what order) as the durable part.

**Instrument mismatch — read before implementing.** These rules are for
**US equities, swing-held for days-to-weeks**. Our bots trade **NIFTY/SENSEX
intraday index options**. Do not transplant literally: a 10-day-MA trail is
meaningless on an option you exit by 15:20, and "prior move of 30-100% over
1-3 months" describes an underlying, not a weekly option premium. What
transfers is the **gate structure** (§5), applied to the underlying index and
to position sizing — not the holding periods or the instruments.

---

## 1. Universe / screener

| Filter | Value | Rationale |
|---|---|---|
| ADR% | > 5% | Daily range must be wide enough to pay multiples of risk in days |
| Dollar volume | > $100M | Institutional liquidity only; excludes unfillable names |
| Ranking scan | Top % gainers over 1w / 1m / 3m / 6m, run weekly | Builds the watchlist; setups only traded on names already on it |
| Excluded | Low-quality penny stocks | Even when they pattern-match |

Watchlist is built **weekly**; entries fire intraday off that fixed list. He
does not scan for entries in real time across the whole market.

## 2. The three setups (this is the entire playbook)

### 2.1 Breakout

- **Prior move:** 30-100%+ within the last 1-3 months. *Non-negotiable gate.*
- **Consolidation:** orderly pullback, higher lows, tightening range, 2 weeks
  to 2 months; price rides the rising 10/20 (sometimes 50) DMA.
- **Entry:** break of opening-range high — 1min, 5min or 60min candle high
  (timeframe is discretionary; faster stock → shorter candle).
- **Stop:** low of day, and **never wider than 1× ADR**.
- **Exit:** sell 1/3-1/2 after 3-5 days → stop to breakeven on the rest →
  trail remainder on the 10 DMA (fast movers) or 20 DMA (slower).

### 2.2 Episodic Pivot (EP)

- **Gap:** ≥ 10% on the open.
- **Volume:** multiples of average, ideally **10×+**, visible in premarket or
  the first 5-10 min.
- **Catalyst (mandatory):** earnings beat + guidance raise, regulatory/FDA
  approval, major contract, sector repricing. A gap with no catalyst is
  rejected — this is the filter that separates EPs from noise gaps.
- **Entry:** near opening-range high, within the first hour.
- **Stop:** low of day — deliberately wide; EPs shake out hard before running.
- **Frequency:** rarest of the three; clusters in 3-4 week windows per quarter
  around earnings season.

### 2.3 Parabolic Short

- **Extension:** up 3-5+ consecutive days and accelerating. Large caps
  50-100%+; small caps 300-1000%+.
- **Timing gate:** never day 1, rarely day 2. Waits for **day 3-5**, when
  extended *and* showing the first structural crack.
- **Trigger (any):** opening-range-low break on 1/5min; first red 5min candle
  after a gap-up; or his preferred — **failed bounce back into VWAP**.
- **Stop:** high of day, or VWAP reclaim if VWAP was the trigger.
- **Target:** 10 DMA / 20 DMA — where these first bounce.

## 3. Market regime filter

- Index (SPY/QQQ): **10 DMA > 20 DMA → breakouts and EPs are tradeable.**
- **10 DMA crosses below 20 DMA → stand aside entirely.** Same setups fail
  repeatedly in that regime; he sits in cash rather than downsize.
- Explicit philosophy: money is made in short favourable windows, not by
  being continuously in the market.

## 4. Risk & sizing

- **Risk per trade: 0.25-1%** of equity, most trades at the low end. Rarely
  above 1% (some sources: up to 1.5% when the account was small).
- **Stop must fit inside 1× ADR.** If the ADR-implied stop would breach the
  risk budget → **size down or skip**. Never widen the risk budget to fit the
  stop.
- **Position size:** typically 10-20% of account; hard cap **30% overnight**
  in any single name.
- **Pyramiding:** adds only on confirmed strength (new intraday highs, or a
  pullback holding above entry / 10 EMA). Each add **smaller** than the last;
  stop moves up with every add so blended risk never increases. Never averages
  down. A fresh setup in a held name is treated as a **new trade** with its own
  entry/stop, not an arbitrary add.

## 5. What actually transfers to our bots (the gate structure)

Ordered as a rejection cascade — each gate kills the trade before the next is
evaluated. This is the part our current bots are missing.

1. **Regime gate (portfolio-level).** Index 10 DMA vs 20 DMA on NIFTY/SENSEX.
   Below → no new entries that session, any strategy. Our `orb_breakout` went
   **0-for-12 (-Rs 11,494)** with no regime gate at all.
2. **Prior-move gate (setup-level).** A breakout requires a *pre-existing*
   directional move to break out of. We currently fire ORB/MTF entries with no
   prior-move precondition — that is the difference between a breakout and a
   coin flip on a range boundary.
3. **Volatility-bounded stop.** Stop width ≤ 1× ADR of the underlying, and if
   the resulting risk exceeds budget, **skip the trade** rather than take it
   with a wider stop. Our `SMART_EXIT` path currently converges to near-full-SL
   losses (avg -Rs 710 vs -Rs 937 on a full SL) — the exit is late because the
   stop was never volatility-bounded at entry.
4. **Catalyst/participation gate.** EP's 10× volume + real catalyst is the
   analogue of a genuine OI/volume confirmation on our side — a signal without
   abnormal participation is rejected outright, not scored down.
5. **Scoring must be validated, not assumed.** His gates are binary rejections.
   Our `confluence` score is a soft 0-10 that showed **zero correlation with
   outcome** (score 9 averaged -Rs 413/trade, score 7 was the single worst
   bucket at -Rs 11,054 total). Either bind each component to a measured
   rejection threshold or drop the score.
6. **Asymmetric exit.** Partial off early → breakeven stop → trail the
   remainder. Our current distribution is the inverse: 22 `TARGET_HIT` winners
   (+Rs 30,313) against 84 `SL_HIT`/`SMART_EXIT` losers (-Rs 65,549).

## 6. Open questions before implementing

- What is the intraday analogue of "prior move 30-100% over 1-3 months" for a
  NIFTY weekly option — a multi-session trend score on the underlying, or an
  intraday opening-drive threshold? Needs backtesting, not assumption.
- Does the 10/20 DMA regime gate hold on NIFTY/SENSEX, or does the Indian
  index need different lookbacks? Testable directly against `db/options_tick.sqlite`.
- Per the block-freeze rule in root `CLAUDE.md`: n<20 → extend, don't decide.
  Any gate added here needs its own out-of-sample validation before going live.
