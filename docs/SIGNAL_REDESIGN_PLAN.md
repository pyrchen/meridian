# Meridian Signal Engine — Redesign Implementation Plan

**Author:** Opus (analysis) · **Executor:** Sonnet coding agent
**Targets:** `scripts/gen-signals.mjs`, `scripts/indicators.mjs`, `src/signals/main.ts`, new `scripts/backtest.mjs` (+ optional `scripts/engineCore.mjs`)
**Evidence base:** `public/data/signals.json` — 405 closed trades (371 decided), span **2026-06-20 … 2026-07-10**, **one BTC-down regime**.

---

## Prime directive — read before touching code

1. **The goal is to ARREST THE BLEED and REMOVE DEGREES OF FREEDOM, not to "reach proven positive expectancy."** Positive expectancy is **unproven** and stays unproven until a multi-regime offline replay says otherwise. Anyone who claims a change "makes the engine profitable" from this data is wrong — the sample is one 3-week BTC-down regime with heavy autocorrelation.
2. **Effective sample size is ~15–25, not 371.** 34 signals were created in a single cron hour; 52% fall inside one 5-day window. Trades are one correlated bet ("BTC dumps → alts dump"), not independent observations. Discount every z-score by ~4× for clustering: only **rr (z≈−4.83 → ~−3.4 cluster-robust)** and **ADX (z≈+2.18, in-band 2.35)** plausibly survive. Treat everything else as a *hypothesis*.
3. **Optimize `avgNetR` (net of `FEE_RT`+`SLIP_RT`), never win rate.** Breakeven gross-WR at rr 2.5 is 28.6%; chasing high WR at positive RR is mathematically impossible. Expect forward WR ~45–55% at best; the edge, if any, is avgR.
4. **Validate, then tune.** Phase 0 (offline harness) is a *precondition*, not a final deliverable. No numeric threshold from Phases 2–4 ships until its **sign** holds out-of-sample in ≥2 independent regime cells.
5. **Never quote gross-of-cost anywhere.**

---

## 0. Headline finding — the June redesign is a measurable REGRESSION

The dataset contains **two engines**. Splitting by presence of the `rr` field (added in commit `dd13898`, 2026-06-26):

| Engine | n | Win-rate | avgNetR | sum netR |
|---|---:|---:|---:|---:|
| **OLD** (pre-dd13898, no dynamicRR/SMC) | 216 | 27.8% | **−0.193** | −40.6 |
| **NEW** (dynamicRR ladder + SMC + tightened momentum gates) | 155 | 14.2% | **−0.555** | **−86.0** |

**The "improvement" shipped on 2026-06-26 roughly tripled the per-trade loss rate.** 86 of the 126.6 lost R come from just 155 new-engine trades. This reframes the whole plan: **Phase 1 (kill `dynamicRR`, strip overlays) is not a speculative bet — it is reverting a demonstrated regression**, and is therefore the highest-confidence, ship-first work. Everything else is layered on top and gated behind the harness.

> **Consequence for the pooled statistics.** Any metric computed across all 371 trades (score calibration, most feature z-scores, the "SMC is harmful" and "score is inverted" claims) mixes the two engines and is confounded. The corrections below account for this.

---

## 1. Diagnosis — root causes

**R1 — The composite score is degrees-of-freedom bloat, and its apparent "inversion" is an artifact.**
~45 of ~104 base points come from families that do **not** discriminate winners: momentum (RSI point-biserial z=−0.01 — winMean 43.998 vs lossMean 44.009; MACD-hist z=+0.03), volume (z=−1.15, winners had *lower* volume), SMC (present→14.7% WR vs absent→26.0%), news (z=+0.10). The headline "score is flat-to-inverted" (80-85→15.3%, 85-90→8.3%) is manufactured by (a) the score→rr ladder (R3) and (b) the mixed-engine confound (R0). **Correction to earlier analysis:** within the clean new engine at capped rr (≤2.5), calibration is **flat (~20%)**, not monotone-positive — score discrimination is *undetermined* on this sample, not proven either way. **Action = strip the non-discriminating families to shrink the overfit surface and decouple score from rr. Do NOT claim "the score is noise so profit is impossible," and do NOT claim SMC is harmful — that is a confound, not a finding.**

**R2 — Direction is chosen mechanically, flooding the tape-aligned side with low-quality trades.**
`analyzeHorizon` (line 369) sets `side = trend==='up' ? 'long' : 'short'` off the higher-TF EMA stack. In this BTC-down window that flipped **300 of 371** trades into high-beta alt-shorts (WR 20.7%, avgNetR −0.34 — the bulk of −126.6R). The disease is the **mechanism**, not the word "short": in a BTC-up regime the identical flip floods *longs*. On the correct metric **long avgNetR = short avgNetR = −0.35 (identical)**; "counter-BTC longs won" (WR 28.2% vs 20.7%) is a win-rate illusion resting on ~20 wins across ~13 small-cap alts. **The corrective must be side-symmetric flood suppression, never a hard-coded long bias.**

