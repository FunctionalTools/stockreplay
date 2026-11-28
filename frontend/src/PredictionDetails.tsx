import { isLastPriceReference, type Forecast } from './forecastData'
import { providerName, type ForecastSnapshot } from './forecastSnapshot'
import { SourceLink } from './deskCommon'
import { shortDay } from './workspace'

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

function percent(value: number) {
  return number.format(value) + '%'
}

export function PredictionDetails({
  series,
  snapshots = [],
  panel = false,
}: {
  series: Forecast[]
  snapshots?: ForecastSnapshot[]
  panel?: boolean
}) {
  return (
    <details className={'fc-sources ' + (panel ? 'panel' : 'future-details')}>
      <summary>
        {series.every(isLastPriceReference)
          ? 'Why the last price is used'
          : 'How the prediction was calculated'}
      </summary>
      <div className="fc-source-grid">
        {series.map((s) => {
          const inputs = s.model_inputs
          const snapshot = snapshots.find((f) => f.symbol === s.symbol)
          const scores = snapshot?.scores
          const sources = snapshot?.sources || []
          const reference = isLastPriceReference(s)
          const sessions = s.projected_sessions ?? s.points.length - 1
          const longerCheck =
            sessions >= 200
              ? { period: 'one-year', result: s.validation_252d }
              : sessions >= 10
                ? { period: 'one-month', result: s.validation_21d }
                : undefined
          const observations: [string, number | null | undefined][] = inputs
            ? [
                ['Price change over 5 sessions', inputs.momentum_5d_pct],
                ['Price change over 21 sessions', inputs.momentum_21d_pct],
                ['Price change over 63 sessions', inputs.momentum_63d_pct],
                ['Change from the 63-session high', inputs.drawdown_63d_pct],
                ['21-session volatility, annualized', inputs.volatility_21d_pct],
              ]
            : [['Annualized volatility', s.annualized_volatility_pct]]
          return (
            <section key={s.symbol}>
              <h3>{s.symbol}</h3>
              <p>
                {s.coverage.returns.toLocaleString()} historical returns from{' '}
                {shortDay(s.coverage.start)} through {shortDay(s.coverage.end)}.
              </p>
              {reference && (
                <p>
                  <strong>Last-price reference</strong> ·{' '}
                  {inputs?.reference_reason ||
                    'The price model carries the observed price forward.'}
                </p>
              )}
              {!reference &&
                inputs?.matched_horizon_sessions != null &&
                inputs.independent_horizon_matches != null && (
                  <p>
                    {inputs.independent_horizon_matches} independent historical periods of{' '}
                    {inputs.matched_horizon_sessions} trading sessions informed the last part of the
                    prediction.
                  </p>
                )}
              {!reference && inputs?.regime && (
                <p>
                  <strong>Recent trend</strong> · {inputs.regime}
                </p>
              )}
              <dl>
                {observations.map(
                  ([title, value]) =>
                    value != null && (
                      <div key={title}>
                        <dt>{title}</dt>
                        <dd>{percent(value)}</dd>
                      </div>
                    ),
                )}
              </dl>
              {!reference && s.validation_1d?.model_mae_pct != null && (
                <p>
                  The average next-session prediction error was{' '}
                  {percent(s.validation_1d.model_mae_pct)} across {s.validation_1d.tested_sessions}{' '}
                  historical sessions.
                  {s.validation_1d.flat_mae_pct != null &&
                    ' Holding the last price constant gave an average error of ' +
                      percent(s.validation_1d.flat_mae_pct) +
                      '.'}
                </p>
              )}
              {!reference && longerCheck?.result?.model_mae_pct != null && (
                <p>
                  Across {longerCheck.result.tested_sessions} nonoverlapping {longerCheck.period}{' '}
                  {longerCheck.result.tested_sessions === 1 ? 'period' : 'periods'}, the price model
                  missed the observed return by {number.format(longerCheck.result.model_mae_pct)}{' '}
                  percentage points on average.
                  {longerCheck.result.flat_mae_pct != null &&
                    ' Holding the starting price constant gave an average error of ' +
                      number.format(longerCheck.result.flat_mae_pct) +
                      ' points.'}
                </p>
              )}
              {inputs?.matched_horizon_sessions != null &&
                inputs.matched_horizon_sessions > 0 &&
                inputs.matched_horizon_sessions < sessions && (
                  <p>
                    The available history supports {inputs.matched_horizon_sessions} trading
                    sessions. The price model holds its estimate beyond that point.
                  </p>
                )}
              {scores && (
                <div className="prediction-score-evidence">
                  <strong>
                    {scores.origin === 'saved_research'
                      ? 'Saved research scores'
                      : 'Forecast model scores'}
                  </strong>
                  <small>
                    {providerName(scores.provider)} · {scores.model} · {shortDay(scores.as_of)}
                  </small>
                  {reference && (
                    <p>
                      These scores assess the company independently of the last-price reference.
                    </p>
                  )}
                  {(['buy', 'risk'] as const).map((kind) => (
                    <div key={kind}>
                      <h4>
                        {kind === 'buy' ? 'Buy score' : 'Risk score'} ·{' '}
                        {scores[kind === 'buy' ? 'buy_status' : 'risk_status'] === 'unresolved'
                          ? 'Unresolved'
                          : scores[kind === 'buy' ? 'buy_score' : 'risk_score'] + '/100'}
                      </h4>
                      <p>{kind === 'buy' ? scores.buy_reason : scores.risk_reason}</p>
                      <div className="future-citations">
                        {sources
                          .filter((src) =>
                            (kind === 'buy'
                              ? scores.buy_source_ids
                              : scores.risk_source_ids
                            ).includes(src.id),
                          )
                          .map((src) => (
                            <SourceLink key={src.id} url={src.url}>
                              {src.title || src.source}
                            </SourceLink>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {s.url && <SourceLink url={s.url}>{s.source} price history</SourceLink>}
            </section>
          )
        })}
      </div>
    </details>
  )
}
