import { useState } from 'react'
import { ArrowLeft, Plus, RefreshCw, X } from 'lucide-react'
import { SourceLink, useResource } from './deskCommon'
import { ErrorBox } from './ui'
import { shortDay, tickerPattern } from './workspace'
import {
  dayTime,
  eventPeriod,
  horizons,
  latestSharedClose,
  type CalendarSelection,
  type Events,
  type Forecast,
  type Horizon,
  type MarketEvent,
  type Projections,
} from './forecastData'
import { ForecastChart, lineColors } from './ForecastChart'
import { ForecastEvents } from './ForecastEvents'
import './forecastCalendar.css'

const emptyEvents: MarketEvent[] = []
function civilPeriod(horizon: Horizon) {
  const start = new Date().toISOString().slice(0, 10),
    end = new Date(dayTime(start))
  if (horizon === '1d' || horizon === '1w')
    end.setUTCDate(end.getUTCDate() + (horizon === '1d' ? 1 : 7))
  else {
    const months = { '1mo': 1, '6mo': 6, '1y': 12, '5y': 60 }[horizon],
      day = end.getUTCDate()
    end.setUTCDate(1)
    end.setUTCMonth(end.getUTCMonth() + months)
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate()
    end.setUTCDate(Math.min(day, last))
  }
  return { start, end: end.toISOString().slice(0, 10) }
}
function ForecastSources({ series, seed }: { series: Forecast[]; seed: number }) {
  return (
    <details className="panel fc-sources">
      <summary>How the forecast is calculated</summary>
      <p>
        The center line is the median simulated price. The shaded range spans the 10th through 90th
        percentiles of the model’s simulated outcomes. Actual prices can fall outside the range.
      </p>
      <div className="fc-source-grid">
        {series.map((s) => (
          <section key={s.symbol}>
            <h3>{s.symbol}</h3>
            <small>
              Observed closes through {shortDay(s.as_of)} · {s.calendar}
            </small>
            <p>
              {s.method}
              {s.model_version ? ' · ' + s.model_version : ''}
            </p>
            <dl>
              <div>
                <dt>Price history</dt>
                <dd>
                  {shortDay(s.coverage.start)} – {shortDay(s.coverage.end)}
                </dd>
              </div>
              <div>
                <dt>Historical returns</dt>
                <dd>{s.coverage.returns.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Annualized volatility</dt>
                <dd>{s.annualized_volatility_pct.toFixed(1)}%</dd>
              </div>
              {s.validation_1d?.observed_coverage_pct != null && (
                <div>
                  <dt>One-day validation</dt>
                  <dd>
                    {s.validation_1d.inside_band_sessions} of {s.validation_1d.tested_sessions} past
                    closes within the modeled range
                  </dd>
                </div>
              )}
              <div>
                <dt>Simulation seed</dt>
                <dd>{seed}</dd>
              </div>
            </dl>
            {s.assumptions.length > 0 && (
              <ul>
                {s.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            )}
            {s.url ? <SourceLink url={s.url}>{s.source}</SourceLink> : <small>{s.source}</small>}
            {s.fetched && <small> · Retrieved {shortDay(s.fetched)}</small>}
            {s.stale && <p className="data-warning">Using cached prices.</p>}
          </section>
        ))}
      </div>
    </details>
  )
}
function CalendarResults({ symbols, horizon }: { symbols: string[]; horizon: Horizon }) {
  const projection = useResource<Projections>(
    '/desk/projections?' + new URLSearchParams({ symbols: symbols.join(','), horizon, seed: '42' }),
  )
  const series = projection.data?.series
  const period = (series && eventPeriod(series)) || civilPeriod(horizon)
  const calendar = useResource<Events>(
    projection.loading && !projection.data
      ? null
      : '/desk/events?' + new URLSearchParams({ symbols: symbols.join(','), ...period }),
  )
  const [selectedDate, setDate] = useState<string | null>(null),
    [eventId, selectEvent] = useState<string | null>(null)
  const events = calendar.data?.events || emptyEvents
  const date = selectedDate || (series && latestSharedClose(series)) || period.start
  const highlight = events.find((e) => e.id === eventId) || null
  const inspect = (e: MarketEvent) => selectEvent(e.id)
  return (
    <>
      {projection.loading && !series && (
        <p role="status">Loading observed prices and simulating future sessions…</p>
      )}
      <ErrorBox text={projection.error} />
      {projection.data?.errors.map((e) => (
        <p className="data-warning" key={e.symbol}>
          <strong>{e.symbol}</strong> · {e.error}
        </p>
      ))}
      {!projection.loading && (
        <button
          className="text-btn fc-refresh"
          onClick={() => {
            projection.reload(true)
            calendar.reload(true)
          }}
        >
          <RefreshCw size={13} /> Refresh sources
        </button>
      )}
      {!!series?.length && (
        <section className="panel fc-plot-panel">
          <ForecastChart
            series={series}
            symbols={symbols}
            events={events}
            date={date}
            choose={setDate}
            preview={inspect}
          />
          <p className="fc-model-caption">
            Simulated from historical prices. Events are shown for context.
            {series
              .filter((s) => s.url)
              .map((s) => (
                <SourceLink key={s.symbol} url={s.url!}>
                  {s.symbol} price history
                </SourceLink>
              ))}
          </p>
        </section>
      )}
      {!projection.loading && !series?.length && (
        <p className="fc-empty">
          A projection needs enough dated price history from a supported exchange.
        </p>
      )}
      {(!projection.loading || !!projection.data) && (
        <ForecastEvents
          events={events}
          start={period.start}
          end={period.end}
          highlight={highlight}
          inspect={inspect}
          date={date}
          selectDate={(d) => {
            setDate(d)
            selectEvent(null)
          }}
          loading={calendar.loading}
        />
      )}
      <ErrorBox text={calendar.error} />
      {!!calendar.data?.gaps.length && (
        <details className="panel fc-sources">
          <summary>Event source coverage</summary>
          <ul>
            {calendar.data.gaps.map((g, i) => (
              <li key={i}>
                <strong>{g.source}</strong>
                {g.symbols.length ? ' · ' + g.symbols.join(', ') : ''} · {g.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!series?.length && <ForecastSources series={series} seed={projection.data!.seed} />}
    </>
  )
}
export function ForecastCalendar({
  selection,
  change,
}: {
  selection: CalendarSelection
  change: (s: CalendarSelection) => void
}) {
  const [input, type] = useState(''),
    [error, fail] = useState('')
  const { symbols, horizon } = selection
  function add() {
    const s = input.trim().toUpperCase()
    if (!tickerPattern.test(s)) return fail('Enter an exchange ticker, such as AAPL.')
    if (symbols.includes(s)) return fail(s + ' is already on the calendar.')
    if (symbols.length >= 8) return fail('Choose up to eight tickers.')
    change({ symbols: [...symbols, s], horizon })
    type('')
    fail('')
  }
  return (
    <div className="forecast-calendar">
      <a className="fc-back" href={'#/research/' + encodeURIComponent(symbols[0])}>
        <ArrowLeft size={14} /> Research {symbols[0]}
      </a>
      <div className="page-head">
        <div>
          <h1>Forecast calendar</h1>
          <p>Explore possible price paths alongside upcoming market events.</p>
        </div>
      </div>
      <section className="panel fc-controls" aria-label="Forecast settings">
        <div className="fc-instruments">
          <div>
            <small>Tickers</small>
            <div className="fc-tickers">
              {symbols.map((s, i) => (
                <span key={s}>
                  <i style={{ background: lineColors[i] }} />
                  {s}
                  {symbols.length > 1 && (
                    <button
                      aria-label={'Remove ' + s + ' from forecast'}
                      onClick={() => {
                        fail('')
                        change({ horizon, symbols: symbols.filter((t) => t !== s) })
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              add()
            }}
          >
            <input
              aria-label="Ticker to compare"
              placeholder="Ticker to compare"
              value={input}
              onChange={(e) => {
                type(e.target.value)
                fail('')
              }}
              maxLength={20}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn" disabled={symbols.length >= 8 || !input.trim()}>
              <Plus size={15} /> Add ticker
            </button>
          </form>
        </div>
        <ErrorBox text={error} />
        <div className="fc-horizons">
          <small>Forecast horizon</small>
          <div className="range">
            {Object.entries(horizons).map(([key, label]) => (
              <button
                className={horizon === key ? 'selected' : ''}
                aria-pressed={horizon === key}
                key={key}
                onClick={() => change({ symbols, horizon: key as Horizon })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>
      <CalendarResults
        key={symbols.join(',') + '|' + horizon}
        symbols={symbols}
        horizon={horizon}
      />
    </div>
  )
}