**R3 — The `dynamicRR`-by-score ladder is the single fatal defect.**
`dynamicRR` (lines 254-262) sets rr=3/4/6 at score≥80/85/90. `rr` is the strongest loss driver (z=−4.83, cluster-robust ~−3.4): rr2.5→WR21%/avgNetR−0.32, rr3→WR5.7%/−0.85, rr4→WR0%/−1.03. A fixed-ATR 3–6R target is geometrically unreachable inside a 1h–1d / `MAX_AGE_DAYS` window, so the ladder hands the *highest-conviction* entries near-guaranteed losers and simultaneously manufactures R1's "inverted calibration." Because score feeds rr and overlays feed score, **capping rr also neutralizes the residual harm of every overlay** — the rr-cap does almost all the work.

**R4 — Overfit risk is the dominant risk, and there is no offline validation.**
Everything derives from one autocorrelated regime; naive binomial SE (~5%) understates the true CI by 2–4×. The celebrated post-hoc cuts are breakeven-within-noise, not edges: `ADX≥28 & rr≤2.5` → n=46, avgNetR **+0.018** (sum +0.8R, i.e. essentially zero, sign not robust); `LONG & ADX≥28 & rr≤2.5` → n=34, sum +3.3R but ~6–8 independent bets; the best cut `ADX≥28 & rr≤2.5 & volPct≤0.7` → avgNetR +0.24 on n≈23 ≈ 5–8 independent events, statistically indistinguishable from zero. **No threshold may be committed before the Phase-0 harness exists.**

**R5 — Overlays are confounded and corrupt the score→rr chain.**
The BTC additive block (lines 464-473: −12 long-in-down / −10 short-in-up / +4 tailwind) is mis-signed in-sample (z=−2.29): the +4 short-tailwind lifted losing shorts into higher rr tiers. News (±14/+6, lines 474-488) is noise (z=+0.10) **and unreplayable** (news.json is a rolling 72h window with no point-in-time archive). Once rr is capped (R3), their residual harm →0 — **removing them is DoF-reduction cleanup, not the core lever. Do not oversell it as an expectancy fix.**

---

## 2. Guiding principle

**Fewer, rarer, higher-expectancy signals — proven before tuned.**

- Optimize `avgNetR`; never win rate.
- The harness (Phase 0) is a **precondition**. No threshold ships until its sign holds OOS across ≥2 regimes.
- Keep only proven edge; delete the rest for parsimony. At effective n ~15–25 every retained parameter must earn its keep.
- Ship regime-independent structural fixes first (mechanical justification); gate every regime-contingent threshold behind the harness or behind a flag that defaults OFF.
- The harness is a **falsifier, not a validator**: under survivors-only universe data a breakeven OOS result means "not-disproven-losing," never "proven-profitable."

---

## 3. Phased implementation plan (ordered — do not reorder)

**Corroboration legend:** **[C]** corroborated (survives clustering / mechanical) · **[D]** directional (sign plausible, magnitude unproven) · **[V]** must-validate-offline (ship behind harness or OFF-by-default flag only).
Changes tagged **[V]** must not reach `gen-signals.mjs` live behaviour until Phase 0 exists and the change's sign holds in ≥2 regime cells.

### PHASE 0 — Offline validation harness + lookahead audit (BLOCKING; writes zero new thresholds into the live engine)

**P0-0 · Data-availability spike — do this first.** **[V]**
Page `1h/4h/1d` klines back 2–3y for ~10 symbols from the CI IP via `GET /api/v3/klines?...&startTime=…&limit=1000` against `data-api.binance.vision`. Confirm no 451/429 wall; measure real depth per interval. `KLINE_LIMITS` live caps are only 1h≈14d / 4h≈55d (line 68). **If 1h paging is too shallow, declare `scalp` (198 of 371 trades) OUT-OF-SCOPE up front** rather than after building. No prod change.

**P0-1 · Extract shared entry+outcome core; the backtest imports the real engine.** **[C]**
In `scripts/gen-signals.mjs`, add `export` to `analyzeHorizon`, `evaluateSignal`, `closeSig`, `tradeCostPct`, `buildRsRanks`, `calibrateFromClosed`, `aggStats`, `computeStats`, and constants (`FEE_RT`, `SLIP_RT`, `HORIZONS`, `STRATUM_MIN`, `RR`, `ATR_MULT`, `MAX_AGE_DAYS`, `KLINE_LIMITS`, `MIN_TARGET_PCT`, `QV_MIN`, `SCORE_MIN`, `RR_MIN`). Split `btcRegime(now)` (lines 145-158) into pure `btcRegimeFrom(closedDailyBtc)` + a thin fetch wrapper. `main()` stays the only site with fetch / file-IO / `process.exit`. **Zero logic change.**
**Rollback guard — golden-run byte-diff:** run current `gen-signals` on frozen input, assert `signals.json` is byte-identical before/after the export split. Revert = drop the `export` keywords.

