import { useEffect, useRef, useState } from 'react'
import { useResource, type Packet } from './deskCommon'
import { PricePlot, marketPrice } from './PricePlot'
import {
  fromFocus,
  rangeLabel,
  rangePath,
  rangePresets,
  validDay,
  type RangePrices,
  type Observation,
  type Selection,
} from './priceRanges'
import { shortDay, type Intent, type Connection } from './workspace'
import { ResearchFuture, futureHref } from './ResearchFuture'
import type { ForecastSnapshot } from './forecastSnapshot'
import { Busy, ErrorBox } from './ui'
import { pct } from './types'
import './researchRange.css'

function at(point: Observation, data: RangePrices, intraday: boolean) {
  return (
    shortDay(point.date) +
    (intraday
      ? ' · ' +
        new Date(point.time * 1000).toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: data.timezone,
          timeZoneName: 'short',
        })
      : '')
  )
}
export function ResearchRange({
  symbol,
  intent,
  revision,
  query,
  changeChart,
  connection,
  settings,
  onPredictionScores,
}: {
  symbol: string
  intent: Intent
  revision: number
  query: string
  changeChart: (href: string) => void
  connection: Connection | null
  settings: () => void
  onPredictionScores?: (value: ForecastSnapshot | null) => void
}) {
  const view = new URLSearchParams(query).get('view')
  const future = view === 'future' || intent.kind === 'future' || (!intent.kind && view !== 'past')
  useEffect(() => {
    if (!future) onPredictionScores?.(null)
  }, [future, onPredictionScores])
  const [selection, select] = useState<Selection>(() => fromFocus(intent.kind) || { preset: '6mo' })
  const [editing, setEditing] = useState(false)
  const [start, setStart] = useState(selection.start || ''),
    [end, setEnd] = useState(selection.end || '')
  const card = useRef<HTMLElement>(null)
  const prevRevision = useRef(revision)
  const p = useResource<Packet<RangePrices>>(
    future ? null : rangePath(symbol, selection.preset, selection.start, selection.end),
  )
  const reload = p.reload
  useEffect(() => {
    if (revision !== prevRevision.current) {
      prevRevision.current = revision
      reload(true)
    }
  }, [revision, reload])
  useEffect(() => {
    if (intent.kind === 'future') card.current?.scrollIntoView({ block: 'nearest' })
    const next = fromFocus(intent.kind)
    if (next) {
      select(next)
      setEditing(false)
      setStart(next.start || '')
      setEnd(next.end || '')
      card.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [intent.kind, intent.seq])
  function chooseRange(next: Selection) {
    select(next)
    const focus = ['range', next.preset, next.start, next.end].filter(Boolean).join('_')
    changeChart('#/research/' + encodeURIComponent(symbol) + '/' + focus)
  }
  const data = p.data?.data,
    perf = data?.performance,
    lastPrice = data?.bars.at(-1)?.raw_close
  const customDateError = Boolean(start && end && end < start)
  return (
    <section
      className="panel quote-card research-range"
      aria-label={future ? 'Price forecast' : 'Price history'}
      ref={card}
    >
      <div className="chart-mode-row">
        <div className="chart-modes" role="group" aria-label="Price chart view">
          <button
            type="button"
            aria-pressed={!future}
            onClick={() => {
              if (future) chooseRange(selection)
            }}
          >
            Past
          </button>
          <button
            type="button"
            aria-pressed={future}
            onClick={() => {
              if (!future)
                changeChart(
                  futureHref(symbol, selection.preset === 'custom' ? '6mo' : selection.preset),
                )
            }}
          >
            Future
          </button>
        </div>
      </div>
      {future ? (
        <ResearchFuture
          onPredictionScores={onPredictionScores}
          symbol={symbol}
          query={query}
          changeChart={changeChart}
          connection={connection}
          settings={settings}
          revision={revision}
        />
      ) : (
        <>
          <div className="section-head">
            <div>
              <small>
                {data?.interval === '5m' ? 'Latest price in range' : 'Closing price at range end'}
              </small>
              <div className="quote">{marketPrice(lastPrice, data?.currency)}</div>
            </div>
            {perf?.percent != null && (
              <div className="period-change">
                <span className={'delta ' + (perf.percent >= 0 ? 'up' : 'down')}>
                  {pct(perf.percent)}
                </span>
                <small>{rangeLabel(selection.preset)} change</small>
              </div>
            )}
          </div>
          <small className="range-as-of">
            {data && perf?.end
              ? at(perf.end, data, data.interval === '5m') +
                (data.currency ? ' · ' + data.currency : '')
              : 'Price history'}
            {p.data?.stale && ' · Cached prices'}
          </small>
          <div className="range range-options" role="group" aria-label="Chart period">
            {rangePresets.map((value) => (
              <button
                key={value}
                title={
                  value === '5d'
                    ? 'Five observed trading sessions with intraday prices'
                    : value === '1w'
                      ? 'One calendar week of daily closes'
                      : undefined
                }
                type="button"
                aria-pressed={(editing ? 'custom' : selection.preset) === value}
                className={(editing ? 'custom' : selection.preset) === value ? 'selected' : ''}
                onClick={() => {
                  if (value === 'custom') {
                    setEditing(true)
                    setStart(selection.start || data?.bars[0]?.date || '')
                    setEnd(selection.end || data?.as_of || '')
                  } else {
                    setEditing(false)
                    chooseRange({ preset: value })
                  }
                }}
              >
                {rangeLabel(value)}
              </button>
            ))}
          </div>
          {editing && (
            <form
              className="range-dates"
              onSubmit={(e) => {
                e.preventDefault()
                if (!customDateError && validDay(start) && validDay(end)) {
                  chooseRange({ preset: 'custom', start, end })
                  setEditing(false)
                }
              }}
            >
              <label>
                Start date
                <input
                  type="date"
                  required
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </label>
              <label>
                End date
                <input
                  type="date"
                  required
                  value={end}
                  min={start}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </label>
              <button className="btn" disabled={customDateError || !start || !end}>
                Apply dates
              </button>
              {customDateError && (
                <small role="status">Choose an end date on or after the start.</small>
              )}
            </form>
          )}
          {!editing && selection.preset === 'custom' && (
            <small className="range-window">
              {shortDay(selection.start)} – {shortDay(selection.end)} · inclusive
            </small>
          )}
          {p.loading ? (
            <div className="plot-wait">
              <Busy text="Reading price history" />
            </div>
          ) : (
            data && <PricePlot series={[data]} />
          )}
          <ErrorBox text={p.error || p.data?.error || ''} />
          {data && perf && (
            <div className="range-performance" aria-label="Period performance">
              <dl>
                {(
                  [
                    ['start', perf.start],
                    ['end', perf.end],
                  ] as const
                ).map(([side, point]) => (
                  <div key={side}>
                    <dt>
                      {side === 'end'
                        ? 'End'
                        : perf.basis === 'previous_close'
                          ? 'Previous close'
                          : perf.basis === 'prior_year_close'
                            ? 'Prior year close'
                            : 'Start'}
                    </dt>
                    <dd>
                      {marketPrice(point?.price, data.currency)}
                      {point && (
                        <small>
                          {at(
                            point,
                            data,
                            data.interval === '5m' &&
                              (side === 'end' || perf.basis === 'first_observation'),
                          )}
                        </small>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              <p>{perf.description}</p>
            </div>
          )}
        </>
      )}
    </section>
  )
}
