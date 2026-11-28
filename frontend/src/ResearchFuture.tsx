import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Sparkles } from 'lucide-react'
import { ForecastChart } from './ForecastChart'
import { EventCard } from './ForecastEvents'
import { PricePlot, marketPrice } from './PricePlot'
import { pct } from './types'
import { useResource, SourceLink } from './deskCommon'
import { Busy, ErrorBox } from './ui'
import { shortDay, type Connection } from './workspace'
import { rangeLabel, rangePresets, validDay, type RangePrices, type Selection } from './priceRanges'
import {
  futureHref,
  selectedFuture,
  snapshotPath,
  providerName,
  quarterMarkers,
  modelEventMarkers,
  type ForecastSnapshot,
  type ForecastSource,
} from './forecastSnapshot'
import { dayTime, type Events, type MarketEvent } from './forecastData'
import { useSavedForecast } from './useSavedForecast'
import { ForecastComparison, extraSymbols } from './ForecastComparison'
import './researchFuture.css'
export { futureHref } from './forecastSnapshot'

const label = (preset: string) =>
  preset === 'ytd' ? 'Year-end' : preset === 'max' ? 'Max (10Y)' : rangeLabel(preset)
const after = (date: string, days: number) =>
  new Date(dayTime(date) + 86400000 * days).toISOString().slice(0, 10)

