import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Sparkles } from 'lucide-react'
import { ForecastChart } from './ForecastChart'
import { EventCard } from './ForecastEvents'
import { marketPrice } from './PricePlot'
import { pct } from './types'
import { useResource, SourceLink } from './deskCommon'
import { Busy, ErrorBox } from './ui'
import { shortDay, type Connection } from './workspace'
import { rangeLabel, rangePresets, validDay, type Selection } from './priceRanges'
import {
  futureHref,
  selectedFuture,
  snapshotPath,
  matchesProjection,
  projectionPath,
  providerName,
  quarterMarkers,
  modelEventMarkers,
  type ForecastSnapshot,
  type ForecastSource,
} from './forecastSnapshot'
import {
  dayTime,
  eventPaths,
  type Events,
  type Forecast,
  type Projections,
  type MarketEvent,
} from './forecastData'
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
function ProjectionView({
  series,
  snapshots,
  selection,
  archived = false,
}: {
  series: Forecast[]
  snapshots: ForecastSnapshot[]
  selection: Selection
  archived?: boolean
}) {
  const f = series[0],
    symbol = f.symbol
  const symbols = useMemo(() => series.map((s) => s.symbol), [series])
  const primaryAI = snapshots.find((s) => s.symbol === symbol)
  const [date, choose] = useState(f.points.at(-1)?.date || f.as_of),
    [quarter, selectQuarter] = useState(-1),
    [highlight, setHighlight] = useState<MarketEvent | null>(null)
  const start =
      selection.preset === 'custom' && selection.start
        ? selection.start
        : f.horizon_origin || f.as_of,
    end =
      series
        .map((s) => s.requested_end || s.points.at(-1)?.date || s.as_of)
        .sort()
        .at(-1) || f.as_of
  const [firstEvents, laterEvents] = eventPaths(symbols, start, end)
  const early = useResource<Events>(archived ? null : firstEvents)
  const later = useResource<Events>(archived ? null : laterEvents)
  const events = useMemo(() => {
    const unique = new Map<string, MarketEvent>()
    for (const event of [
      ...snapshots.flatMap(quarterMarkers),
      ...snapshots.flatMap(modelEventMarkers),
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
  }, [snapshots, early.data, later.data])
  const datedQuarters = primaryAI ? quarterMarkers(primaryAI) : []
  const active = events.find((e) => e.id === highlight?.id) || null
  function inspect(e: MarketEvent) {
    setHighlight(e)
    const i =
      primaryAI?.quarters.findIndex((q) => 'forecast-' + symbol + '-' + q.quarter === e.id) ?? -1
    if (i >= 0) selectQuarter(i)
  }
  function focusQuarter(i: number) {
    if (!primaryAI) return
    selectQuarter(i)
    const marker = datedQuarters.find(
      (e) => e.id === 'forecast-' + symbol + '-' + primaryAI.quarters[i].quarter,
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
        aiSymbols={snapshots.map((s) => s.symbol)}
        civilEnd={end}
        series={series}
        symbols={symbols}
        events={events}
        date={date}
        choose={choose}
        preview={inspect}
        forwardStart={selection.preset === 'custom' ? selection.start : undefined}
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
      {primaryAI && (
        <ModelOutlook forecast={primaryAI} quarterIndex={quarter} selectQuarter={focusQuarter} />
      )}
    </>
  )
}
function ArchivedForecast({ saved, selection }: { saved: ForecastSnapshot; selection: Selection }) {
  const [open, setOpen] = useState(false)
  const series = useMemo(() => [saved], [saved])
  return (
    <details className="future-archive" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Saved AI forecast · through {shortDay(saved.points.at(-1)?.date)}</summary>
      {open && (
        <>
          <p>
            Generated {new Date(saved.created).toLocaleString()} with {providerName(saved.provider)}{' '}
            · {saved.model}. Observed price from {shortDay(saved.as_of)}.
          </p>
          <ProjectionView series={series} snapshots={series} selection={selection} archived />
        </>
      )}
    </details>
  )
}
const quoteAnchor = (s: Forecast) =>
  s.anchor_kind === 'intraday' ? 'Observed quote' : 'Last close'

function ForecastResult({
  symbol,
  selection,
  connection,
  settings,
  controls,
  extras,
  changeExtras,
  revision,
  projections,
}: {
  symbol: string
  selection: Selection
  connection: Connection | null
  settings: () => void
  controls: React.ReactNode
  extras: string[]
  changeExtras: (symbols: string[]) => void
  revision: number
  projections: ReturnType<typeof useResource<Projections>>
}) {
  const {
    forecast: saved,
    generated,
    busy,
    loading,
    error,
    generate,
  } = useSavedForecast(snapshotPath(symbol, selection))
  const base = projections.data?.series.find((s) => s.symbol === symbol)
  const [records, setRecords] = useState<Record<string, ForecastSnapshot | null>>({})
  const remember = useCallback((ticker: string, snapshot: ForecastSnapshot | null) => {
    setRecords((prev) => (prev[ticker] === snapshot ? prev : { ...prev, [ticker]: snapshot }))
  }, [])
  const snapshots = useMemo(
    () =>
      (projections.data?.series || []).flatMap((s) => {
        const candidate = s.symbol === symbol ? saved : records[s.symbol]
        return matchesProjection(candidate, s) ? [candidate] : []
      }),
    [projections.data, symbol, saved, records],
  )
  const series = useMemo(
    () =>
      [symbol, ...extras].flatMap(
        (ticker) =>
          snapshots.find((v) => v.symbol === ticker) ||
          projections.data?.series.find((v) => v.symbol === ticker) ||
          [],
      ),
    [projections.data, symbol, extras, snapshots],
  )
  const ai = snapshots.find((s) => s.symbol === symbol)
  const line = ai || base,
    point = line?.points.at(-1),
    anchor = line?.points[0]
  const currency = line?.currency
  const priceSources = base?.price_sources?.length
    ? base.price_sources
    : base?.url
      ? [{ source: base.source, url: base.url }]
      : []
  const change = (price: number) =>
    anchor && anchor.median > 0 ? (price / anchor.median - 1) * 100 : null
  const delta = point ? change(point.median) : null
  const baselineError =
    projections.error ||
    projections.data?.errors.find((e) => e.symbol === symbol)?.error ||
    (!projections.loading && !base ? 'No projected sessions were available for this period.' : '')
  const lastRevision = useRef(revision),
    lastGenerated = useRef<string | null>(null)
  const reload = projections.reload
  useEffect(() => {
    if (lastRevision.current !== revision) {
      lastRevision.current = revision
      reload(true)
    }
  }, [revision, reload])
  useEffect(() => {
    if (!generated || generated.id === lastGenerated.current || projections.loading) return
    lastGenerated.current = generated.id
    if (!base || !matchesProjection(generated, base)) reload(true)
  }, [generated, base, reload, projections.loading])
  return (
    <>
      <div className="section-head">
        <div>
          <small>
            {label(selection.preset)} · {ai ? 'AI forecast' : 'Statistical projection'}
          </small>
          <div className="quote" aria-label="Projected median price">
            {point ? marketPrice(point.median, currency) : '—'}
          </div>
        </div>
        {delta != null && (
          <div className="period-change">
            <span className={'delta ' + (delta >= 0 ? 'up' : 'down')}>{pct(delta)}</span>
            <small>Projected change</small>
          </div>
        )}
      </div>
      {point && line && anchor && (
        <div className="future-estimate" aria-label="Projection values">
          <strong>
            Median for <time dateTime={point.date}>{shortDay(point.date)}</time>
            {currency && ' · ' + currency}
          </strong>
          <span>
            10th–90th percentile{' '}
            <b>
              {marketPrice(point.low, currency)} to {marketPrice(point.high, currency)}
            </b>{' '}
            ({pct(change(point.low))} to {pct(change(point.high))})
          </span>
          <span>
            {quoteAnchor(line)} {marketPrice(anchor.median, currency)} ·{' '}
            <time dateTime={line.anchor_time || line.as_of}>
              {line.anchor_kind === 'intraday' && line.anchor_time
                ? new Date(line.anchor_time).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: line.timezone,
                  }) +
                  ' ' +
                  line.timezone
                : shortDay(line.as_of)}
            </time>
            {priceSources.map((source) => (
              <span key={source.url || source.source}>
                {' '}
                ·{' '}
                {source.url ? (
                  <SourceLink url={source.url}>{source.source}</SourceLink>
                ) : (
                  source.source
                )}
              </span>
            ))}
          </span>
        </div>
      )}
      {controls}
      <div className="future-toolbar">
        <div className="future-generate">
          <button
            className="btn primary"
            onClick={generate}
            disabled={busy || !connection?.configured || (loading && !saved)}
          >
            <Sparkles size={14} />
            {busy
              ? 'Generating AI forecast…'
              : saved
                ? 'Update AI forecast'
                : 'Generate AI forecast'}
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
          baselines={projections.data?.series || []}
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
      {baselineError && (
        <div className="future-status">
          <ErrorBox text={baselineError} />
          <button className="text-btn" onClick={() => reload(true)}>
            Retry price projection
          </button>
        </div>
      )}
      {projections.loading && !base && (
        <p className="future-status" role="status">
          <Busy text={'Calculating the ' + label(selection.preset) + ' price projection'} />
        </p>
      )}
      {base && line && (
        <>
          {(base.data_note || base.stale) && (
            <p className="data-warning">
              {base.data_note ||
                'Using cached price observations from ' + shortDay(base.as_of) + '.'}
            </p>
          )}
          {ai ? (
            <small className="future-saved">
              Generated{' '}
              {new Date(ai.created).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}{' '}
              with {providerName(ai.provider)} · {ai.model}.
            </small>
          ) : (
            <small className="future-saved">
              Projected from observed prices and volatility. Generate an AI forecast to factor in
              published news and estimates.
            </small>
          )}
          <ProjectionView
            key={base.as_of}
            series={series}
            snapshots={snapshots}
            selection={selection}
          />
        </>
      )}
      {projections.data?.errors
        .filter((e) => e.symbol !== symbol)
        .map((e) => (
          <p className="data-warning" key={e.symbol}>
            {e.symbol} · {e.error}
          </p>
        ))}
      {saved && !ai && !projections.loading && (
        <ArchivedForecast saved={saved} selection={selection} />
      )}
    </>
  )
}
export function ResearchFuture({
  symbol,
  query,
  connection,
  settings,
  revision,
}: {
  symbol: string
  query: string
  connection: Connection | null
  settings: () => void
  revision: number
}) {
  const extras = useMemo(() => extraSymbols(symbol, query), [symbol, query])
  const selection = selectedFuture(query),
    [editing, edit] = useState(false)
  const projections = useResource<Projections>(projectionPath([symbol, ...extras], selection))
  const base = projections.data?.series.find((s) => s.symbol === symbol)
  const today = new Date()
  const localDay = new Date(today.getTime() - today.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10)
  const firstDay = after(
    base?.horizon_origin || base?.expected_session || base?.as_of || localDay,
    1,
  )
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
      revision={revision}
      projections={projections}
      controls={controls}
    />
  )
}
