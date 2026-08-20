# NIFTY/SENSEX Strategy Discovery Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two read-only analysis scripts — `scripts/strategy_sweep.py` (parametrized signal-family sweep + walk-forward ranking + hybrid composite) and `scripts/regime_classify.py` (regime bucketing + per-bucket ranking) — against `db/options_tick.sqlite`, to find which strategy configs best fit NIFTY/SENSEX and whether that answer depends on market regime.

**Architecture:** Reuse `backend/services/options_backtest_engine.py`'s existing tick loader (`_load_ticks`) and indicator engine (`_compute_indicators`) exactly as `scripts/target_size_sweep.py` and `scripts/walk_forward_target.py` already do. Add 5 new parametrized signal-family generators (not the fixed named strategies in `_dispatch_signal`) with a small grid per family, run each through a shared bracket-simulation loop (R-multiple SL/target, same cost model as the existing sweep scripts), rank by profit factor with a walk-forward train/test split. `regime_classify.py` buckets sessions by `trend_score`/ATR-percentile and re-slices the same simulation results per bucket.

**Tech Stack:** Python 3.11, pandas, aiosqlite (async), reusing `backend/services/options_backtest_engine.py` and `backend/services/trading_bot.LOT_SIZES`-equivalent constants already exported from that module.

---

## File Structure