function Citations({ ids, sources }: { ids: string[]; sources: ForecastSource[] }) {
  const links = sources.filter((s) => ids.includes(s.id) && /^https?:\/\//i.test(s.url))
  return links.length ? (
    <div className="future-citations">
      {links.map((s) => (
        <SourceLink key={s.id} url={s.url}>
          {s.title || s.source}
        </SourceLink>
      ))}
    </div>
  ) : null
}
function ModelOutlook({
  forecast,
  quarterIndex,
  selectQuarter,
}: {
  forecast: ForecastSnapshot
  quarterIndex: number
  selectQuarter: (n: number) => void
}) {
  const f = forecast,
    q = f.quarters[quarterIndex]
  return (
    <div className="future-outlook">
      <h3>{f.symbol} forecast outlook</h3>
      <p>{f.summary}</p>
      <Citations ids={f.summary_source_ids} sources={f.sources} />
      {!!f.quarters.length && (
        <div className="future-fiscal">
          <strong>Fiscal-quarter outlook</strong>
          <div className="range" role="group" aria-label="Fiscal quarters">
            {f.quarters.map((v, i) => (
              <button
                key={v.quarter}
                aria-pressed={i === quarterIndex}
                className={i === quarterIndex ? 'selected' : ''}
                onClick={() => selectQuarter(i)}
              >
                {v.quarter}
              </button>
            ))}
          </div>
          {q && (
            <div className="future-quarter-detail">
              <strong>{q.period || q.quarter}</strong>
              <small>
                {q.date
                  ? 'Fiscal period end · ' + shortDay(q.date) + ' · ' + q.timing
                  : 'Fiscal period-end date unavailable'}
              </small>
              <p>{q.expectation}</p>
              {q.consensus.length > 0 && (
                <dl>
                  {q.consensus.map((c, i) => (
                    <div key={i}>
                      <dt>{c.metric} · published estimate</dt>
                      <dd>
                        {typeof c.value === 'number'
                          ? c.value.toLocaleString(undefined, { maximumFractionDigits: 4 })
                          : c.value}{' '}
                        {c.unit} · {c.period}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <Citations
                ids={[...q.source_ids, ...q.consensus.map((c) => c.source_id)]}
                sources={f.sources}
              />
            </div>
          )}
        </div>
      )}
      <details className="future-details">
        <summary>Drivers, sources and assumptions</summary>
        {f.drivers.map((d, i) => (
          <div key={i}>
            <h4>
              {d.title} <small>· {d.direction}</small>
            </h4>
            <p>{d.reason}</p>
            <Citations ids={d.source_ids} sources={f.sources} />
          </div>
        ))}
        <p>
          {f.method}. The shaded range covers the 10th to 90th percentiles of the modeled outcomes.
        </p>
        {f.assumptions.length > 0 && (
          <ul>
            {f.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        )}
        {f.url && <SourceLink url={f.url}>{f.source} price history</SourceLink>}
      </details>
    </div>
  )
}
function GeneratedView({ f, extras }: { f: ForecastSnapshot; extras: ForecastSnapshot[] }) {
  const series = useMemo(() => [f, ...extras], [f, extras]),
    symbols = useMemo(() => series.map((v) => v.symbol), [series])
  const symbol = f.symbol
  const [date, choose] = useState(f.points.at(-1)?.date || f.as_of),
    [quarter, selectQuarter] = useState(-1),
    [highlight, setHighlight] = useState<MarketEvent | null>(null)
  const start = f.range === 'custom' && f.requested_start ? f.requested_start : f.as_of,
    end =
      series
        .map((s) => s.requested_end || s.points.at(-1)?.date || s.as_of)
        .sort()
        .at(-1) || f.as_of
  // Government event feeds accept six-year windows, while price paths can span ten.
  const midpointDate = new Date(dayTime(start))
  midpointDate.setUTCFullYear(midpointDate.getUTCFullYear() + 5)
  const midpoint = midpointDate.toISOString().slice(0, 10)
  const eventPath = (a: string, b: string) =>
    '/desk/events?' + new URLSearchParams({ symbols: symbols.join(','), start: a, end: b })
  const early = useResource<Events>(eventPath(start, end > midpoint ? midpoint : end))
  const later = useResource<Events>(end > midpoint ? eventPath(after(midpoint, 1), end) : null)
  const events = useMemo(() => {
    const unique = new Map<string, MarketEvent>()
    for (const event of [
      ...series.flatMap(quarterMarkers),
      ...series.flatMap(modelEventMarkers),
      ...(early.data?.events || []),
      ...(later.data?.events || []),
    ]) {
      const quarter = event.kind === 'fiscal' && event.title.match(/\bQ[1-4]\b/i)?.[0].toUpperCase()
      const key = quarter
        ? [event.date, ...event.symbols, quarter].join('|')
        : [event.date, event.url, event.title].join('|')
      if (!unique.has(key)) unique.set(key, event)
    }
    return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date))
  }, [series, early.data, later.data])
  const datedQuarters = quarterMarkers(f)
  const active = events.find((e) => e.id === highlight?.id) || null
  function inspect(e: MarketEvent) {
    setHighlight(e)
    const i = f.quarters.findIndex((q) => 'forecast-' + symbol + '-' + q.quarter === e.id)
    if (i >= 0) selectQuarter(i)
  }
  function focusQuarter(i: number) {
    selectQuarter(i)
    const marker = datedQuarters.find(
      (e) => e.id === 'forecast-' + symbol + '-' + f.quarters[i].quarter,
    )
    if (marker) {
      choose(marker.date)
      setHighlight(marker)
    }
  }
  const eError = early.error || later.error
  return (
    <>
      <ForecastChart
        compact
        civilEnd={end}
        series={series}
        symbols={symbols}
        events={events}
        date={date}
        choose={choose}
        preview={inspect}
        forwardStart={f.range === 'custom' && f.requested_start ? f.requested_start : undefined}
      />
      <details className="future-events">
        <summary>Events and expectations{events.length ? ' · ' + events.length : ''}</summary>
        {events.length > 0 && (
          <>
            <label>
              Events and expectations
              <select
                aria-label="Inspect a forecast event"
                value={active?.id || ''}
                onChange={(e) => {
                  const selected = events.find((v) => v.id === e.target.value)
                  if (selected) {
                    inspect(selected)
                    choose(selected.date)
                  }
                }}
              >
                <option value="">Choose an event</option>
                {events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {shortDay(e.date)} · {e.title}
                  </option>
                ))}
              </select>
            </label>
            {active && <EventCard event={active} />}
          </>
        )}
        {early.loading || later.loading ? (
          <small role="status">Checking published calendar events…</small>
        ) : (
          !events.length && <small>No sourced event dates in this forecast period.</small>
        )}
        {eError && <ErrorBox text={eError} />}
        {!!((early.data?.gaps.length || 0) + (later.data?.gaps.length || 0)) && (
          <details>
            <summary>Event source coverage</summary>
            {[...(early.data?.gaps || []), ...(later.data?.gaps || [])].map((g, i) => (
              <p key={i}>
                {g.source} · {g.reason}
              </p>
            ))}
          </details>
        )}
      </details>
      <ModelOutlook forecast={f} quarterIndex={quarter} selectQuarter={focusQuarter} />
    </>
  )
}
function ForecastResult({
  symbol,
  selection,
  connection,
  settings,
  observed,
  controls,
  extras,
  changeExtras,
}: {
  symbol: string
  selection: Selection
  connection: Connection | null
  settings: () => void
  observed: RangePrices | null
  controls: React.ReactNode
  extras: string[]
  changeExtras: (symbols: string[]) => void
}) {
  const {
    forecast: f,
    busy,
    loading,
    error,
    generate,
  } = useSavedForecast(snapshotPath(symbol, selection))
  const [records, setRecords] = useState<Record<string, ForecastSnapshot | null>>({})
  const remember = useCallback((ticker: string, snapshot: ForecastSnapshot | null) => {
    setRecords((prev) => (prev[ticker] === snapshot ? prev : { ...prev, [ticker]: snapshot }))
  }, [])
  const compareSeries = useMemo(() => extras.flatMap((s) => records[s] || []), [extras, records])
  const point = f?.points.at(-1),
    last = f?.history.at(-1)?.price ?? observed?.bars.at(-1)?.raw_close,
    currency = f?.currency || observed?.currency
  const delta = point && last && last > 0 ? (point.median / last - 1) * 100 : null
  return (
    <>
      <div className="section-head">
        <div>
          <small>{point ? 'AI median at last forecast session' : 'Last observed close'}</small>
          <div className="quote">{marketPrice(point?.median ?? last, currency)}</div>
        </div>
        {delta != null && (
          <div className="period-change">
            <span className={'delta ' + (delta >= 0 ? 'up' : 'down')}>{pct(delta)}</span>
            <small>From last close</small>
          </div>
        )}
      </div>
      <small className="range-as-of">
        {point
          ? shortDay(point.date)
          : observed
            ? shortDay(observed.as_of)
            : 'Awaiting observed close'}
        {currency ? ' · ' + currency : ''}
      </small>
      {controls}
      <div className="future-toolbar">
        <div className="future-generate">
          <button
            className="btn primary"
            onClick={generate}
            disabled={busy || !connection?.configured || (loading && !f)}
          >
            <Sparkles size={14} />
            {busy ? 'Generating forecast…' : f ? 'Update forecast' : 'Generate forecast'}
          </button>
          {connection?.configured ? (
            <small>
              {providerName(connection.provider)} · {connection.model}
            </small>
          ) : (
            <button className="text-btn" onClick={settings}>
              Set up a forecast model
            </button>
          )}
        </div>
        <ForecastComparison
          primary={symbol}
          extras={extras}
          selection={selection}
          change={changeExtras}
          ready={!!connection?.configured}
          remember={remember}
        />
      </div>
      {connection?.generation_detail && !connection.verified && (
        <p className="future-status">
          {connection.generation_detail}{' '}
          <button className="text-btn" onClick={settings}>
            AI settings
          </button>
        </p>
      )}
      {busy && (
        <p className="future-status" role="status">
          <Busy text="Reading sourced evidence and generating the price path" />
        </p>
      )}
      <ErrorBox text={error} />
      {f ? (
        <>
          <small className="future-saved">
            Generated{' '}
            {new Date(f.created).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}{' '}
            with {providerName(f.provider)} · {f.model}. Observed close {shortDay(f.as_of)}.
          </small>
          <GeneratedView key={f.id} f={f} extras={compareSeries} />
        </>
      ) : (
        <>
          {observed && <PricePlot series={[observed]} />}
          <p className="future-empty">
            {loading
              ? 'Checking for a saved forecast…'
              : busy
                ? 'Your forecast will appear here.'
                : 'Generate a forecast to overlay a model price path, uncertainty band and sourced expectations on observed prices.'}
          </p>
        </>
      )}
    </>
  )
}
export function ResearchFuture({
  symbol,
  query,
  connection,
  settings,
  observed,
}: {
  symbol: string
  query: string
  connection: Connection | null
  settings: () => void
  observed: RangePrices | null
}) {
  const extras = useMemo(() => extraSymbols(symbol, query), [symbol, query])
  const selection = selectedFuture(query),
    [editing, edit] = useState(false)
  const firstDay = observed?.as_of
    ? after(observed.as_of, 1)
    : new Date().toISOString().slice(0, 10)
  const [start, setStart] = useState(''),
    [end, setEnd] = useState('')
  const bad = !!(start && end && (end < start || start < firstDay))
  useEffect(() => edit(false), [query])
  const pick = (preset: string, a?: string, b?: string) => {
    edit(false)
    window.location.hash = futureHref(symbol, preset, a, b, extras)
  }
  const controls = (
    <>
      <div className="range range-options" role="group" aria-label="Forecast period">
        {rangePresets.map((p) => (
          <button
            type="button"
            key={p}
            aria-pressed={(editing ? 'custom' : selection.preset) === p}
            className={(editing ? 'custom' : selection.preset) === p ? 'selected' : ''}
            onClick={() => {
              if (p === 'custom') {
                setStart(selection.start || firstDay)
                setEnd(selection.end || after(firstDay, 30))
                edit(true)
              } else pick(p)
            }}
          >
            {label(p)}
          </button>
        ))}
      </div>
      {editing && (
        <form
          className="range-dates"
          onSubmit={(e) => {
            e.preventDefault()
            if (!bad && validDay(start) && validDay(end)) pick('custom', start, end)
          }}
        >
          <label>
            Forecast start date
            <input
              type="date"
              required
              value={start}
              min={firstDay}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            Forecast end date
            <input
              type="date"
              required
              min={start || firstDay}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <button className="btn" disabled={bad || !start || !end}>
            Apply dates
          </button>
          {bad && (
            <small>
              <AlertCircle size={12} /> Choose future dates in chronological order.
            </small>
          )}
        </form>
      )}
      {!editing && selection.preset === 'custom' && (
        <small className="range-window">
          {shortDay(selection.start)} – {shortDay(selection.end)} · inclusive
        </small>
      )}
    </>
  )
  return (
    <ForecastResult
      key={snapshotPath(symbol, selection)}
      symbol={symbol}
      selection={selection}
      extras={extras}
      changeExtras={(next) => {
        window.location.hash = futureHref(
          symbol,
          selection.preset,
          selection.start,
          selection.end,
          next,
        )
      }}
      connection={connection}
      settings={settings}
      observed={observed}
      controls={controls}
    />
  )
}