**P0-2 · Deep-page + cache klines history.** **[C]**
New `scripts/backtest.mjs --pull` → `data/history/{SYMBOL}-{INTERVAL}.ndjson`, incremental merge/dedup by open-time, `mapLimit(...,8)`, backoff on 429/451, resumable. Snapshot the symbol list once and stamp it. Additive; delete dir to revert.

**P0-3 · No-lookahead replay contract + audit.** **[C]**
`scripts/backtest.mjs --replay`. Outer loop over signal-TF bar index `i` per horizon; `replayNow = candle[i].ct`. Feature arrays = `full.filter(c => c.ct <= replayNow)` for **both** sig and trend TFs; call exported `analyzeHorizon(full, H, …, now=replayNow, newsHit=null)`. Entry = close of bar `i`; outcome via `evaluateSignal` with `createdAt=ISO(replayNow)` (its `k.t > created` filter starts at bar `i+1`). Preserve the same-bar double-touch→SL rule (SL checked before TP, lines 570-576). Warmup: skip until sig bars ≥ max(200, slow+sig).
**Hard asserts (the lookahead audit):** (a) no candle with `ct > replayNow` enters any indicator; (b) first evaluated outcome bar has open `t > replayNow`; (c) RS-rank denominator = the live `rows.length` gate at T. *(Independent audit of the current live code found the closed-candle discipline sound — `closed()`/`evaluateSignal` are causal — so leakage would be a harness bug, not an engine bug; these asserts encode the invariant.)*

**P0-4 · Recompute cross-sectional / cross-trade state AS-OF each timestamp.** **[C]**
Restructure time-outer / coin-inner: at each T compute `btcRegimeFrom(btcDaily truncated at T)` and `buildRsRanks(fetched, T)` once; maintain a growing `closedSoFar` and call `calibrateFromClosed(closedSoFar.filter(closedAt <= T))` — **never** over the full backtest output. Label each trade with the in-force BTC regime (up/down/flat) at entry.
**Stationarity note:** `calibrateFromClosed` needs decided≥30/stratum before it bumps `minScore` (line 329), so early folds run without the adaptive filter and late folds with it (different engines per fold). **Warm-start the calibration from a fixed pre-period (or freeze it per run)** and report the calibration state in force for each fold.

**P0-5 · Faithful trade cadence via the production `openKey` dedup.** **[C]**
Keep an `openKey` Set = `symbol+side+horizon` (mirrors main() lines 789-806): skip a new entry while one is open; free on close. One trade per open→close cycle, full feature snapshot (`scoreBreakdown`, indicators, rr, targetPct, rsRank, btcRegime, maeR, toTpPct, netR). Re-emitting a persistent signal every bar would manufacture thousands of autocorrelated duplicates.

