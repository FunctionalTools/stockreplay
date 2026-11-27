import { useEffect, useRef, useState } from 'react'
import { useResource, type Packet } from './deskCommon'
import { PricePlot, marketPrice, type Prices } from './PricePlot'
import { shortDay, type Intent } from './workspace'
import { Busy, ErrorBox } from './ui'
import { pct } from './types'
import './researchRange.css'

export const rangePresets = [
  '1d',
  '5d',
  '1mo',
  '3mo',
  '6mo',
  'ytd',
  '1y',
  '2y',
  '5y',
  '10y',
  'max',
  'custom',
] as const
export const rangeLabel = (preset: string) =>
  preset === 'custom'
    ? 'Custom'
    : preset === 'max'
      ? 'Max'
      : preset.replace('mo', 'm').toUpperCase()
export const rangePath = (symbol: string, preset: string, start?: string, end?: string) => {
  const params = new URLSearchParams({ range: preset })
  if (preset === 'custom') {
    params.set('start', start || '')
    params.set('end', end || '')
  }
  return '/desk/range/' + encodeURIComponent(symbol) + '?' + params.toString()
}
type Selection = { preset: string; start?: string; end?: string }
function validDay(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const millis = Date.parse(s + 'T00:00:00Z')
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === s
}
function fromFocus(focus: string): Selection | null {
  const [prefix, preset, start, end, ...rest] = focus.split('_')
  if (prefix !== 'range' || !rangePresets.some((v) => v === preset) || rest.length) return null
  if (preset !== 'custom') return start === undefined ? { preset } : null
  return validDay(start || '') && validDay(end || '') && start <= end
    ? { preset, start, end }
    : null
}
export const validRangeFocus = (focus: string) => !!fromFocus(focus)
type Observation = { date: string; time: number; price: number }
export type RangePrices = Prices & {
  interval: '5m' | '1d'
  timezone: string
  range: string
  price_basis: 'nominal' | 'adjusted'
  requested_start: string | null
  requested_end: string
  performance: {
    start: Observation | null
    end: Observation | null
    percent: number | null
    basis: 'first_observation' | 'prior_year_close' | 'previous_close'
    description: string
  }
}
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
}: {
  symbol: string
  intent: Intent
  revision: number
}) {
  const [selection, select] = useState<Selection>(() => fromFocus(intent.kind) || { preset: '6mo' })
  const [editing, setEditing] = useState(false)
  const [start, setStart] = useState(selection.start || ''),
    [end, setEnd] = useState(selection.end || '')
  const card = useRef<HTMLElement>(null)
  const prevRevision = useRef(revision)
  const p = useResource<Packet<RangePrices>>(
    rangePath(symbol, selection.preset, selection.start, selection.end),
  )
  const reload = p.reload
  useEffect(() => {
    if (revision !== prevRevision.current) {
      prevRevision.current = revision
      reload(true)
    }
  }, [revision, reload])
  useEffect(() => {
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
    window.location.hash = '#/research/' + encodeURIComponent(symbol) + '/' + focus
  }
  const data = p.data?.data,
    perf = data?.performance,
    lastPrice = data?.bars.at(-1)?.raw_close
  const customDateError = Boolean(start && end && end < start)
  return (
    <section className="panel quote-card research-range" aria-label="Price history" ref={card}>
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
      </small>
      <div className="range range-options" role="group" aria-label="Chart period">
        {rangePresets.map((value) => (
          <button
            key={value}
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
            <input type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
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
    </section>
  )
}
