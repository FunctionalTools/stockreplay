import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react'
import { EventCard } from './ForecastEvents'
import { marketPrice } from './PricePlot'
import { shortDay } from './workspace'
import { dayTime, latestSharedClose, type MarketEvent, type Forecast } from './forecastCalendar'

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
const H = 266,
  L = 66,
  R = 16,
  T = 24,
  B = 207
type Mark = { date: string; value: number }
function plotModel(series: Forecast[], events: MarketEvent[], symbols: string[], W: number) {
  const anchor = latestSharedClose(series)
  if (!anchor) return null
  const compare = series.length > 1
  const allDates = new Set<string>(),
    lines = series.map((s) => {
      const basis = s.history.find((p) => p.date === anchor)!.price
      const transform = (v: number) => (compare ? (v / basis - 1) * 100 : v)
      const history = s.history.map((p) => ({ date: p.date, value: transform(p.price) }))
      const points = s.points.map((p) => ({
        date: p.date,
        low: transform(p.low),
        value: transform(p.median),
        high: transform(p.high),
      }))
      for (const p of [...history, ...points]) allDates.add(p.date)
      return { s, history, points, basis, color: lineColors[symbols.indexOf(s.symbol)] }
    })
  const priceDays = [...allDates].sort()
  const first = priceDays[0],
    last = priceDays[priceDays.length - 1]
  for (const e of events) if (e.date >= first && e.date <= last) allDates.add(e.date)
  const dates = [...allDates].sort()
  const low = Math.min(
    ...lines.map((l) => Math.min(...l.history.map((p) => p.value), ...l.points.map((p) => p.low))),
  )
  const high = Math.max(
    ...lines.map((l) => Math.max(...l.history.map((p) => p.value), ...l.points.map((p) => p.high))),
  )
  const padding = (high - low) * 0.09 || Math.max(Math.abs(low) * 0.005, 0.001)
  const bottom = low - padding,
    top = high + padding
  const split = L + (W - L - R) * 0.31,
    start = dayTime(first),
    end = dayTime(last),
    base = dayTime(anchor)
  const x = (d: string) =>
    d <= anchor
      ? L + ((split - L) * (dayTime(d) - start)) / Math.max(base - start, 1)
      : split + ((W - R - split) * (dayTime(d) - base)) / Math.max(end - base, 1)
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
  const path = (marks: Mark[]) =>
    marks
      .map((p, i) => (i ? 'L' : 'M') + x(p.date).toFixed(2) + ',' + y(p.value).toFixed(2))
      .join(' ')
  const paths = lines.map((line) => {
    const lows = line.points.map((p) => ({ ...p, value: p.low })),
      highs = line.points.map((p) => ({ ...p, value: p.high }))
    return {
      ...line,
      historical: path(line.history),
      median: path(line.points),
      low: path(lows),
      high: path(highs),
      band: path([...highs, ...lows.reverse()]) + ' Z',
    }
  })
  const markers: { x: number; events: MarketEvent[] }[] = []
  for (const e of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    if (e.date < first || e.date > last) continue
    const pos = x(e.date),
      tail = markers[markers.length - 1]
    if (tail && pos - tail.x < 24) tail.events.push(e)
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
    split,
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
}: {
  series: Forecast[]
  symbols: string[]
  events: MarketEvent[]
  date: string
  choose: (d: string) => void
  preview: (event: MarketEvent) => void
}) {
  const host = useRef<HTMLDivElement>(null),
    [W, setWidth] = useState(920)
  const model = useMemo(() => plotModel(series, events, symbols, W), [series, events, symbols, W])
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
  const { lines, first, last, anchor, x, y, split, bottom, top, compare, markers, nearestDate } =
    model
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
  const axis = (v: number) =>
    compare
      ? v.toFixed(1) + '%'
      : new Intl.NumberFormat(undefined, {
          notation: Math.abs(v) >= 10000 ? 'compact' : 'standard',
          maximumFractionDigits: Math.abs(v) < 1 ? 4 : 2,
        }).format(v)
  return (
    <div ref={host} className="forecast-chart">
      <div className="forecast-chart-heading">
        <div>
          <h2>{compare ? 'Projected returns' : 'Price projection'}</h2>
          <small>
            {compare
              ? 'Return from the shared close on ' + shortDay(anchor)
              : series[0].symbol +
                ' · ' +
                (series[0].currency || 'quote currency unavailable') +
                ' · Last close ' +
                shortDay(series[0].as_of)}
          </small>
        </div>
        <div className="forecast-key">
          <span>
            <i />
            Observed close
          </span>
          <span>
            <i />
            Median forecast
          </span>
          <span>
            <i />
            10th–90th percentile
          </span>
        </div>
      </div>
      <div
        className="forecast-plot"
        onKeyDown={(e) => {
          if (e.key === 'Escape') setPopup(null)
        }}
      >
        <svg
          viewBox={'0 0 ' + W + ' ' + H}
          role="img"
          aria-label={
            series.map((s) => s.symbol).join(' and ') +
            ' observed history, median forecast, upper and lower simulated prices'
          }
        >
          <rect
            x={split}
            y={T}
            width={W - R - split}
            height={B - T}
            fill="var(--soft)"
            opacity=".55"
          />
          {[0, 1, 2, 3, 4].map((i) => {
            const value = bottom + ((top - bottom) * i) / 4
            return (
              <g key={i}>
                <line x1={L} x2={W - R} y1={y(value)} y2={y(value)} className="fc-grid" />
                <text x={L - 8} y={y(value) + 4} textAnchor="end">
                  {axis(value)}
                </text>
              </g>
            )
          })}
          {lines.map((l) => (
            <g key={l.s.symbol} stroke={l.color} fill="none" data-symbol={l.s.symbol}>
              <path d={l.band} fill={l.color} fillOpacity=".10" stroke="none" />
              <path data-line="lower" d={l.low} opacity=".65" strokeWidth="1" />
              <path data-line="upper" d={l.high} opacity=".65" strokeWidth="1" />
              <path data-line="actual" d={l.historical} strokeWidth="2" />
              <path data-line="median" d={l.median} strokeDasharray="5 4" strokeWidth="2.4" />
            </g>
          ))}
          <line x1={split} x2={split} y1={T} y2={B} stroke="var(--muted)" strokeDasharray="2 4" />
          <text x={L} y="15">
            {W < 570 ? 'History' : 'Observed history'}
          </text>
          <text x={split + 7} y="15">
            Forecast
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
          {W > 570 && (
            <text x={split} y={H - 4} textAnchor="middle">
              {shortDay(anchor)}
            </text>
          )}
          <text x={W - R} y={H - 4} textAnchor="end">
            {shortDay(last)}
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
            style={{ left: (m.x / W) * 100 + '%' }}
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
            {m.events.length > 1 ? m.events.length : '•'}
          </button>
        ))}
        {popup && (
          <div className="fc-popup" role="region" aria-label="Timeline event preview">
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
      <small className="fc-time-note">History and forecast use separate time scales.</small>
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
      <div className="table-wrap">
        <table className="forecast-values" aria-label="Prices on inspected date">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Observed close</th>
              <th>Median forecast</th>
              <th>10th–90th percentile</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(({ s, color, basis }) => {
              const actual = s.history.find((p) => p.date === position),
                point = position > s.as_of ? s.points.find((p) => p.date === position) : undefined
              const display = (v: number) =>
                marketPrice(v, s.currency) +
                (compare
                  ? ' (' +
                    new Intl.NumberFormat(undefined, {
                      style: 'percent',
                      signDisplay: 'exceptZero',
                      maximumFractionDigits: 2,
                    }).format(v / basis - 1) +
                    ')'
                  : '')
              return (
                <tr key={s.symbol}>
                  <th>
                    <i style={{ background: color }} />
                    {s.symbol} <small>{s.currency}</small>
                  </th>
                  <td>{actual ? display(actual.price) : '—'}</td>
                  <td>{point ? display(point.median) : '—'}</td>
                  <td>
                    {point
                      ? marketPrice(point.low, s.currency) +
                        ' – ' +
                        marketPrice(point.high, s.currency)
                      : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
