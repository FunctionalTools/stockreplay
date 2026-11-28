import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react'
import { EventCard } from './ForecastEvents'
import { marketPrice } from './PricePlot'
import { shortDay } from './workspace'
import {
  dayTime,
  latestSharedClose,
  isLastPriceReference,
  predictedChange,
  predictedPrice,
  predictedPriceText,
  type MarketEvent,
  type Forecast,
} from './forecastData'

export const lineColors = [
  'var(--accent)',
  'var(--blue)',
  'var(--amber)',
  'var(--violet)',
  '#c4617b',
  '#348d94',
  '#8c8642',
  '#8c719d',
]
const L = 66,
  R = 16,
  T = 24
function markerLabel(event: MarketEvent) {
  if (event.kind === 'fiscal') return event.title.match(/\bQ[1-4]\b/i)?.[0].toUpperCase() || 'FY'
  if (event.kind === 'earnings') return 'EPS'
  if (event.kind === 'dividend') return 'Div'
  if (event.kind === 'macro')
    return /federal reserve|fomc|\bfed\b/i.test(event.title) ? 'Fed' : 'Econ'
  if (event.kind === 'regulatory') return 'Rule'
  if (event.kind === 'legislative') return 'Bill'
  return 'Co.'
}
function plotModel(
  series: Forecast[],
  events: MarketEvent[],
  symbols: string[],
  W: number,
  B: number,
  forwardStart?: string,
  civilEnd?: string,
) {
  const anchor = latestSharedClose(series)
  if (!anchor) return null
  const compare = series.length > 1
  const allDates = new Set<string>()
  const lines = series.map((s) => {
    const basis = s.history.find((p) => p.date === anchor)!.price
    const points = s.points
      .filter((p) => !forwardStart || p.date === s.as_of || p.date >= forwardStart)
      .map((p) => {
        const price = predictedPrice(p)
        return { date: p.date, price, value: compare ? (price / basis - 1) * 100 : price }
      })
    for (const p of points) allDates.add(p.date)
    return { s, basis, points, color: lineColors[symbols.indexOf(s.symbol)] }
  })
  const priceDays = [...allDates].sort()
  if (!priceDays.length) return null
  const first = priceDays[0],
    lastPrice = priceDays[priceDays.length - 1]
  const last = civilEnd && civilEnd > lastPrice ? civilEnd : lastPrice
  allDates.add(last)
  for (const e of events) if (e.date >= first && e.date <= last) allDates.add(e.date)
  const dates = [...allDates].sort()
  const low = Math.min(...lines.map((l) => Math.min(...l.points.map((p) => p.value))))
  const high = Math.max(...lines.map((l) => Math.max(...l.points.map((p) => p.value))))
  // A few cents of movement in a flat instrument should occupy only a small
  // part of the plot. Retain the observed scale when other prices move sharply.
  const minimumSpan = compare ? 0.5 : Math.abs(lines[0].basis) * 0.005
  const padding = Math.max((high - low) * 0.15, (minimumSpan - (high - low)) / 2, 1e-10)
  const bottom = compare ? low - padding : Math.max(0, low - padding),
    top = high + padding
  const start = dayTime(first),
    duration = Math.max(1, dayTime(last) - start)
  const x = (d: string) => L + ((W - L - R) * (dayTime(d) - start)) / duration
  const nearestDate = (px: number) => {
    let lo = 0,
      hi = dates.length - 1
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (x(dates[mid]) < px) lo = mid + 1
      else hi = mid
    }
    return dates[
      lo > 0 && Math.abs(x(dates[lo - 1]) - px) < Math.abs(x(dates[lo]) - px) ? lo - 1 : lo
    ]
  }
  const y = (v: number) => B - ((B - T) * (v - bottom)) / (top - bottom)
  const paths = lines.map((line) => ({
    ...line,
    path: line.points
      .map((p, i) => (i ? 'L' : 'M') + x(p.date).toFixed(2) + ',' + y(p.value).toFixed(2))
      .join(' '),
  }))
  const markers: { x: number; events: MarketEvent[] }[] = []
  for (const e of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    if (e.date < first || e.date > last) continue
    const pos = x(e.date),
      tail = markers[markers.length - 1]
    if (tail && pos - tail.x < (W < 500 ? 36 : 49)) tail.events.push(e)
    else markers.push({ x: pos, events: [e] })
  }
  return {
    dates,
    lines: paths,
    first,
    last,
    anchor,
    x,
    y,
    lastPrice,
    bottom,
    top,
    compare,
    markers,
    nearestDate,
  }
}
export function ForecastChart({
  series,
  symbols,
  events,
  date,
  choose,
  preview,
  compact = false,
  aiSymbols = [],
  forwardStart,
  civilEnd,
}: {
  series: Forecast[]
  symbols: string[]
  events: MarketEvent[]
  date: string
  choose: (d: string) => void
  preview: (event: MarketEvent) => void
  compact?: boolean
  aiSymbols?: string[]
  forwardStart?: string
  civilEnd?: string
}) {
  const host = useRef<HTMLDivElement>(null),
    [W, setWidth] = useState(920)
  const H = compact ? 211 : 266,
    B = compact ? 158 : 207
  const model = useMemo(
    () => plotModel(series, events, symbols, W, B, forwardStart, civilEnd),
    [series, events, symbols, W, B, forwardStart, civilEnd],
  )
  const available = !!model
  useEffect(() => {
    if (!host.current || !available) return
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(260, Math.round(entry.contentRect.width))),
    )
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [available])
  const [playing, play] = useState(false),
    [popup, setPopup] = useState<MarketEvent[] | null>(null),
    [popupIndex, setPopupIndex] = useState(0)
  const dates = model?.dates
  const firstOnOrAfter = dates?.findIndex((d) => d >= date) ?? -1
  const index = firstOnOrAfter < 0 ? Math.max(0, (dates?.length ?? 1) - 1) : firstOnOrAfter
  // A calendar event can fall between sessions. The next step should reach the
  // first subsequent trading date, even if the inspected date has no price.
  const nextIndex = dates && dates[index] > date ? index : index + 1
  useEffect(() => {
    if (!playing || !dates) return
    if (nextIndex >= dates.length) {
      play(false)
      return
    }
    const timer = window.setTimeout(() => choose(dates[nextIndex]), 280)
    return () => window.clearTimeout(timer)
  }, [playing, nextIndex, dates, choose])
  if (!model || !dates)
    return (
      <p className="data-warning">
        The selected tickers have no shared observed close. View one ticker at a time.
      </p>
    )
  const {
    lines,
    first,
    last,
    anchor,
    x,
    y,
    lastPrice,
    bottom,
    top,
    compare,
    markers,
    nearestDate,
  } = model
  const position = date >= first && date <= last ? date : dates[index]
  const openEvents = (items: MarketEvent[]) => {
    play(false)
    setPopup(items)
    setPopupIndex(0)
    preview(items[0])
  }
  const setDay = (d: string) => {
    play(false)
    choose(d)
  }
  const changeIndex = (v: number) => setDay(dates[Math.max(0, Math.min(dates.length - 1, v))])
  const tickPrecision = Math.min(
    10,
    Math.max(compare ? 1 : 2, Math.ceil(-Math.log10((top - bottom) / 4))),
  )
  const axis = (value: number) => {
    const rounded = Number(value.toFixed(tickPrecision)) || 0
    return (
      rounded.toLocaleString(undefined, { maximumFractionDigits: tickPrecision }) +
      (compare ? '%' : '')
    )
  }
  const hasIntraday = series.some((s) => s.anchor_kind === 'intraday')
  const sharedQuote = series.some((s) => s.anchor_kind === 'intraday' && s.as_of === anchor)
  const inspected = series[0]
  const reference = isLastPriceReference(inspected)
  const allReferences = series.every(isLastPriceReference)
  const mixed = !allReferences && series.some(isLastPriceReference)
  const priceLabel = allReferences ? 'Reference price' : mixed ? 'Price' : 'Predicted price'
  const changeLabel = allReferences ? 'Reference change' : mixed ? 'Change' : 'Predicted change'
  const firstPoint = inspected.points[0],
    endPoint = inspected.points.at(-1)!
  const observed = inspected.history.find((p) => p.date === position)
  const projected =
    position > inspected.as_of ? inspected.points.find((p) => p.date === position) : undefined
  return (
    <div
      ref={host}
      className={
        compact ? 'forecast-chart fc-inline' + (compare ? ' fc-compare' : '') : 'forecast-chart'
      }
    >
      <div className="forecast-chart-heading">
        <div>
          {compact && compare && (
            <div className="future-chart-key">
              {lines.map((l) => (
                <span key={l.s.symbol}>
                  <i style={{ background: l.color }} />
                  {l.s.symbol} ·{' '}
                  {isLastPriceReference(l.s)
                    ? 'last-price reference'
                    : aiSymbols.includes(l.s.symbol)
                      ? 'AI'
                      : 'price model'}
                </span>
              ))}
            </div>
          )}
          <h2>
            {compare
              ? allReferences
                ? 'Last-price references'
                : mixed
                  ? 'Price changes'
                  : 'Projected returns'
              : reference
                ? 'Last-price reference'
                : 'Price projection'}
          </h2>
          <small>
            {compare
              ? (sharedQuote
                  ? 'Return from the shared observation on '
                  : 'Return from the shared close on ') + shortDay(anchor)
              : series[0].symbol +
                ' · ' +
                (series[0].currency || 'quote currency unavailable') +
                (series[0].anchor_kind === 'intraday' ? ' · Observed quote ' : ' · Last close ') +
                shortDay(series[0].as_of)}
          </small>
        </div>
      </div>
      <div
        className="forecast-stage"
        onKeyDown={(e) => {
          if (e.key === 'Escape') setPopup(null)
        }}
      >
        <div className="forecast-plot">
          <svg
            viewBox={'0 0 ' + W + ' ' + H}
            role="img"
            aria-label={
              series.map((s) => s.symbol).join(' and ') +
              (allReferences
                ? ' last-price reference'
                : mixed
                  ? ' price comparison'
                  : ' price prediction') +
              ' by trading session'
            }
          >
            {[0, 1, 2, 3, 4].map((i) => {
              const value = bottom + ((top - bottom) * i) / 4
              return (
                <g key={i}>
                  <line x1={L} x2={W - R} y1={y(value)} y2={y(value)} className="fc-grid" />
                  <text data-axis-value={value} x={L - 8} y={y(value) + 4} textAnchor="end">
                    {axis(value)}
                  </text>
                </g>
              )
            })}
            {lines.map((l) => (
              <g
                key={l.s.symbol}
                stroke={l.color}
                fill="none"
                data-symbol={l.s.symbol}
                data-forecast-model={
                  isLastPriceReference(l.s)
                    ? 'reference'
                    : aiSymbols.includes(l.s.symbol)
                      ? 'ai'
                      : 'statistical'
                }
              >
                <path
                  data-line="prediction"
                  d={l.path}
                  strokeWidth="2.65"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle
                  data-observed-anchor={l.s.as_of}
                  cx={x(l.points[0].date)}
                  cy={y(l.points[0].value)}
                  r="3"
                  fill="var(--panel)"
                  strokeWidth="2"
                />
                <circle
                  data-forecast-end={l.points.at(-1)!.date}
                  data-price={l.points.at(-1)!.price}
                  cx={x(l.points.at(-1)!.date)}
                  cy={y(l.points.at(-1)!.value)}
                  r="3.5"
                  fill={l.color}
                />
              </g>
            ))}
            <text x={L} y="15">
              {compare
                ? 'Observed'
                : (hasIntraday ? 'Quote ' : 'Close ') +
                  marketPrice(predictedPrice(firstPoint), inspected.currency)}
            </text>
            <text x={W - R} y="15" textAnchor="end">
              {compare
                ? changeLabel
                : (reference ? 'Reference ' : 'Prediction ') +
                  predictedPriceText(
                    predictedPrice(endPoint),
                    inspected.currency,
                    predictedPrice(firstPoint),
                  )}
            </text>
            <line
              x1={x(position)}
              x2={x(position)}
              y1={T}
              y2={B + 3}
              stroke="var(--text)"
              opacity=".65"
            />
            <text x={L} y={H - 4}>
              {shortDay(first)}
            </text>
            <text x={x(lastPrice)} y={H - 4} textAnchor="end">
              {shortDay(lastPrice)}
            </text>
            <rect
              x={L}
              y={T}
              width={W - R - L}
              height={B - T}
              fill="transparent"
              onPointerDown={() => setPopup(null)}
              onPointerMove={(e) => {
                if (playing || e.pointerType === 'touch') return
                const svg = e.currentTarget.ownerSVGElement!
                const point = svg.createSVGPoint()
                point.x = e.clientX
                point.y = e.clientY
                const matrix = svg.getScreenCTM()
                if (!matrix) return
                const px = point.matrixTransform(matrix.inverse()).x
                choose(nearestDate(px))
              }}
            />
          </svg>
          {markers.map((m) => (
            <button
              key={m.events[0].id}
              className="forecast-marker"
              style={{ left: (Math.min(W - 24, m.x) / W) * 100 + '%' }}
              data-kind={m.events[0].kind}
              title={m.events.map((e) => e.title).join(' · ')}
              aria-label={
                m.events.length === 1
                  ? m.events[0].title
                  : m.events.length + ' events from ' + shortDay(m.events[0].date)
              }
              onMouseEnter={() => openEvents(m.events)}
              onFocus={() => openEvents(m.events)}
              onClick={() => {
                setDay(m.events[0].date)
                openEvents(m.events)
              }}
            >
              {markerLabel(m.events[0])}
              {m.events.length > 1 && <sup>+{m.events.length - 1}</sup>}
            </button>
          ))}
        </div>
        {popup && (
          <div
            className="fc-popup"
            data-position={W < 540 ? 'below' : x(popup[0].date) < W / 2 ? 'right' : 'left'}
            role="region"
            aria-label="Timeline event preview"
          >
            <button
              className="icon-btn fc-popup-close"
              aria-label="Close event preview"
              onClick={() => setPopup(null)}
            >
              <X size={14} />
            </button>
            <EventCard event={popup[popupIndex]} compact />
            {popup.length > 1 && (
              <div className="fc-pager">
                <button
                  className="text-btn"
                  disabled={popupIndex === 0}
                  onClick={() => {
                    setPopupIndex(popupIndex - 1)
                    choose(popup[popupIndex - 1].date)
                    preview(popup[popupIndex - 1])
                  }}
                >
                  Previous
                </button>
                <small>
                  {popupIndex + 1} of {popup.length}
                </small>
                <button
                  className="text-btn"
                  disabled={popupIndex === popup.length - 1}
                  onClick={() => {
                    setPopupIndex(popupIndex + 1)
                    choose(popup[popupIndex + 1].date)
                    preview(popup[popupIndex + 1])
                  }}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="forecast-playback">
        <button
          className="icon-btn"
          aria-label={playing ? 'Pause timeline' : 'Play timeline'}
          onClick={() => {
            if (!playing && nextIndex >= dates.length) choose(anchor)
            play(!playing)
          }}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          className="icon-btn"
          aria-label="Previous timeline date"
          disabled={!index}
          onClick={() => changeIndex(index - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <input
          aria-label="Inspect timeline date"
          aria-valuetext={shortDay(position)}
          type="range"
          min="0"
          max={10000}
          value={Math.round((10000 * (x(position) - L)) / (W - R - L))}
          onChange={(e) => setDay(nearestDate(L + ((W - R - L) * Number(e.target.value)) / 10000))}
          onKeyDown={(e) => {
            const steps: Record<string, number> = {
              ArrowLeft: index - 1,
              ArrowDown: index - 1,
              ArrowRight: nextIndex,
              ArrowUp: nextIndex,
              Home: 0,
              End: dates.length - 1,
            }
            if (Object.hasOwn(steps, e.key)) {
              e.preventDefault()
              changeIndex(steps[e.key])
            }
          }}
        />
        <button
          className="icon-btn"
          aria-label="Next timeline date"
          disabled={nextIndex >= dates.length}
          onClick={() => changeIndex(nextIndex)}
        >
          <ChevronRight size={16} />
        </button>
        <output>{shortDay(position)}</output>
      </div>
      {compact && !compare ? (
        <div className="future-inspected">
          <strong>{series[0].symbol}</strong>
          {projected ? (
            <span>
              {reference ? 'Reference' : 'Predicted'}{' '}
              {predictedPriceText(
                predictedPrice(projected),
                inspected.currency,
                predictedPrice(firstPoint),
              )}{' '}
              · {predictedChange(predictedPrice(projected), predictedPrice(firstPoint))}
            </span>
          ) : observed ? (
            <span>
              {inspected.anchor_kind === 'intraday' && position === inspected.as_of
                ? 'Observed quote'
                : 'Observed close'}{' '}
              {marketPrice(observed.price, inspected.currency)}
            </span>
          ) : (
            <span>No trading session on this date</span>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="forecast-values" aria-label="Prices on inspected date">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>{hasIntraday ? 'Observed price' : 'Observed close'}</th>
                <th>{priceLabel}</th>
                <th>{changeLabel}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ s, color, basis }) => {
                const actual = s.history.find((p) => p.date === position),
                  point = position > s.as_of ? s.points.find((p) => p.date === position) : undefined
                return (
                  <tr key={s.symbol}>
                    <th>
                      <i style={{ background: color }} />
                      {s.symbol}{' '}
                      <small>
                        {s.currency}
                        {isLastPriceReference(s) && ' · last-price reference'}
                      </small>
                    </th>
                    <td>{actual ? marketPrice(actual.price, s.currency) : '—'}</td>
                    <td>
                      {point ? predictedPriceText(predictedPrice(point), s.currency, basis) : '—'}
                    </td>
                    <td>{point ? predictedChange(predictedPrice(point), basis) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