- Create: `scripts/strategy_sweep.py` — signal-family factory, parameter grid, bracket simulator, walk-forward train/test runner, hybrid composite, CLI.
- Create: `scripts/regime_classify.py` — session-level regime bucketing (trend-up/trend-down/range × high-vol/low-vol), per-bucket profit-factor ranking (imports and reuses `strategy_sweep.py`'s signal generators + simulator), "current regime" call-out, CLI.

Both are standalone scratch-analysis scripts (matches the existing convention in `scripts/*_replay.py`, `scripts/target_size_sweep.py`, `scripts/walk_forward_target.py` — no pytest suite for this class of script in this repo). Verification is "run it, read the output, confirm it's the expected shape" rather than unit tests, consistent with how `target_size_sweep.py`/`walk_forward_target.py` were built and verified.

---

### Task 1: Signal-family generators + parameter grid

**Files:**
- Create: `scripts/strategy_sweep.py` (this task writes the top of the file through the family generators)

- [ ] **Step 1: Write the file header, imports, and constants**

```python
"""
Strategy discovery sweep — hundreds of parametrized signal-family configs,
walk-forward ranked by profit factor, on real NIFTY/SENSEX options tick data.

Mirrors the ForexTraderVX R&D methodology (see
docs/superpowers/specs/2026-08-19-strategy-discovery-sweep-design.md):
5 signal families x threshold grid x SL/target R-multiple grid, each run
through the same walk-forward train/test split used by
scripts/walk_forward_target.py, ranked by profit factor.

CAVEAT: db/options_tick.sqlite covers ~79 days (since 2026-04-15) -- one,
maybe two market regimes, not multiple full cycles. Every result here is
provisional per the project's block-freeze rule (n<20 -> extend, don't
decide). Re-run as more live data accumulates.

Read-only: no bot code touched, no DB writes.

Usage:
  python scripts/strategy_sweep.py --index BOTH \
      --from 2026-04-15 --split 2026-07-01 --to 2026-08-19
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import aiosqlite
import pandas as pd

from backend.services.options_backtest_engine import (
    _load_ticks, _compute_indicators,
    LOT_SIZES, MIN_ENTRY_PREMIUM, MIN_BARS, OPTIONS_DB,
)

TXN_PER_RT = 81.0                 # Rs, NIFTY-calibrated (backend/CLAUDE.md)
SLIPPAGE_PCT_PER_SIDE = 0.0010    # 0.10%, per backend config

# SL/target bracket grid, applied to every family config.
STOP_GRID = [10.0, 15.0, 20.0]        # option premium points
RMULT_GRID = [1.5, 2.0, 2.5]          # target = stop * R

# Rolling lookback windows precomputed once for the breakout family.
BREAKOUT_WINDOWS = [10, 20, 30]       # bars (1-min ticks)

MIN_TEST_N = 20   # per block-freeze rule 2: below this, "extend", not a verdict
```

- [ ] **Step 2: Write the signal-family config + generator dataclass**

```python
@dataclass
class FamilyConfig:
    family: str
    params: dict
    fn: Callable[[dict, dict], tuple[str, str] | None]


def _trend_follow_configs() -> list[FamilyConfig]:
    """EMA20>EMA50 + trend_score threshold."""
    configs = []
    for th in (55, 60, 65, 70, 75):
        def make(th=th):
            def sig(bar: dict, ind: dict) -> tuple[str, str] | None:
                spot = bar["spot"]
                if spot > ind["ema20"] > ind["ema50"] and ind["trend_score"] >= th:
                    return ("CE", f"trend_follow th={th}")
                if spot < ind["ema20"] < ind["ema50"] and ind["trend_score"] <= 100 - th:
                    return ("PE", f"trend_follow th={th}")
                return None
            return sig
        configs.append(FamilyConfig("trend_follow", {"th": th}, make()))
    return configs


def _meanrev_configs() -> list[FamilyConfig]:
    """RSI extreme fade at a Bollinger Band touch."""
    configs = []
    for rl in (20, 25, 30):
        for rh in (70, 75, 80):
            def make(rl=rl, rh=rh):
                def sig(bar: dict, ind: dict) -> tuple[str, str] | None:
                    spot = bar["spot"]
                    if ind["rsi"] <= rl and spot <= ind["bb_lower"]:
                        return ("CE", f"meanrev rl={rl} (oversold bounce)")
                    if ind["rsi"] >= rh and spot >= ind["bb_upper"]:
                        return ("PE", f"meanrev rh={rh} (overbought fade)")
                    return None
                return sig
            configs.append(FamilyConfig("meanrev", {"rl": rl, "rh": rh}, make()))
    return configs


def _breakout_configs() -> list[FamilyConfig]:
    """Spot beyond rolling N-bar high/low. N read from precomputed columns."""
    configs = []
    for n in BREAKOUT_WINDOWS:
        def make(n=n):
            def sig(bar: dict, ind: dict) -> tuple[str, str] | None:
                spot = bar["spot"]
                if spot > ind[f"roll_high_{n}"]:
                    return ("CE", f"breakout N={n}")
                if spot < ind[f"roll_low_{n}"]:
                    return ("PE", f"breakout N={n}")
                return None
            return sig
        configs.append(FamilyConfig("breakout", {"n": n}, make()))
    return configs


def _oi_imbalance_configs() -> list[FamilyConfig]:
    """PCR extreme -> directional signal."""
    configs = []
    for pl, ph in ((0.6, 1.4), (0.7, 1.3), (0.8, 1.2)):
        def make(pl=pl, ph=ph):
            def sig(bar: dict, ind: dict) -> tuple[str, str] | None:
                pcr = bar["pcr"]
                if pcr <= pl:
                    return ("CE", f"oi_imbalance pcr<={pl} (call-heavy)")
                if pcr >= ph:
                    return ("PE", f"oi_imbalance pcr>={ph} (put-heavy)")
                return None
            return sig
        configs.append(FamilyConfig("oi_imbalance", {"pl": pl, "ph": ph}, make()))
    return configs


def _gamma_expiry_configs(expiry_dates: set[str]) -> list[FamilyConfig]:
    """Expiry-day trend_score extreme within a time window."""
    configs = []
    for th in (60, 65, 70):
        for h0, h1 in ((11, 12), (11, 13), (12, 13)):
            def make(th=th, h0=h0, h1=h1):
                def sig(bar: dict, ind: dict) -> tuple[str, str] | None:
                    ts = bar["ts"]
                    day = ts.strftime("%Y-%m-%d") if hasattr(ts, "strftime") else str(ts)[:10]
                    if day not in expiry_dates:
                        return None
                    hour = ts.hour if hasattr(ts, "hour") else int(str(ts)[11:13])
                    if not (h0 <= hour < h1):
                        return None
                    if ind["trend_score"] >= th:
                        return ("CE", f"gamma_expiry th={th} win={h0}-{h1}")
                    if ind["trend_score"] <= 100 - th:
                        return ("PE", f"gamma_expiry th={th} win={h0}-{h1}")
                    return None
                return sig
            configs.append(FamilyConfig("gamma_expiry", {"th": th, "h0": h0, "h1": h1}, make()))
    return configs


def all_family_configs(expiry_dates: set[str]) -> list[FamilyConfig]:
    return (
        _trend_follow_configs()
        + _meanrev_configs()
        + _breakout_configs()
        + _oi_imbalance_configs()
        + _gamma_expiry_configs(expiry_dates)
    )
```

- [ ] **Step 3: Verify the file parses and the generators produce configs**

Run:
```bash
cd d:/TradingApp && python -c "
import sys; sys.path.insert(0, '.')
from scripts.strategy_sweep import all_family_configs
cfgs = all_family_configs({'2026-06-25'})
print('total configs:', len(cfgs))
from collections import Counter
print(Counter(c.family for c in cfgs))
"
```
Expected: `total configs: 315` and a `Counter` showing `trend_follow: 5, meanrev: 9, breakout: 3, oi_imbalance: 3, gamma_expiry: 9`.

- [ ] **Step 4: Commit**

```bash
git add scripts/strategy_sweep.py
git commit -m "feat: add signal-family generators for strategy discovery sweep"
```

---

### Task 2: Rolling-window precompute + bracket simulator

**Files:**
- Modify: `scripts/strategy_sweep.py`

- [ ] **Step 1: Add the rolling-window precompute helper (append after Task 1's code)**

```python
def _add_breakout_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Adds roll_high_N / roll_low_N for each N in BREAKOUT_WINDOWS.

    Computed once, on the PRIOR N bars only (shift(1)) to avoid using the
    current bar's own spot in its own breakout level -- same look-ahead
    discipline as ForexTraderVX's signal generators (see RESEARCH_LOG.md
    'Signals are always computed on the previous completed bar').
    """
    spot = df["spot"].astype(float)
    for n in BREAKOUT_WINDOWS:
        df[f"roll_high_{n}"] = spot.shift(1).rolling(n).max()
        df[f"roll_low_{n}"] = spot.shift(1).rolling(n).min()
    return df
```

- [ ] **Step 2: Add the bracket simulator (R-multiple stop/target, profit factor)**

```python
def _simulate(bars: list[tuple[str, float, float, tuple[str, str] | None]],
              lot: int, min_prem: float,
              stop_pts: float, target_pts: float) -> dict:
    """bars = list of (day_str, ce, pe, signal). Returns stats incl. profit factor."""
    in_trade = False
    opt = ""
    entry = 0.0
    gross_l: list[float] = []
    cost_l: list[float] = []

    last = len(bars) - 1
    for i, (_d, ce, pe, sig) in enumerate(bars):
        is_last = (i == last)

        if in_trade:
            ltp = ce if opt == "CE" else pe
            gain = ltp - entry
            hit = None
            if gain >= target_pts:
                hit, pnl = True, target_pts * lot
            elif gain <= -stop_pts:
                hit, pnl = True, -stop_pts * lot
            elif is_last:
                hit, pnl = True, gain * lot
            if hit:
                gross_l.append(pnl)
                cost_l.append(TXN_PER_RT + entry * lot * SLIPPAGE_PCT_PER_SIDE * 2)
                in_trade = False

        if not in_trade and not is_last and sig:
            o = sig[0]
            ltp = ce if o == "CE" else pe
            if ltp >= min_prem:
                in_trade, opt, entry = True, o, ltp

    n = len(gross_l)
    if n == 0:
        return {"n": 0, "net": 0.0, "npt": 0.0, "wr": 0.0, "pf": 0.0}

    net_l = [g - c for g, c in zip(gross_l, cost_l)]
    gross_win = sum(x for x in net_l if x > 0)
    gross_loss = -sum(x for x in net_l if x < 0)
    pf = (gross_win / gross_loss) if gross_loss > 0 else (float("inf") if gross_win > 0 else 0.0)

    return {
        "n": n,
        "net": round(sum(net_l), 0),
        "npt": round(sum(net_l) / n, 0),
        "wr": round(sum(1 for x in net_l if x > 0) / n * 100, 1),
        "pf": round(pf, 2) if pf != float("inf") else pf,
    }
```

- [ ] **Step 3: Verify the simulator on a synthetic bar sequence**

Run:
```bash
cd d:/TradingApp && python -c "
import sys; sys.path.insert(0, '.')
from scripts.strategy_sweep import _simulate
bars = [
    ('2026-08-01', 100.0, 100.0, ('CE', 'test')),
    ('2026-08-01', 115.0, 90.0, None),   # +15 -> hits target
    ('2026-08-01', 100.0, 100.0, ('CE', 'test')),
    ('2026-08-01', 90.0, 110.0, None),   # -10 -> hits stop
]
stats = _simulate(bars, lot=65, min_prem=50.0, stop_pts=10.0, target_pts=15.0)
print(stats)
assert stats['n'] == 2
assert stats['pf'] > 0
print('OK')
"
```
Expected: prints a stats dict with `n: 2`, then `OK`.

- [ ] **Step 4: Commit**

```bash
git add scripts/strategy_sweep.py
git commit -m "feat: add breakout precompute columns + R-multiple bracket simulator"
```

---

### Task 3: Walk-forward runner + CLI

**Files:**
- Modify: `scripts/strategy_sweep.py`

- [ ] **Step 1: Add the per-config signal-series builder**

```python
async def _signal_series(cfg: FamilyConfig, df: pd.DataFrame) -> list[tuple[str, float, float, tuple[str, str] | None]]:
    """Runs one FamilyConfig's signal fn over every bar once."""
    bars = []
    for i in range(MIN_BARS, len(df)):
        row = df.iloc[i]
        ts = row["ts"]
        ce = float(row["atm_ce_ltp"])
        pe = float(row["atm_pe_ltp"])
        ind = {
            "ema20": float(row["ema20"]), "ema50": float(row["ema50"]),
            "rsi": float(row["rsi"]), "bb_upper": float(row["bb_upper"]),
            "bb_lower": float(row["bb_lower"]), "trend_score": float(row["trend_score"]),
        }
        for n in BREAKOUT_WINDOWS:
            hv, lv = row.get(f"roll_high_{n}"), row.get(f"roll_low_{n}")
            ind[f"roll_high_{n}"] = float(hv) if pd.notna(hv) else float("inf")
            ind[f"roll_low_{n}"] = float(lv) if pd.notna(lv) else float("-inf")
        bar = {"ts": ts, "spot": float(row["spot"]), "pcr": float(row["pcr"])}
        sig = cfg.fn(bar, ind)
        day = ts.strftime("%Y-%m-%d") if hasattr(ts, "strftime") else str(ts)[:10]
        bars.append((day, ce, pe, sig))
    return bars
```

- [ ] **Step 2: Add the walk-forward ranking loop for one index**

```python
async def _run_index(index_name: str, from_date: str, split_date: str, to_date: str) -> list[dict]:
    lot = LOT_SIZES[index_name]
    min_prem = MIN_ENTRY_PREMIUM.get(index_name, 1.0)

    print()
    print("=" * 104)
    print(f"  STRATEGY DISCOVERY SWEEP - {index_name}")
    print(f"  train {from_date} -> {split_date}   |   test {split_date} -> {to_date}")
    print("=" * 104)

    df = await _load_ticks(index_name, from_date, to_date, "front")
    if df.empty or len(df) < MIN_BARS:
        print(f"  insufficient tick data ({len(df)} bars)")
        return []
    df = _compute_indicators(df)
    df = _add_breakout_columns(df)

    expiry_dates: set[str] = set()
    try:
        async with aiosqlite.connect(OPTIONS_DB, timeout=5) as db:
            cur = await db.execute(
                "SELECT DISTINCT expiry FROM options_ticks WHERE index_name = ?",
                (index_name,),
            )
            expiry_dates = {r[0] for r in await cur.fetchall()}
    except Exception:
        pass

    configs = all_family_configs(expiry_dates)
    results: list[dict] = []

    for cfg in configs:
        bars = await _signal_series(cfg, df)
        train = [b for b in bars if b[0] < split_date]
        test = [b for b in bars if b[0] >= split_date]
        if not train or not test:
            continue

        best = None  # (train_stats, stop, target)
        for stop in STOP_GRID:
            for rmult in RMULT_GRID:
                target = stop * rmult
                tr = _simulate(train, lot, min_prem, stop, target)
                if tr["n"] == 0:
                    continue
                if best is None or tr["pf"] > best[0]["pf"]:
                    best = (tr, stop, target)
        if best is None:
            continue

        tr_stats, stop, target = best
        te_stats = _simulate(test, lot, min_prem, stop, target)
        results.append({
            "index": index_name, "family": cfg.family, "params": cfg.params,
            "stop": stop, "target": target,
            "train_n": tr_stats["n"], "train_pf": tr_stats["pf"], "train_net": tr_stats["net"],
            "test_n": te_stats["n"], "test_pf": te_stats["pf"], "test_net": te_stats["net"],
            "test_wr": te_stats["wr"],
        })

    return results
```

- [ ] **Step 3: Add the report table + CLI entrypoint**

```python
def _print_report(results: list[dict]) -> None:
    if not results:
        print("  no configs produced trades")
        return
    survivors = [r for r in results
                 if r["train_pf"] > 1.0 and r["test_n"] >= MIN_TEST_N and r["test_pf"] > 1.0]
    thin = [r for r in results
            if r["train_pf"] > 1.0 and 0 < r["test_n"] < MIN_TEST_N]

    print()
    print(f"  {'index':<8}{'family':<14}{'params':<30}{'stop':>6}{'tgt':>6}"
          f"{'train n':>9}{'train PF':>10}{'test n':>8}{'test PF':>9}{'test net':>10}")
    print("  " + "-" * 110)
    for r in sorted(results, key=lambda r: -r["train_pf"])[:40]:
        print(f"  {r['index']:<8}{r['family']:<14}{str(r['params']):<30}"
              f"{r['stop']:>6.0f}{r['target']:>6.0f}"
              f"{r['train_n']:>9}{r['train_pf']:>10.2f}"
              f"{r['test_n']:>8}{r['test_pf']:>9.2f}{r['test_net']:>10,.0f}")

    print()
    print(f"  SURVIVORS (train PF>1, test n>={MIN_TEST_N}, test PF>1): {len(survivors)}/{len(results)}")
    for r in survivors:
        print(f"    {r['index']} {r['family']} {r['params']} -> test PF {r['test_pf']:.2f}, "
              f"n={r['test_n']}, net Rs.{r['test_net']:,.0f}")
    if thin:
        print(f"  THIN (train PF>1 but test n<{MIN_TEST_N} -- extend, don't decide): {len(thin)}")


async def _main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--index", choices=["NIFTY", "SENSEX", "BOTH"], default="BOTH")
    ap.add_argument("--from", dest="from_date", default="2026-04-15")
    ap.add_argument("--split", dest="split_date", default="2026-07-01")
    ap.add_argument("--to", dest="to_date", default=None)
    args = ap.parse_args()
    if not args.to_date:
        args.to_date = datetime.now().date().isoformat()

    all_results: list[dict] = []
    for idx in (["NIFTY", "SENSEX"] if args.index == "BOTH" else [args.index]):
        all_results += await _run_index(idx, args.from_date, args.split_date, args.to_date)

    _print_report(all_results)


if __name__ == "__main__":
    asyncio.run(_main())
```

- [ ] **Step 4: Run the sweep end-to-end on real data**

Run:
```bash
cd d:/TradingApp/backend && source .venv/Scripts/activate && cd .. && python scripts/strategy_sweep.py --index BOTH --from 2026-04-15 --split 2026-07-01 --to 2026-08-19
```
Expected: prints a ranked table of configs per index, then a `SURVIVORS` count line. Zero survivors is a valid, honest outcome given the caveat in the file header — do not treat an empty survivor list as a bug.

- [ ] **Step 5: Commit**

```bash
git add scripts/strategy_sweep.py
git commit -m "feat: add walk-forward runner + CLI to strategy_sweep.py"
```

---

### Task 4: Hybrid composite (regime filter -> entry -> structural stop -> R-multiple target)

**Files:**
- Modify: `scripts/strategy_sweep.py`

- [ ] **Step 1: Add the structural-stop helper and hybrid signal builder (append to the file)**

```python
def _structural_stop(df: pd.DataFrame, i: int, opt: str, lookback: int = 10) -> float:
    """Nearest swing low/high in the option premium over the last `lookback`
    bars, as distance in premium points from the current bar's LTP. Falls
    back to a fixed 15pt stop if the window is too flat (mirrors
    ForexTraderVX strategy_hybrid.py's ATR*1.5 fallback)."""
    col = "atm_ce_ltp" if opt == "CE" else "atm_pe_ltp"
    lo = max(MIN_BARS, i - lookback)
    window = df[col].iloc[lo:i]
    if window.empty:
        return 15.0
    cur = float(df[col].iloc[i])
    swing = float(window.min()) if opt == "CE" else float(window.max())
    dist = abs(cur - swing)
    return dist if dist >= 5.0 else 15.0


def build_hybrid_config(best_family_result: dict, configs: list[FamilyConfig],
                        regime_th: float = 60.0) -> FamilyConfig:
    """Wraps the train-selected best entry signal with a trend_score regime
    filter (avoid chop: only fire when |trend_score - 50| >= (regime_th-50))."""
    base = next(c for c in configs
                if c.family == best_family_result["family"]
                and c.params == best_family_result["params"])

    def sig(bar: dict, ind: dict) -> tuple[str, str] | None:
        if abs(ind["trend_score"] - 50) < (regime_th - 50):
            return None   # chop -- regime filter blocks entry
        return base.fn(bar, ind)

    return FamilyConfig("hybrid", {"base": base.params, "regime_th": regime_th,
                                    "base_family": base.family}, sig)
```

- [ ] **Step 2: Wire the hybrid into `_run_index` — build it from the best train-PF survivor, test it identically**

Modify the end of `_run_index` (before `return results`):

```python
    if results:
        best_by_train = max(results, key=lambda r: r["train_pf"])
        hybrid_cfg = build_hybrid_config(best_by_train, configs)
        bars = await _signal_series(hybrid_cfg, df)
        train = [b for b in bars if b[0] < split_date]
        test = [b for b in bars if b[0] >= split_date]
        if train and test:
            best = None
            for stop in STOP_GRID:
                for rmult in RMULT_GRID:
                    target = stop * rmult
                    tr = _simulate(train, lot, min_prem, stop, target)
                    if tr["n"] == 0:
                        continue
                    if best is None or tr["pf"] > best[0]["pf"]:
                        best = (tr, stop, target)
            if best is not None:
                tr_stats, stop, target = best
                te_stats = _simulate(test, lot, min_prem, stop, target)
                results.append({
                    "index": index_name, "family": "hybrid", "params": hybrid_cfg.params,
                    "stop": stop, "target": target,
                    "train_n": tr_stats["n"], "train_pf": tr_stats["pf"], "train_net": tr_stats["net"],
                    "test_n": te_stats["n"], "test_pf": te_stats["pf"], "test_net": te_stats["net"],
                    "test_wr": te_stats["wr"],
                })
```

- [ ] **Step 3: Run the sweep again and confirm a `hybrid` row appears**

Run:
```bash
cd d:/TradingApp/backend && source .venv/Scripts/activate && cd .. && python scripts/strategy_sweep.py --index NIFTY --from 2026-04-15 --split 2026-07-01 --to 2026-08-19 | grep -i hybrid
```
Expected: at least one line with `family` = `hybrid` in the printed table (test PF may be below 1 -- that is a valid finding, not a script error).

- [ ] **Step 4: Commit**

```bash
git add scripts/strategy_sweep.py
git commit -m "feat: add regime-filtered hybrid composite to strategy_sweep.py"
```

---

### Task 5: Regime classification + per-bucket ranking

**Files:**
- Create: `scripts/regime_classify.py`

- [ ] **Step 1: Write the file header, imports, and session-level bucketing**

```python
"""
Regime classification for NIFTY/SENSEX -- buckets each trading session into
trend-up / trend-down / range (by mean trend_score) crossed with
high-vol / low-vol (by ATR percentile), then re-ranks strategy_sweep.py's
signal-family configs WITHIN each bucket.

Answers: "which strategy fits THIS market" as a conditional statement
(e.g. "trend_follow wins in trend-up/low-vol"), not a single universal
winner, and calls out which bucket the most recent sessions fall into.

CAVEAT: same 79-day data-window limitation as strategy_sweep.py -- some
buckets will have very few sessions. Buckets with <5 sessions or resulting
trade n < MIN_TEST_N are reported as "insufficient data", not a verdict.

Usage:
  python scripts/regime_classify.py --index BOTH \
      --from 2026-04-15 --split 2026-07-01 --to 2026-08-19
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import aiosqlite

from backend.services.options_backtest_engine import (
    _load_ticks, _compute_indicators, LOT_SIZES, MIN_ENTRY_PREMIUM,
    MIN_BARS, OPTIONS_DB,
)
from scripts.strategy_sweep import (
    all_family_configs, _add_breakout_columns, _signal_series, _simulate,
    STOP_GRID, RMULT_GRID, MIN_TEST_N,
)

MIN_SESSIONS_PER_BUCKET = 5


def _classify_sessions(df) -> dict[str, str]:
    """Returns {day_str: bucket_label} for every trading day in df."""
    by_day = df.groupby(df["ts"].dt.date)
    day_trend: dict[str, float] = {}
    day_atr: dict[str, float] = {}
    for day, grp in by_day:
        day_trend[day.isoformat()] = float(grp["trend_score"].mean())
        day_atr[day.isoformat()] = float(grp["atr"].mean())

    atr_values = sorted(day_atr.values())
    median_atr = atr_values[len(atr_values) // 2] if atr_values else 0.0

    buckets: dict[str, str] = {}
    for day, ts_mean in day_trend.items():
        if ts_mean >= 60:
            direction = "trend-up"
        elif ts_mean <= 40:
            direction = "trend-down"
        else:
            direction = "range"
        vol = "high-vol" if day_atr[day] >= median_atr else "low-vol"
        buckets[day] = f"{direction}/{vol}"
    return buckets
```

- [ ] **Step 2: Verify bucketing on real data**

Run:
```bash
cd d:/TradingApp/backend && source .venv/Scripts/activate && cd .. && python -c "
import asyncio, sys; sys.path.insert(0, '.')
from backend.services.options_backtest_engine import _load_ticks, _compute_indicators
from scripts.regime_classify import _classify_sessions
async def main():
    df = await _load_ticks('NIFTY', '2026-04-15', '2026-08-19', 'front')
    df = _compute_indicators(df)
    buckets = _classify_sessions(df)
    from collections import Counter
    print(Counter(buckets.values()))
    print('total sessions:', len(buckets))
asyncio.run(main())
"
```
Expected: a `Counter` with up to 6 bucket labels and their session counts, summing to the total number of trading days in the range.

- [ ] **Step 3: Commit**

```bash
git add scripts/regime_classify.py
git commit -m "feat: add session-level regime bucketing to regime_classify.py"
```

---

### Task 6: Per-bucket ranking + current-regime call-out

**Files:**
- Modify: `scripts/regime_classify.py`

- [ ] **Step 1: Add the per-bucket ranking runner (append after `_classify_sessions`)**

```python
async def _run_index(index_name: str, from_date: str, to_date: str) -> None:
    lot = LOT_SIZES[index_name]
    min_prem = MIN_ENTRY_PREMIUM.get(index_name, 1.0)

    print()
    print("=" * 104)
    print(f"  REGIME-SLICED RANKING - {index_name}  ({from_date} -> {to_date})")
    print("=" * 104)

    df = await _load_ticks(index_name, from_date, to_date, "front")
    if df.empty or len(df) < MIN_BARS:
        print(f"  insufficient tick data ({len(df)} bars)")
        return
    df = _compute_indicators(df)
    df = _add_breakout_columns(df)
    buckets = _classify_sessions(df)

    bucket_counts: dict[str, int] = {}
    for b in buckets.values():
        bucket_counts[b] = bucket_counts.get(b, 0) + 1

    expiry_dates: set[str] = set()
    try:
        async with aiosqlite.connect(OPTIONS_DB, timeout=5) as db:
            cur = await db.execute(
                "SELECT DISTINCT expiry FROM options_ticks WHERE index_name = ?",
                (index_name,),
            )
            expiry_dates = {r[0] for r in await cur.fetchall()}
    except Exception:
        pass

    configs = all_family_configs(expiry_dates)
    per_bucket: dict[str, list[dict]] = {}

    for cfg in configs:
        bars = await _signal_series(cfg, df)
        # Group bars by bucket using the day-string already in each bar tuple.
        by_bucket: dict[str, list] = {}
        for b in bars:
            day = b[0]
            bucket = buckets.get(day)
            if bucket:
                by_bucket.setdefault(bucket, []).append(b)

        for bucket, bucket_bars in by_bucket.items():
            if bucket_counts.get(bucket, 0) < MIN_SESSIONS_PER_BUCKET:
                continue
            best = None
            for stop in STOP_GRID:
                for rmult in RMULT_GRID:
                    target = stop * rmult
                    st = _simulate(bucket_bars, lot, min_prem, stop, target)
                    if st["n"] == 0:
                        continue
                    if best is None or st["pf"] > best["pf"]:
                        best = {**st, "stop": stop, "target": target,
                                "family": cfg.family, "params": cfg.params}
            if best:
                per_bucket.setdefault(bucket, []).append(best)

    print()
    for bucket in sorted(per_bucket):
        sessions = bucket_counts.get(bucket, 0)
        print(f"  -- {bucket}  ({sessions} sessions) --")
        ranked = sorted(per_bucket[bucket], key=lambda r: -r["pf"])[:5]
        for r in ranked:
            flag = "" if r["n"] >= MIN_TEST_N else "  (n<{}: insufficient data)".format(MIN_TEST_N)
            print(f"    {r['family']:<14}{str(r['params']):<30} n={r['n']:>4} "
                  f"PF={r['pf']:>6.2f}  net=Rs.{r['net']:>8,.0f}{flag}")

    # Current-regime call-out: last 5 trading days in the window.
    recent_days = sorted(buckets.keys())[-5:]
    recent_buckets = [buckets[d] for d in recent_days]
    if recent_buckets:
        dominant = max(set(recent_buckets), key=recent_buckets.count)
        print()
        print(f"  CURRENT REGIME (last {len(recent_days)} sessions): {dominant}")
        if dominant in per_bucket and per_bucket[dominant]:
            top = max(per_bucket[dominant], key=lambda r: r["pf"])
            print(f"    best-fit config in this regime: {top['family']} {top['params']} "
                  f"(PF={top['pf']:.2f}, n={top['n']})")
        else:
            print("    no config met the minimum-sessions bar for this bucket yet")
```

- [ ] **Step 2: Add the CLI entrypoint**

```python
async def _main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--index", choices=["NIFTY", "SENSEX", "BOTH"], default="BOTH")
    ap.add_argument("--from", dest="from_date", default="2026-04-15")
    ap.add_argument("--to", dest="to_date", default=None)
    args = ap.parse_args()
    if not args.to_date:
        args.to_date = datetime.now().date().isoformat()

    for idx in (["NIFTY", "SENSEX"] if args.index == "BOTH" else [args.index]):
        await _run_index(idx, args.from_date, args.to_date)


if __name__ == "__main__":
    asyncio.run(_main())
```

- [ ] **Step 3: Run end-to-end on real data**

Run:
```bash
cd d:/TradingApp/backend && source .venv/Scripts/activate && cd .. && python scripts/regime_classify.py --index BOTH --from 2026-04-15 --to 2026-08-19
```
Expected: for each index, a per-bucket ranked table (only for buckets with >=5 sessions) followed by a `CURRENT REGIME` line naming the dominant bucket of the last 5 sessions and its best-fit config (or "no config met the minimum-sessions bar yet", which is a valid outcome).

- [ ] **Step 4: Commit**

```bash
git add scripts/regime_classify.py
git commit -m "feat: add per-bucket ranking + current-regime call-out to regime_classify.py"
```

---

### Task 7: Findings write-up

**Files:**
- None created (this task produces a message to the user, not a file — per the spec's deliverable #7, the writeup is presented, not necessarily saved).

- [ ] **Step 1: Run both scripts on the full available window and capture output**

```bash
cd d:/TradingApp/backend && source .venv/Scripts/activate && cd .. && python scripts/strategy_sweep.py --index BOTH --from 2026-04-15 --split 2026-07-01 --to 2026-08-19 > /tmp/sweep_output.txt 2>&1
python scripts/regime_classify.py --index BOTH --from 2026-04-15 --to 2026-08-19 > /tmp/regime_output.txt 2>&1
```

- [ ] **Step 2: Summarize findings in a table for the user**

Build a table covering, per the project's stated table preference:
- Any `SURVIVORS` from `strategy_sweep.py` (train PF>1, test n>=20, test PF>1) — family, params, stop/target, test PF, test n, test net.
- Any `THIN` results (promising on train but test n<20) — flag as "extend, don't decide" per block-freeze rule 2.
- The `CURRENT REGIME` call-out from `regime_classify.py` for both NIFTY and SENSEX, and whichever config is best-fit for that regime (if any bucket met the minimum-sessions bar).
- Explicitly restate the 79-day data caveat next to any positive-looking result — no result from this sweep should be presented without it.

- [ ] **Step 3: Commit the two finished scripts together if not already committed from earlier tasks**

```bash
cd d:/TradingApp && git status --short scripts/strategy_sweep.py scripts/regime_classify.py
```
Expected: clean (nothing to commit) if Tasks 1-6 were committed incrementally as specified.

---

## Self-Review Notes

- **Spec coverage:** Task 1-3 cover spec §1 (families+grid) and §4 (walk-forward, min-n). Task 4 covers spec §2 (hybrid composite). Task 2 covers spec §3 (cost model, reused unchanged). Tasks 5-6 cover spec §5 (regime slicing). Task 3 Step 3 covers spec §6 (profit factor + supporting stats). Task 7 covers spec §7 (deliverable: reusable scripts + findings writeup). No spec section is uncovered.
- **Placeholder scan:** all code blocks are complete, runnable Python — no TBD/TODO markers, no "add error handling" hand-waves.
- **Type/name consistency checked:** `FamilyConfig` (Task 1) is used identically in Tasks 3, 4, 6. `_simulate` signature `(bars, lot, min_prem, stop_pts, target_pts)` (Task 2) is called identically in Tasks 3, 4, 6. `MIN_TEST_N`, `STOP_GRID`, `RMULT_GRID`, `_add_breakout_columns`, `_signal_series`, `all_family_configs` are all imported into `regime_classify.py` (Task 5 Step 1) exactly as named when defined in `strategy_sweep.py` (Tasks 1-3).
