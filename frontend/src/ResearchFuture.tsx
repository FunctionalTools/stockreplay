import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Sparkles } from 'lucide-react'
import { ForecastChart } from './ForecastChart'
import { EventCard } from './ForecastEvents'
import { marketPrice } from './PricePlot'
import { PredictionDetails } from './PredictionDetails'
import { useResource, SourceLink } from './deskCommon'
import { Busy, ErrorBox } from './ui'
import { shortDay, type Connection } from './workspace'
import { rangeLabel, rangePresets, validDay, type Selection } from './priceRanges'
import {
  futureHref,
  selectedFuture,
  snapshotPath,
  matchesProjection,
  matchesActiveForecast,
  projectionPath,
  providerName,
  quarterMarkers,
  combinedForecastEvents,
  type ForecastSnapshot,
  type ForecastSource,
} from './forecastSnapshot'
import {
  dayTime,
  isLastPriceReference,
  predictedPrice,
  predictedChange,
  predictedPriceText,
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
      <h3>
        {f.symbol} {isLastPriceReference(f) ? 'research outlook' : 'forecast outlook'}
      </h3>
      <p>
        {f.summary.replace(
          /^The model’s central path ends (?:above|below|close to) the historical baseline\.\s*/,
          '',
        )}
      </p>
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
        <summary>Drivers and sources</summary>
        {f.drivers.map((d, i) => (
          <div key={i}>
            <h4>
              {d.title} <small>· {d.direction}</small>
            </h4>
            <p>{d.reason}</p>
            <Citations ids={d.source_ids} sources={f.sources} />
          </div>
        ))}

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
  const events = useMemo(
    () =>
      combinedForecastEvents(snapshots, [
        ...(early.data?.events || []),
        ...(later.data?.events || []),
      ]),
    [snapshots, early.data, later.data],
  )
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
      <PredictionDetails series={series} snapshots={snapshots} />
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
      <summary>
        {isLastPriceReference(saved)
          ? 'Saved AI research · last-price reference'
          : 'Saved AI forecast'}{' '}
        · through {shortDay(saved.points.at(-1)?.date)}
      </summary>
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
  onPredictionScores,
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
  onPredictionScores?: (value: ForecastSnapshot | null) => void
  projections: ReturnType<typeof useResource<Projections>>
}) {
  const base = projections.data?.series.find((s) => s.symbol === symbol)
  const {
    forecast: saved,
    generated,
    busy,
    loading,
    error,
    generate,
    automaticError,
    canGenerate,
    eligible,
  } = useSavedForecast(snapshotPath(symbol, selection), { connection, base, automatic: true })
  const [records, setRecords] = useState<
    Record<string, { snapshot: ForecastSnapshot | null; confirmed: boolean }>
  >({})
  const remember = useCallback(
    (ticker: string, snapshot: ForecastSnapshot | null, confirmed: boolean) => {
      setRecords((prev) =>
        prev[ticker]?.snapshot === snapshot && prev[ticker]?.confirmed === confirmed
          ? prev
          : { ...prev, [ticker]: { snapshot, confirmed } },
      )
    },
    [],
  )
  const snapshots = useMemo(
    () =>
      (projections.data?.series || []).flatMap((s) => {
        const record = records[s.symbol]
        const candidate = s.symbol === symbol ? saved : record?.snapshot
        const confirmed =
          s.symbol === symbol ? !!generated && generated.id === saved?.id : record?.confirmed
        return matchesActiveForecast(candidate, s, connection, confirmed) ? [candidate] : []
      }),
    [projections.data, symbol, saved, generated, records, connection],
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
  useEffect(() => onPredictionScores?.(ai?.scores ? ai : null), [ai, onPredictionScores])
  const line = ai || base,
    point = line?.points.at(-1),
    anchor = line?.points[0]
  const reference = isLastPriceReference(line)
  const needsVerification = canGenerate && !eligible
  const currency = line?.currency
  const priceSources = base?.price_sources?.length
    ? base.price_sources
    : base?.url
      ? [{ source: base.source, url: base.url }]
      : []
  const delta =
    point && anchor ? predictedChange(predictedPrice(point), predictedPrice(anchor)) : null
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
            {label(selection.preset)} ·{' '}
            {reference ? 'Last-price reference' : ai ? 'AI prediction' : 'Price model prediction'}
          </small>
          <div className="quote" aria-label={reference ? 'Reference price' : 'Predicted price'}>
            {point && anchor
              ? predictedPriceText(predictedPrice(point), currency, predictedPrice(anchor))
              : '—'}
          </div>
        </div>
        {point && anchor && delta != null && (
          <div className="period-change">
            <span
              className={
                'delta ' + (predictedPrice(point) >= predictedPrice(anchor) ? 'up' : 'down')
              }
            >
              {delta}
            </span>
            <small>{reference ? 'Reference change' : 'Predicted change'}</small>
          </div>
        )}
      </div>
      {controls}
      <div className="future-toolbar">
        <div className="future-generate">
          <button
            className="btn primary"
            onClick={canGenerate ? generate : settings}
            disabled={busy || (canGenerate && loading && !saved)}
          >
            <Sparkles size={14} />
            {busy
              ? 'Generating AI forecast…'
              : automaticError || !eligible
                ? 'Generate now'
                : saved
                  ? 'Update AI forecast'
                  : 'Generate AI forecast'}
          </button>
          <small>
            {connection?.configured
              ? providerName(connection.provider) + ' · ' + connection.model
              : 'Set up a model in Settings'}
          </small>
        </div>
        <ForecastComparison
          primary={symbol}
          extras={extras}
          selection={selection}
          change={changeExtras}
          connection={connection}
          baselines={projections.data?.series || []}
          remember={remember}
        />
      </div>
      {point && line && anchor && (
        <div className="future-estimate" aria-label="Projection values">
          <strong>
            {reference ? 'Reference for ' : 'Predicted for '}
            <time dateTime={point.date}>{shortDay(point.date)}</time>
            {currency && ' · ' + currency}
          </strong>
          <span>
            {quoteAnchor(line)} {marketPrice(predictedPrice(anchor), currency)} ·{' '}
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
      {automaticError && (
        <p className="future-status" role="status">
          {automaticError}{' '}
          <button className="text-btn" onClick={settings}>
            AI settings
          </button>
        </p>
      )}
      {needsVerification && !automaticError && (
        <p className="future-status">
          {connection?.generation_detail ||
            'Verify your model to generate predictions automatically.'}{' '}
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
          {(reference || !ai) && (
            <small className="future-saved">
              {reference
                ? line.model_inputs?.reference_reason ||
                  'The last observed price is carried forward for this period.'
                : 'Based on ' + symbol + '’s observed prices.'}
            </small>
          )}
          {ai && (
            <small className="future-saved">
              {reference ? 'AI research generated' : 'Generated'}{' '}
              {new Date(ai.created).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}{' '}
              with {providerName(ai.provider)} · {ai.model}.
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
  changeChart,
  connection,
  settings,
  revision,
  onPredictionScores,
}: {
  symbol: string
  query: string
  changeChart: (href: string) => void
  connection: Connection | null
  settings: () => void
  revision: number
  onPredictionScores?: (value: ForecastSnapshot | null) => void
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
    changeChart(futureHref(symbol, preset, a, b, extras))
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
        changeChart(futureHref(symbol, selection.preset, selection.start, selection.end, next))
      }}
      connection={connection}
      settings={settings}
      revision={revision}
      onPredictionScores={onPredictionScores}
      projections={projections}
      controls={controls}
    />
  )
}
