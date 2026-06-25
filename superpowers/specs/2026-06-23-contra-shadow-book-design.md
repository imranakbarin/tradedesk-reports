# Contra Shadow Signal Book — Design

## Background

Every real bot trade today triggers an unconditional "contra" paper trade in the opposite
direction (CE↔PE), at an ITM strike, purely for observation — no capital sizing, no risk
rules, exit slaved to the real trade's close. `scripts/_contra_analysis.py` compares real
vs. contra win rate / PnL to flag possible front-running. **This existing mechanism is not
modified by this spec — it keeps running exactly as-is, in parallel.**

90-day data (`_contra_analysis.py --days 90`): 37 closed pairs, contra beats real in 31/37
(84%), +₹37,959 swing in contra's favor. This is a large, persistent effect across 8
strategies, not a single-strategy artifact — worth a structured trial rather than ignoring it.

The open question: should any of this translate into actually trading the contra direction?
This spec covers a new, separate 2-week observational trial to gather enough data to decide
— not a decision to flip any strategy yet, and not a change to the existing contra mechanism.

## Goal

Add a new, independent "shadow signal" book that runs alongside (not instead of) the
existing real-paired contra mechanism, with enough sample size per strategy to make a real
go/no-go call on trading the opposite direction — without touching the real bot's strategy
logic, risk state, capital pool, or the existing contra mechanism's code/data/reporting.

## Non-goals

- **Not touching the existing real-paired contra mechanism at all.** `_place_contra_trade`,
  its `CONTRA_OPEN`/`CONTRA_CLOSED` statuses, its mirrored-exit logic, and
  `scripts/_contra_analysis.py` keep running exactly as they do today, untouched. The new
  "shadow signal" mechanism below is purely additive — a second, independent system, not a
  modification of the first. They are kept separate in code, in data (no shared
  status/table), and in reporting (separate analysis script, not an extension of the
  existing one).
- Not loosening any strategy's entry thresholds (RSI bands, confluence minimums, etc.) —
  that's a separate idea, explicitly deferred.
- Not changing the real bot's exit logic for either contra mechanism.
- Not enabling this for any currently-disabled strategy. Scope is the 9 active strategies:
  `mtf_sniper`, `pdh_pdl_break`, `candle_pattern`, `expiry_theta`, `oi_sr_simple`,
  `gamma_blast_scalper`, `orb_breakout`, `inst_flow`, `vol_flow`.
- Not a Phase-gate change. `LIVE_TRADING` stays `false`; this trial's outcome is separate
  bookkeeping from the Phase 3 "2 profitable paper weeks" gate.

## Problem: the existing mechanism's 1:1 pairing would starve a 2-week trial

The existing contra only fires when a real trade is *placed*. On 2026-06-23, only 1 real
trade fired across all 9 active strategies (`vol_flow`), so only 1 contra pair was produced.
At that pace, 2 weeks yields too few samples per strategy to judge anything — which is why
this spec adds a second, independent mechanism rather than just running the existing one
longer.

Investigating why other strategies didn't trade today (`bot_log`, 2026-06-23) showed the
gates are working as designed, not broken:

- `mtf_sniper`: 561 skips, **100% from the 10:00-12:00 time-block** (the Jun 18 tuning that
  found that window a net loser for the real direction — the *opposite* direction in that
  window has never been tested).
- `candle_pattern`: 272 raw signals fired, **all 272 vetoed** by directional confirmation
  filters (RSI oversold / 5m Supertrend conflicting with the bearish call) before a real
  trade was ever placed. Today's 1:1 contra mechanism gets 0 samples from this strategy
  despite 272 raw signals.
- `orb_breakout`: blocked by a VWAP momentum-confirmation gate before the hold-timer starts.

## Design

### 1. New hook point: raw signal, independent of the existing mechanism