**P0-6 · Evaluation: net-of-cost, cluster-robust, purged/embargoed, dual-fill.** **[V]** (method sound; verdicts only as trustworthy as data depth allows)
`scripts/backtest.mjs --eval`, reuse `aggStats`, key metrics by `horizon × side × btcRegime`:
- **Net-of-cost only** — subtract `tradeCostPct` per trade.
- **Purged + embargoed expanding walk-forward**; embargo = `MAX_AGE_DAYS[horizon]`; never split one timestamp across folds.
- **Block / stationary-bootstrap 90% CI on avgNetR**, resampling by timestamp-blocks (block ≈ max holding in bars); report at two block sizes.
- **Min-n gate** = `STRATUM_MIN` (50) decided; a cell "passes" only if OOS lower-CI > 0.
- **Dual fill (mandatory):** report every avgNetR under **both** entry-at-close and `--fill=next-open`; any edge that survives only under close-fill is an execution artifact. *(The live engine enters at the signal candle's close but evaluates from the next candle — a mild optimistic bias next-open fill exposes.)*
- **Pre-registered hypotheses only** (no free grid): ADX∈{22,25,28,30,35}, rr-cap∈{2.0,2.5}, volPct-cap∈{0.65,0.70,0.85}, RS-floor∈{0.20,0.25,0.33}, side-symmetric flood suppression.
- **Honest-n note:** compute post-purge/embargo n for long/veryLong first; embargo 45d/400d on ~55d(4h)/~320d(1d) history purges nearly everything → mark those strata **NOT-BACKTESTABLE** rather than publish a fragile CI.

**P0-7 · Fix `aggregate()` end-alignment repaint.** **[C]**
`scripts/indicators.mjs` `aggregate()` (lines 191-208) buckets by END of series and drops the leading remainder (`rem = candles.length % factor`), so the last "month" candle recomposes as `length % factor` changes run-to-run — the veryLong trend repaints. Change length-parity grouping → **calendar-anchored** groups (e.g. `floor((weekIndex − epochWeek)/factor)`), or replay veryLong on fixed 4-week windows. Verify `trendDir(veryLong)` is stable when one trailing week is appended. Low blast radius (tiny veryLong n).

---

### PHASE 1 — Feature/score rebuild (regime-independent; justification is mechanical / reverts the R0 regression)

**P1-1 · Kill the `dynamicRR`-by-score ladder; cap rr. — THE #1 LEVER.** **[C]**
`dynamicRR` (lines 254-262) and its call (line 494). Introduce `const RR_CAP = 2.5`.
Before→after: score≥80/85/90 → rr 3/4/6 ⟶ `return Math.min(H.rr ?? RR, RR_CAP)` for all horizons; remove the score→rr branches. Drop the `tp3` score≥85 widening (line 512 → `null` or delete). Bring veryLong's `rr: 3` (HORIZONS line 64) down to ≤2.5 (rr3 is the losing tier), pending harness.
Why: rr z=−4.83 (cluster-robust −3.4); rr3→WR5.7%, rr4→WR0%. This dissolves the "inverted calibration," "SMC harmful," and "BTC-overlay mis-signed" artifacts as side effects.
**Rollback:** existing open trades keep their stored `sig.tp` (`evaluateSignal` reads it) → no retroactive break. Revert = restore `dynamicRR` body. **Verify this change in isolation first** (ablation) so its effect isn't re-credited to P1-2 / P2.

**P1-2 · Remove momentum, volume, SMC, news from the SCORE (keep as gates / display only).** **[C]** for momentum/volume/news · **[D]** (parsimony only) for SMC
In `analyzeHorizon`:
- `fMom` family (lines 416-425) → delete from the `score` sum (line 462). **Keep** the MACD-hist sign + RSI-band + EMA50 conditions as binary entry gates (lines 384-388) unchanged.
- `fVol` (lines 438-441) → delete from score. **Keep** the 0.7× volume floor (line 398) and `QV_MIN` (line 138) as liquidity gates.
- `fSmc` + `findOrderBlock`/`findFVG`/`liquiditySweep` (lines 453-460) → remove from score; may retain as display-only `reasons`.
- News additive `newsDelta` (lines 474-488) → remove from score; **at most** keep "against" → hard veto (`return null`), "for" → nothing. Keep `news`/`newsSentiment`/`newsCount` display fields.
- Update `scoreBreakdown` (lines 496-500) to drop `momentum`/`volume`/`smc`/`news` keys — **see P1-7 for the frontend lockstep.**
Before→after: `score = fTrend + fMom + fReg + fVol + fRs + fSmc` ⟶ `score = fTrend + fReg + fRs`.
**Framing discipline:** momentum is ~noise as a scored input (RSI z=−0.01 is post-gate range-restriction; MACD z=+0.03); volume z=−1.15; news z=+0.10 and unreplayable. **SMC's "harm" is a mixed-engine confound (within new-engine at rr2.5, SMC-on 22.2% > SMC-off 16.7%) — remove for parsimony, do NOT call it harmful, do NOT sell any of this as an expectancy fix.**

**P1-3 · Kill dead calibration telemetry.** **[C]**
`calibrateFromClosed` (lines 334-337): delete `winAvgRsi`/`lossAvgRsi`/`winAvgStrength`/`lossAvgStrength`. The adaptive bump (line 378) keys on `cal.wr`, **not** these fields — they are unused.

**P1-6 · Rescale `SCORE_MIN` for the compressed score — CRITICAL COUPLING, ship WITH P1-2.** **[C]** (that a rescale is mandatory) / **[V]** (exact value)
Removing ~45 cap-points (P1-2) drops max base score from ~104 (+overlays) to ~59 (fTrend 33 + fReg 14 + fRs 12). With `SCORE_MIN=70` **unchanged, `analyzeHorizon` returns null for every coin AND line 768 (`if ((sig.strength||0) < SCORE_MIN) continue`) discards the entire existing open book on the first run — a silent total wipe.**
Change `SCORE_MIN` (line 35) → a harness-selected value on the compressed scale (sweep against avgNetR; expect ~40–50). **Ship P1-2 and P1-6 together, never P1-2 alone.** Mitigate with the signal-count floor-check (Guardrail 5).

**P1-7 · Frontend lockstep — update `src/signals/main.ts` display contract.** **[C]** (integration, mandatory)
The redesign changes the output schema; the UI must not break:
- `scoreBreakdown` renderer (main.ts lines 729-738) hard-references keys `trend, momentum, regime, volume, rs, smc, btc, news`. After P1-2/P2-4 the emitted keys are `trend, regime, rs` (+ whatever P4-2 keeps). Update the `rows` table to render only the surviving families; drop the deleted rows and their captions.
- Indicators grid (lines 762-772) still reads `ind.rsi/adx/plusDI/minusDI/macdHist/volPct` and `s.rsRank` — these fields remain emitted (they stay as gates/telemetry), so no change needed there, but confirm.
- `s.rr`, `s.targetPct`, `s.riskPct`, `s.strength`, `s.netR`, `s.netPnlPct`, `s.toTpPct`, `s.maeR`, `stats.byStratum` are all still consumed (lines 245-272, 527-655) — preserve them in the output.
Add a golden-diff / smoke check that `signals.html` renders a sample card without a thrown key error after the schema change.

---

### PHASE 2 — Directional / regime gate (threshold-level → SHIP BEHIND HARNESS ONLY, except P2-1)

**P2-1 · Kill `long:short` (and confirm `veryLong:short` stays killed).** **[C/D]**
`analyzeHorizon` line 370 already blocks veryLong shorts; add `if (H.key === 'long' && side === 'short') return null`. long:short = **0/14 WR, avgNetR −1.01**; long-horizon shorting on a spot-storage horizon is a falling-knife. One-line guard; trivial revert.

**P2-2 · Raise the ADX entry gate — magnitude harness-selected.** **[V]** (magnitude) / **[C]** (direction)
Entry gates lines 385 & 387 (`adxv < 18`). Introduce `const ADX_GATE = <harness>`; `adxv < 18` ⟶ `adxv < ADX_GATE`. Sweep {22, 25, 28, 30, 35}; **default hypothesis 25** — do **not** hard-code the 28 cliff or the n8 35-cell (66.7% ≈ 2 independent events). ADX is the only feature besides rr surviving the clustering discount (z=+2.18, in-band 2.35). Buckets: 18-22→21.6%, 22-28→10.9% (worst), 28-35→27.2%, 35+→32.1%. **Caveat:** the 22-28 trough is non-monotone — a single-regime-noise flag; in chop/BTC-up high ADX can mark exhaustion and invert. Prefer a soft gate (~25) plus ADX as a scored monotone tier so the exact cliff is not load-bearing. **Risk: signal starvation — enforce Guardrail 5.**

**P2-3 · Directional relative-strength floor (non-scalp only).** **[V]**
`fRs` block (lines 443-451). When `rsRank != null && H.key !== 'scalp'`, reject if `rel < RS_FLOOR` where `rel = side==='long' ? rsRank : 1 - rsRank`; keep the existing monotone upweight above the floor. `RS_FLOOR` swept {0.20, 0.25, 0.33}. rsRank(dir) is monotone and pooled-predictive (z=+2.21; bottom-third 6.7% → mid 12.2% → top-third 21%) — **but** top-third 21% is still below the 28.6% breakeven, the pooled z likely does not survive clustering, and **scalp has no rsRank at all** (61% of the flood). **Do NOT invent a scalp `rsDays` and hard-gate the 235 scalp trades on an untested 1h-RS signal.** Non-scalp only; keep RS as an upweight/soft-gate; promote to hard gate only if it beats the no-RS book OOS in ≥2 regimes.

**P2-4 · Replace the BTC additive overlay with side-symmetric flood suppression (NOT long-bias).** **[V]**
Delete the additive `btcDelta` block (lines 464-473) and drop `btc` from the additive `scoreBreakdown` path (line 498). Keep `btc.dir/change7d` as a **gate / rr-cap input and regime label**, never as points.
Replace with the real lever — suppress the mechanically flooded side. A/B on the harness: (a) cap signals per regime-aligned side per run; (b) require entry-TF trend persistence of N bars before the flip qualifies; (c) on the tape-aligned side, hold rr at `RR_CAP` and demand the strict bar (ADX gate + RS floor). **Keyed on the BTC-overlay sign so it is symmetric** — in BTC-up it suppresses long-flooding exactly as it suppresses short-flooding in BTC-down. **Do NOT hard-code a long bias** — long avgNetR = short avgNetR = −0.35; the "longs won" story is a WR illusion that inverts in BTC-up. Once rr is capped (P1-1), deleting the overlay is safe (residual harm →0); the suppression rule reverts to a no-op flag.
*(Optional extension, [V]: model BTC regime as up/down/chop using BTC daily DMI — `|change7d|≥~5% AND btc.adx≥~20` for "strong trend" — and in chop demand the strict bar on BOTH sides. Ship structure, keep cutoffs conservative; zero BTC-up/chop data in-sample.)*

**P2-5 · Volatility high-tail penalty/gate.** **[V]**
`fReg` vol block (lines 432-435) only penalizes *low* vol. Keep that; **stop rewarding** high vol and add a harness-selected high-tail treatment: a scored penalty or a gate `if (volPct != null && volPct > VOL_CAP) return null`. `VOL_CAP` swept {0.65, 0.70, 0.85}. Entering top-percentile realized vol loses (0.5-0.7→33.3% best vs 0.7-1.0→17.5% worst; z=−1.32) — **but** z is sub-|2| and evaporates under clustering, and in a selloff high vol *is* the trend acceleration where shorts work. Prefer the soft "remove reward + mild penalty," require sign-hold in ≥2 regimes before a hard gate.

---

### PHASE 3 — Exit rebuild

**P3-1 · Keep the 1.8×ATR stop — do NOT tighten.** **[C]**
`ATR_MULT = 1.8` (line 37) — **no change.** Explicitly reject "tighten / structure stop below swing." Losers' median MAE is 1.15R — a tighter stop cannot save them, it only converts clean winners (median MAE 0.35R; 66% never draw past 0.5R) to losses. Leverage is on target + gate, not stop width.

**P3-2 · Reject default/automatic partial-TP@1R.** **[C]**
No auto-partial. Leave `tp2` (line 511) display-only. Partial-TP@1R helps only the unfiltered garbage book but **hurts** the filtered book by capping the runners that pay the R (also a prior-verified myth). Breakeven-stop without the partial dominates in every filtered cut.

**P3-3 · Breakeven stop at +1R — BEHIND A FLAG, DEFAULT OFF.** **[V]**
`evaluateSignal` (lines 561-585) behind `const BE_STOP = false`. When armed: once high/low reaches `entry ± 1.0*slDist`, raise effective SL to `entry` for subsequent candles; preserve double-touch→SL; emit a `beArmed` flag. Winners barely retrace, so a BE stop after +1R rarely kills a real winner while rescuing the ~16–18% of losers that tag 1R then reverse. **BUT** the +0.05–0.18R swing is **unfalsifiable from stored data** (`best`/`worst` are separate window-maxima; the resim ignores the 1R→pullback-through-entry path). **Requires 1m/5m intrabar replay** before its effect counts; the trigger (1.0R vs 1.25R) is settled there. Flag OFF = zero prod impact until proven.

**P3-4 · Time-bank stale long-horizon trades sitting in profit.** **[V]**
`evaluateSignal` (near lines 579-583) for scalp/mid (and long): if `age > 0.5×maxAge` AND favorable excursion ≥1R, trail with a fixed give-back (e.g. 0.5R from MFE) or exit at market instead of waiting for hard expiry. 34 expired trades reached median 63% toward TP / ~1.57R MFE but booked ~+0.65R — money left. **BUT** only final MFE is stored, not the intrabar path — size the give-back on offline candle-high/low replay before shipping. Flagged; revert to hard-expiry.

---

### PHASE 4 — Calibration

**P4-1 · Beta-binomial (empirical-Bayes) shrinkage for score→P(win), not isotonic/logistic.** **[V]**
Offline module (`scripts/backtest.mjs --calibrate` or extend `calibrateFromClosed`). Bucket by redesigned score (or ADX tier); posterior WR = `(wins+α)/(n+α+β)` with α,β from the global ~22% prior; enforce monotonicity with PAVA **only** where a violation exceeds its credible band. Report P(win) with intervals, never point WR on ~70-trade buckets (SE≈5%). Isotonic memorizes noisy steps; logistic on 5+ features chases noise. Beta-binomial is the conservative choice at effective n ~15–25.

**P4-2 · Rebuild the score as a minimal monotone scorecard (2–3 families), not additive-of-everything.** **[C]** (meta-principle) / **[V]** (weights)
After P1-2 the score is `fTrend + fReg + fRs`. Keep it **coarse and rounded**: ADX tier + DI agreement, directional rsRank (non-scalp) monotone, higher-TF-trend qualifier floor. **Do NOT fit a logistic/continuous model** and do NOT invent a fresh 45/30/15/10 weight table swept on the single regime (that re-introduces the DoF this redesign removes). Defer richer weighting until multi-regime data exists.

**P4-3 · Make the adaptive `minScore` bump avgNetR-aware and re-baseline; disable until validated.** **[D]** (direction) / **[C]** (re-baseline mandatory)
`calibrateFromClosed` (lines 319-341) + bump (line 378). Key the bump on realized stratum **avgNetR** (or netWR) against the **new** score buckets, not raw `cal.wr` on the old scale; keep `STRATUM_MIN`. **Disable the bump until the redesigned score is validated** — with the compressed scale, the old +5/+8 bump is meaningless.

---

## 4. What to KILL / what to KEEP

**KILL (remove entirely):**
- `dynamicRR`-by-score ladder (lines 254-262) — **rr z=−4.83; rr3→WR5.7%, rr4→WR0%.** The fatal defect. **[C]**
- Any `strength`/score → rr coupling, incl. `tp3` score≥85 widening (line 512). **[C]**
- Momentum family from the SCORE (`fMom` 416-425) — z≈0. Keep as **gates**. **[C]**
- Volume bonus from the SCORE (`fVol` 438-441) — z=−1.15. Keep 0.7× floor + `QV_MIN` as **liquidity gates**. **[C]**
- SMC from the SCORE (`fSmc` 453-460) — **parsimony only** (the 14.7%-vs-26.0% "harm" is a mixed-engine confound). Keep as display. **[D]**
- News additive overlay (±14/+6, 474-488) — z=+0.10 noise and unreplayable; at most a hard veto. **[C]**
- BTC additive overlay (±12/−10/+4, 464-473) — mis-signed in-sample; replace with side-symmetric suppression (P2-4). **[D]**
- `long:short` (and `veryLong:short`, already blocked) — 0/14 WR, avgNetR −1.01. **[C/D]**
- ADX entry gate at 18 (385/387) — admits the 22-28 dead zone (WR 10.9%). **[C, direction]**
- Dead calibration telemetry `winAvgRsi/winAvgStrength` (334-337). **[C]**
- Default/auto partial-TP@1R (never build). **[C]**

**KEEP / UPWEIGHT:**
- **ADX/DI regime family** — top surviving discriminator (z=+3.08 / +2.18, in-band 2.35). Scored monotone tier + softened hard gate (~25, harness-set). **[C]**
- **Directional cross-sectional rsRank (non-scalp)** — z=+2.21, monotone; the one feature with a cross-regime prior. Upweight + soft floor; harness-gate before hard-gating. **[D/V]**
- **Volatility as a discriminator** — high-tail penalty, harness-set, not a fresh cliff. **[V]**
- **1.8×ATR stop** — sweep-optimal; tightening is harmful. **[C]**
- **Fixed rr ≤ 2.5**, never coupled to score. **[C]**
- **Net-of-cost accounting** (`FEE_RT`+`SLIP_RT`), `MIN_TARGET_PCT` floor, `QV_MIN`. **[C]**
- **Non-repainting closed-candle evaluation** (`closed()`/`evaluateSignal`), anti-chase `|close−EMA50|<3×ATR`, EMA50-slope-matches-side gate, per-horizon architecture, veryLong long-only guard. **[C]**

---

## 5. Guardrails against overfitting

1. **No threshold ships from the 371-trade panel.** Every value in P2-2/P2-3/P2-4/P2-5/P1-6/P3-3/P3-4 is harness-set on multi-regime history, or ships as a flag defaulting OFF. Repeat this caveat in code comments: *single-regime, N_effective ~15–25, thresholds are placeholders until OOS-confirmed.*
2. **Sign-stability across ≥2 regimes.** A rule is "real" only if its OOS lower-CI > 0 in ≥2 independent regime cells (up / chop / down) **and** its IC sign is stable fold-to-fold. Every KILL/KEEP above is a pre-registered hypothesis subject to this test.
3. **Net-of-cost, always.** Add a cost-to-target guard: reject signals where `costPct/riskPct > ~0.15` (tiny-risk scalps reach 0.3R–10.5R cost).
4. **Cluster-robust stats.** One observation per cron-hour cohort or block-bootstrap by day. Expect only `rr` and `ADX` to survive.
5. **Signal-count floor-check.** The redesign stacks new gates on ~7 existing ones; in chop/BTC-up this can starve to ~0 (killing utility *and* the ability to accumulate validation data). Convert **at most one** of {ADX, RS-floor, vol-cap} to a hard gate; make the others scored weights. If a gated rule admits < ~1 signal/week on a chop or BTC-up replay slice, **relax** ADX/vol rather than starve.
6. **Collider/selection awareness.** Every z was measured on the population that passed the *current* gates. Re-measure new weights on the **post-gate deployment population**, not the ADX≥18 set.
7. **Survivorship is one-directional (optimistic).** `buildUniverse` (130-142) = today's top-100 by volume; replayed backward it drops delisted/decayed coins. **The harness can falsify a losing rule but cannot confirm a profitable one.** State this on every report line.
8. **News excluded from replay** (no point-in-time archive) — document as a blind spot; test with the news overlay OFF (live effect ~0 anyway).
9. **Ship regime-independent fixes first, isolate their effect.** Deploy P1-1 (rr cap) alone, confirm in isolation, then layer the rest, so the rr fix isn't re-credited. Run the redesigned config in **parallel paper mode** (`KEEP_CLOSED=1500` supports it) and require survival of ≥1 non-BTC-down regime before switching the live feed.

---

## 6. Acceptance criteria (how Sonnet proves the redesign is better, without peeking)

Produce `data/backtest/report.json` + a console table demonstrating **all** of the following. No criterion may be met by in-sample refitting on the 371-trade window.

1. **Golden-run parity (P0-1):** current `gen-signals` output byte-identical before/after the export refactor. **Blocking.**
2. **Lookahead audit passes:** all three P0-3 asserts green across the full replay; zero candle with `ct > replayNow` in any indicator. **Blocking.**
3. **Net-of-cost, dual-fill:** every headline avgNetR under **both** close-fill and next-open. Close-fill-only edges are reported as artifacts.
4. **OOS avgNetR by major stratum (`horizon × side × regime`)** with block-bootstrap 90% CI, on strata meeting `STRATUM_MIN=50` post-purge/embargo. **Target: OOS lower-CI ≥ 0 (loss arrested) in the down-regime cells, sign-stable (not negative) in ≥1 non-down cell.** Positive lower-CI > 0 is a *stretch* goal, not a gate — breakeven is the honest bar.
5. **Signal-count reduction, quantified & floored:** expected signals/week per regime; a large cut vs the ~135/week baseline, but the floor-check shows no regime slice starves below ~1 signal/week (else relax and re-report).
6. **Calibration monotonicity:** the redesigned score's beta-binomial posterior P(win) is non-decreasing across buckets (within credible bands) on OOS folds.
7. **Ablation isolating the rr fix:** avgNetR for {baseline} → {rr-cap only} → {rr-cap + gates}, separating the rr lever from the overlays.
8. **Short-path contingency:** any retained short path prints OOS avgNetR ≥ 0 in **≥1 non-BTC-down regime**; else set shorts to zero and report that.
9. **NOT-BACKTESTABLE strata declared:** long/veryLong (and scalp if 1h paging fails) explicitly marked where purge/embargo or data depth drops n below the gate.

If a criterion cannot be met because data depth/survivorship forbids it, state the limitation explicitly rather than substituting an in-sample number.

---

## 7. Non-goals / myths not to reintroduce

- **No "flip to positive expectancy" claim.** The deliverable is loss-arrest toward breakeven.
- **No hard long-bias.** The disease is side-symmetric mechanical flooding; a long bias baked from this window becomes toxic long-flooding in BTC-up.
- **No hard-coded ADX=28 cliff / no carved 22-28 penalty band.** The trough is likely single-regime noise; softened gate + scored tier, harness-set.
- **No scalp rsRank invention** to hard-gate the 235 scalp trades on an untested signal.
- **No default partial-TP@1R + breakeven-as-default** — prior-verified myth. (BE-stop is a *different*, flag-gated, intrabar-validated mechanism, OFF by default.)
- **No funding / OI / long-short-ratio as alpha** — verified myths (and futures `fapi` is 451-geoblocked in CI anyway; no `.vision` mirror).
- **No extra confirming timeframes / EMAs** (~0.96 correlated — triple-counting the same factor).
- **No HMM / regime-switch models** — overfit for a 30-min cron; binary BTC up/down/flat + ADX label suffices.
- **No OBV / CMF / VWAP as scored inputs** — verified non-additive.
- **No logistic/continuous-coefficient score model** — chases noise at effective n ~15–25.
- **No isotonic calibration** — overfits small buckets; use beta-binomial shrinkage.
- **No "SMC is harmful" narrative** — mixed-engine confound; remove for parsimony only.
- **No gross-of-cost metrics anywhere.**

---

## Appendix A — Empirical evidence (from `public/data/signals.json`, verified)

**Global:** 405 closed (371 decided + 34 expired). WR 22.1%, avgR −0.22, avgNetR −0.34, sum netR **−126.6**.

**By stratum** (n / WR / avgNetR): scalp:short 198 / 25.3% / −0.21 · mid:short 120 / 15.4% / −0.47 · scalp:long 54 / 26.4% / −0.41 · mid:long 17 / 31.3% / −0.26 · long:short 14 / **0%** / −1.01 · long:long 2 / 50% / +0.74. **Shorts = 300 of 371.**

**Engine split (headline):** OLD 216 / 27.8% / −0.193 (sum −40.6) · NEW 155 / 14.2% / −0.555 (sum −86.0).

**Feature separation (winners vs losers, point-biserial z; |z|>2 discriminates):** rr −4.83 · sb.regime(ADX+DI) +3.08 · sb.btc −2.29 · rsRank(dir) +2.21 · ind.adx +2.18 · targetPct −1.52 · strength −1.44 · ind.volPct −1.32 · sb.volume −1.15 · sb.momentum −0.43 · sb.smc +0.41 · sb.news +0.10 · ind.macdHist +0.03 · **ind.rsi −0.01 (winMean 43.998 vs lossMean 44.009 — pure noise).**

**Bucket win-rates:** ADX 18-22 21.6% · 22-28 **10.9%** · 28-35 27.2% · 35+ 32.1%. volPct 0-0.3 25% · 0.3-0.5 20.7% · **0.5-0.7 33.3%** · 0.7-1.0 17.5%. rsRank(dir) bottom-third 6.7% · mid 12.2% · top-third 21%. SMC present 14.7% vs absent 26.0% (confounded). withNews 15.6% vs noNews 23%.

**RR tier (decided):** rr2.5 WR21%/−0.32 · rr3 WR5.7%/−0.85 · rr4 WR0%/−1.03 · (no-rr, old engine) WR27.8%.

**Path facts:** winners' median MAE 0.35R, 66% never draw past 0.5R. Losers reached median 21% toward TP; 18% reached ≥50% then reversed. Expired (34): median 63% toward TP, avg +5% at expiry. Longs taken while "BTC-down" warning present: 72% stopped out.

**Post-hoc cuts (single-regime, DIRECTIONAL only):** `ADX≥28 & rr≤2.5` → n46 WR30.4% avgNetR **+0.018** (sum +0.8) · `LONG & ADX≥28 & rr≤2.5` → n34 WR32.4% sum +3.3 · `ADX≥28 & rr≤2.5 & volPct≤0.7` → avgNetR +0.24 on n≈23 (≈5–8 independent bets — indistinguishable from zero).

## Appendix B — Reproduction

Analysis scripts used to derive the above (parameterized on `public/data/signals.json`) can be regenerated; the four cuts are: overall/stratum stats, feature-IC (point-biserial z of winners vs losers), engine-split (by presence of `rr` field), and time/regime distribution. Re-run any of them against a fresh `signals.json` after each deployed phase to track avgNetR drift.
