import { useMemo, useState } from 'react'
import { ArrowLeft, Plus, RefreshCw, X } from 'lucide-react'
import { SourceLink, useResource } from './deskCommon'
import { ErrorBox } from './ui'
import { shortDay, tickerPattern } from './workspace'
import {
  dayTime,
  eventPeriod,
  eventPaths,
  calendarHref,
  forecastInspectionDate,
  horizons,
  type CalendarSelection,
  type Events,
  type Forecast,
  type Horizon,
  type MarketEvent,
  type Projections,
} from './forecastData'
import { validDay } from './priceRanges'
import { futureHref } from './forecastSnapshot'
import { ForecastChart, lineColors } from './ForecastChart'
import { ForecastEvents } from './ForecastEvents'
import './forecastCalendar.css'

const emptyEvents: MarketEvent[] = []
function civilPeriod({ horizon, start: from, end: to }: CalendarSelection) {
  if (horizon === 'custom' && from && to) return { start: from, end: to }
  const start = new Date().toISOString().slice(0, 10),
    end = new Date(dayTime(start))
  if (horizon === '1d' || horizon === '1w' || horizon === '5d')
    end.setUTCDate(end.getUTCDate() + (horizon === '1d' ? 1 : 7))
  else if (horizon === 'ytd') end.setUTCMonth(11, 31)
  else {
    const months = horizon === 'max' ? 120 : parseInt(horizon) * (horizon.endsWith('y') ? 12 : 1),
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
              Confirmed daily closes through {shortDay(s.coverage.end)} · {s.calendar}
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
          </section>
        ))}
      </div>
    </details>
  )
}
function CalendarResults(selection: CalendarSelection) {
  const { symbols, horizon, start, end } = selection
  const custom = horizon === 'custom' && start && end ? { start, end } : null
  const query = new URLSearchParams({ symbols: symbols.join(','), horizon, seed: '42', ...custom })
  const projection = useResource<Projections>('/desk/projections?' + query)
  const series = projection.data?.series
  const period = custom || (series && eventPeriod(series)) || civilPeriod(selection)
  const [firstEvents, laterEvents] = eventPaths(symbols, period.start, period.end)
  const ready = !projection.loading || !!projection.data
  const calendar = useResource<Events>(ready ? firstEvents : null)
  const later = useResource<Events>(ready ? laterEvents : null)
  const [selectedDate, setDate] = useState<string | null>(null),
    [eventId, selectEvent] = useState<string | null>(null)
  const events = useMemo(
    () => [
      ...new Map(
        [...(calendar.data?.events || emptyEvents), ...(later.data?.events || emptyEvents)].map(
          (e) => [e.id, e],
        ),
      ).values(),
    ],
    [calendar.data, later.data],
  )
  const gaps = [
    ...new Map(
      [...(calendar.data?.gaps || []), ...(later.data?.gaps || [])].map((g) => [
        JSON.stringify(g),
        g,
      ]),
    ).values(),
  ]
  const endSession = useMemo(() => series && forecastInspectionDate(series), [series])
  const date = selectedDate || endSession || period.start
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
            later.reload(true)
          }}
        >
          <RefreshCw size={13} /> Refresh sources
        </button>
      )}
      {!!series?.length && (
        <section className="panel fc-plot-panel">
          {series
            .filter((s) => s.data_note || s.stale)
            .map((s) => (
              <p className="data-warning" key={s.symbol}>
                <strong>{s.symbol}</strong> · {s.data_note || 'Using cached prices.'}
              </p>
            ))}
          <ForecastChart
            series={series}
            symbols={symbols}
            events={events}
            date={date}
            choose={setDate}
            preview={inspect}
            civilEnd={period.end}
            forwardStart={custom?.start}
          />
          <p className="fc-model-caption">
            Simulated from historical prices. Events are shown for context.
            {series.flatMap((s) =>
              (s.price_sources || [{ source: s.source, url: s.url }]).flatMap((source) =>
                source.url ? (
                  <SourceLink key={s.symbol + source.url} url={source.url}>
                    {s.symbol} · {source.source}
                  </SourceLink>
                ) : (
                  []
                ),
              ),
            )}
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
          loading={calendar.loading || later.loading}
        />
      )}
      <ErrorBox text={calendar.error || later.error} />
      {!!gaps.length && (
        <details className="panel fc-sources">
          <summary>Event source coverage</summary>
          <ul>
            {gaps.map((g, i) => (
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
    [error, fail] = useState(''),
    [editing, editDates] = useState(false)
  const { symbols, horizon } = selection
  function add() {
    const s = input.trim().toUpperCase()
    if (!tickerPattern.test(s)) return fail('Enter an exchange ticker, such as AAPL.')
    if (symbols.includes(s)) return fail(s + ' is already on the calendar.')
    if (symbols.length >= 8) return fail('Choose up to eight tickers.')
    change({ ...selection, symbols: [...symbols, s] })
    type('')
    fail('')
  }
  return (
    <div className="forecast-calendar">
      <a
        className="fc-back"
        href={futureHref(symbols[0], horizon, selection.start, selection.end, symbols.slice(1))}
      >
        <ArrowLeft size={14} /> {symbols[0]} Future chart
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
                        change({ ...selection, symbols: symbols.filter((t) => t !== s) })
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
                onClick={() => {
                  editDates(key === 'custom')
                  fail('')
                  if (key !== 'custom') change({ symbols, horizon: key as Horizon })
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {(editing || horizon === 'custom') && (
          <form
            className="range-dates"
            key={selection.start + '/' + selection.end}
            onSubmit={(e) => {
              e.preventDefault()
              const data = new FormData(e.currentTarget)
              const start = String(data.get('start')),
                end = String(data.get('end'))
              if (!validDay(start) || !validDay(end) || start > end)
                return fail('Choose future dates in chronological order.')
              fail('')
              editDates(false)
              change({ symbols, horizon: 'custom', start, end })
            }}
          >
            <label>
              Forecast start date
              <input required type="date" name="start" defaultValue={selection.start} />
            </label>
            <label>
              Forecast end date
              <input required type="date" name="end" defaultValue={selection.end} />
            </label>
            <button className="btn small">Apply dates</button>
          </form>
        )}
      </section>
      <CalendarResults key={calendarHref(selection)} {...selection} />
    </div>
  )
}