A new, additive code path fires on the **raw signal** returned by `_evaluate_strategy`,
before downstream confirmation filters, time-blocks, or risk caps are applied to the real
trade. This is separate from — and runs in addition to — the existing
`_place_contra_trade` call that still fires after a real entry clears every gate
(`trading_bot.py:4630`), which is left untouched.

This requires each strategy's gate checks (time-block, directional veto, VWAP confirmation)
to surface the would-be direction even when they ultimately skip the real entry — i.e. the
skip path needs to carry "would have been CE/PE here" forward to the new hook, not just log
a SKIP and return `None`. This is the main implementation work; it touches each active
strategy's gate checks but not their core signal-detection logic or thresholds, and not the
existing contra mechanism.

### 2. Shadow-side dedup/cooldown

A raw signal can persist across many consecutive scan cycles (e.g. RSI oversold holding for
several minutes produces dozens of identical SKIPs). The shadow mechanism needs its own
cooldown — proposed default **20 minutes per (strategy, index, direction)** — independent of
both the real strategy's cooldown state and the existing contra mechanism, so one persistent
setup doesn't flood the shadow book with near-duplicate trades.

### 3. Shadow capital & risk tracking

- Dedicated pool: `CONTRA_SHADOW_CAPITAL = ₹1,00,000`, fully separate from the real bot's
  `TOTAL_CAPITAL` (₹5,00,000) and from the existing contra mechanism (which has no capital
  pool at all). Shadow trades size lots against this pool's 1% risk-per-trade.
- New counters (`_shadow_strategy_daily_losses`, `_shadow_global_daily_pnl`), persisted in
  their own section of `db/bot_state.json`, separate from both the real bot's existing
  counters and any state the existing contra mechanism uses.
- These counters are **informational only** — they never block a shadow entry. Every raw
  signal gets a shadow trade, for maximum data over the 2-week window.
- The real bot's existing risk state, capital pool, circuit breakers, and the existing
  contra mechanism's behavior are completely untouched.

### 4. Exit logic: independent, not mirrored

Unlike the existing contra mechanism (which mirrors its paired real trade's close), shadow
trades frequently have **no real trade to mirror** — that's the entire point for strategies
like `candle_pattern` (272 vetoed signals, 0 real trades) and `mtf_sniper` (561 time-blocked
signals, 0 real trades in that window). Shadow trades therefore manage their own close,
reusing the existing `_dynamic_sl_tgt` SL/target sizing function (already used by
`_place_contra_trade` for realistic levels) but running it standalone, independent of any
real trade's lifecycle.

### 5. Reporting: a new, separate script

A new script, `scripts/_contra_shadow_analysis.py`, reports the shadow book's win
rate/PnL/capital-adjusted return per strategy, plus the (non-blocking) shadow daily-loss/
strategy-loss counters. `scripts/_contra_analysis.py` is **not modified** — it continues to
report only on the existing real-paired contra mechanism, exactly as today.

## Decision criteria (end of trial)

Manual review, not automated — most likely folded into the next 1-2 weekly reviews. For
each of the 9 active strategies, look at both the existing real-paired contra data and the
new shadow book's: sample size, capital-adjusted win rate/PnL vs. real, and whether the
divergence is consistent enough (not a 1-2 trade fluke) to justify flipping that specific
strategy's live direction. No commitment yet to flip anything — this trial's only job is to
produce a large enough sample to make that call.

## Testing

- Unit-level: shadow-cooldown dedup logic (same raw signal repeated within 20min produces
  one shadow trade, not many).
- Unit-level: shadow capital lot-sizing math and standalone `_dynamic_sl_tgt`-based exit,
  independent of any real trade's lifecycle.
- Integration: verify the real bot's existing risk/capital state, and the existing contra
  mechanism's behavior, are both completely unaffected when the new shadow logic runs
  alongside them — this is the main safety property of the design.
- `scripts/_contra_shadow_analysis.py`: verify it correctly reports shadow-only data and
  computes capital-adjusted returns against the ₹1,00,000 shadow pool, without touching or
  depending on `_contra_analysis.py`.
