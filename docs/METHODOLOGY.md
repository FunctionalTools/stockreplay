# Statistical methodology

## Clock, universe and prices

The engine evaluates daily bars on the XNYS session calendar. Dates are inclusive. Every required ticker, including cross-stock triggers and the benchmark, must cover every required session. A missing observation prevents the run. Returns never bridge a missing required bar. Choose a common listing period for a multi-asset study.

Adjusted OHLC equals raw OHLC multiplied by adjusted close divided by raw close. The economic return therefore reflects provider adjustments for splits and distributions. The engine preserves raw prices, dividends and split fields in the snapshot. It does not add dividends to an already adjusted return. Quotes displayed in the event inspector and candlestick chart use the adjusted price basis, so they can differ from the nominal historical tape.

Indicators warm up inside the configured history. A rule without sufficient trailing data does not fire. In chronological evaluation, indicators may use earlier observations for warm-up. Training positions must complete within training, and holdout positions must originate in and complete within the relevant holdout fold. An evaluation run does not open positions in its final sessions unless their full planned horizon fits. This boundary is known before trading.

## Signal definitions

| Signal | Calculation |
| --- | --- |
| Daily / cumulative return | 100 × (adjusted close today / adjusted close one or N sessions ago − 1) |
| Positive / negative streak | Number of consecutive strictly positive / negative one-session returns. A flat session resets the streak |
| SMA distance | 100 × (close / N-session simple moving average − 1) |
| Moving-average crossover | A 0/1 pulse when the fast-minus-slow difference moves from nonpositive to positive (bullish) or nonnegative to negative (bearish) |
| RSI | Cutler RSI with simple-window mean gains and losses. Flat windows return 50 |
| Relative volume | Current share volume / mean volume over the previous N completed sessions |
| Volatility | Sample standard deviation of the trailing N daily simple returns × √252 × 100 |
| Drawdown signal | 100 × (close / maximum closing price over the trailing N sessions − 1) |
| Relative return | Asset N-session percentage return less the benchmark return over the same interval |
| Regime | Bull at or above the benchmark’s 200-session SMA; bear below it. The initial warm-up is unclassified |

Share-volume levels are provider-reported. Relative-volume ratios do not adjust for structural changes in shares outstanding. All entry rules share one AND/OR group, as do optional exit rules. A rule may refer to the traded asset, the benchmark, or another explicitly loaded symbol.

## Execution and costs

A close-based signal on session t enters at the adjusted open of t+1. A fixed H-session position exits at the close of t+H. An optional close-based exit signal observed while holding executes at the following open if that occurs by the fixed exit session. The earlier exit supersedes the fixed exit. The engine never trades the signal close retroactively.

Commission c and slippage s are per-side fractions (basis points divided by 10,000). The buy factor is (1+s)(1+c) and the sale factor is (1−s)(1−c). A completed trade’s net return is **exit price × sale factor / (entry price × buy factor) − 1**. Matched benchmark returns use the same dates, opening or closing convention and costs. All percentage outputs are in percentage points.

## Event study and portfolio backtest

An event study admits all qualifying signals, including overlapping windows. Its mean is equally weighted across observations. It has no compounded portfolio return. Its event path shows the average mark-to-liquidation return at each relative session after entry. An early exit freezes both the asset and matched benchmark path for the remaining horizon.

A portfolio backtest divides starting capital equally across the specified symbols and keeps a separate cash/position balance per symbol. It uses fractional shares. An idle sleeve is cash with zero interest. Each sleeve takes one long position at a time, reinvests its own proceeds and skips signals whose proposed entry overlaps the current trade, including its exit session. Open positions are marked at each adjusted close. There is no leverage, shorting, cross-sleeve transfer, or daily rebalancing. A buy-and-hold benchmark enters on the first open and liquidates on the final close with matching per-side frictions.

Portfolio total return is final wealth divided by initial wealth minus one. Maximum drawdown includes starting cash in the running peak. CAGR uses elapsed calendar days with 365.2425 days/year and is shown only for spans of at least 365 days. Sharpe uses close-to-close portfolio returns including cash days, zero risk-free return, sample volatility and √252 annualization. It is omitted for fewer than 252 sessions or zero variance.

## Objectives and contrary cases

**Positive** and **negative** compare net return against zero. **Outperform** and **underperform** compare net return with the matched benchmark. Ties fail the strict directional objective. **Recovery** tests whether an observed adjusted close during the holding window regains the adjusted close immediately before the signal session. A next-open exit excludes that day’s subsequent close. Recovery frequency and terminal net return answer different questions.

The win rate is the fraction satisfying the selected objective. For inference, the effect is net return, its negation, signed excess return, or its negation as appropriate. For recovery the effect is a 0/100 observation and its mean is the recovery frequency. The explorer includes every observation and allows sorting by the worst or best actual asset return. A contrary case can have a positive absolute return when its benchmark did better.

## Dependent-sample inference

The seeded circular moving-block bootstrap resamples whole trading-day blocks, including days with no signal. Each date retains all simultaneous events across symbols. Every resample computes an event-weighted effect by dividing the resampled sum of effects by the resampled number of events. This retains clustering and some temporal dependence from overlapping holds.

The block length is the largest of the holding period, requested minimum block length, and the cube-root calendar-length rule, capped by the available period. The default is 1,000 replicates and a 95% percentile interval. The approximate two-sided null p-value uses the fraction of centered bootstrap deviations at least as large as the observed distance from the null, with a plus-one finite-sample correction. The reference is zero directional return, or 50% for recovery frequency. The 50% reference is a descriptive threshold. Estimating the unconditional recovery rate requires a separate baseline study.

Intervals and p-values are withheld for fewer than eight events, fewer than five distinct signal dates, fewer than three blocks, insufficient nonempty replicates or effectively constant bootstrap draws. Fewer than 30 events trigger a sample-size warning. The method assumes roughly stable dependence within the sample. Regime changes and correlations longer than the chosen block can invalidate inference. It does not estimate a causal treatment effect or adjust for searching multiple hypotheses.

## Robustness

The grid varies the first entry rule’s threshold and the holding period. The base configuration also controls the universe, date range, commission, slippage and regime. The heatmap presents the directional effect separately for training and holdout. Commission sensitivity runs hold the other parameters at their base settings. Cells with no qualifying observations remain empty.

Walk-forward evaluation uses expanding training windows and successive disjoint test windows. It selects the largest training effect among combinations with at least five training observations, fixes the parameters, and evaluates the immediately subsequent block. Ties retain grid order. A fold without an eligible candidate records insufficient evidence. Looking at many holdout grids can itself overfit; independent future data is still valuable.

## Interpretation limits

Today’s tickers can favor survivors. No historical constituent list, delisting-return feed, tick-level fill model, capacity constraint, tax treatment or FX conversion is provided. Price history can be revised by the vendor. Saved snapshots preserve the input values used at the time of a run. A profitable sample, a small p-value or a favorable holdout does not establish a forecast.
