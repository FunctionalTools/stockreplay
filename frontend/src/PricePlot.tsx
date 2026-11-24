import { useEffect, useId, useRef, useState } from 'react'
import { api, errorText, pct } from './types'
import { Busy, ErrorBox } from './ui'
import { SourceLink, type Packet } from './deskCommon'
import { amount, shortDay } from './workspace'
export type Prices = {
  symbol: string
  currency: string | null
  as_of: string
  source: string
  url: string | null
  bars: { time: number; date: string; raw_close: number; close: number }[]
}
export function usePrices(symbols: string[], span: string, snapshot = '', version = 0) {
  const key = symbols.join(',') + '|' + span + '|' + snapshot + '|' + version
  const [state, set] = useState<{ key: string; series: Prices[]; errors: string[] }>({
    key: '',
    series: [],
    errors: [],
  })
  useEffect(() => {
    let active = true
    const paths = key.split('|')[0].split(',')
    Promise.allSettled(
      paths.map(async (s) => {
        if (snapshot) return await api<Prices>('/prices/imports/' + encodeURIComponent(snapshot))
        const p = await api<Packet<Prices>>(
          '/desk/chart/' +
            encodeURIComponent(s) +
            '?interval=1d&span=' +
            span +
            (version ? '&refresh=true' : ''),
        )
        if (!p.data) throw Error(s + ' · ' + (p.error || 'Price history is unavailable.'))
        return { ...p.data, source: p.data.source + (p.stale ? ' (cached)' : '') }
      }),
    ).then((results) => {
      if (active)
        set({
          key,
          series: results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
          errors: results.flatMap((r) => (r.status === 'rejected' ? [errorText(r.reason)] : [])),
        })
    })
    return () => {
      active = false
    }
  }, [key, span, snapshot, version])
  return {
    loading: state.key !== key,
    series: state.key === key ? state.series : [],
    errors: state.key === key ? state.errors : [],
  }
}
const colors = ['var(--accent)', 'var(--blue)', 'var(--amber)', 'var(--violet)']
export function PricePlot({ series, compact = false }: { series: Prices[]; compact?: boolean }) {
  const [hover, setHover] = useState<number | null>(null)
  const gradient = useId().replace(/:/g, '')
  const host = useRef<HTMLElement | null>(null),
    [width, setWidth] = useState(compact ? 400 : 660)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const resize = () => setWidth(Math.max(260, Math.round(el.clientWidth)))
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    return () => observer.disconnect()
  }, [series.length])
  if (!series.length) return null
  const multi = series.length > 1,
    maps = series.map((s) => new Map(s.bars.map((b) => [b.date, b])))
  const dates = series[0].bars.map((b) => b.date).filter((d) => maps.every((m) => m.has(d)))
  if (!dates.length) return <p>No shared trading dates in this range.</p>
  const values = maps.map((m) =>
    dates.map((d) =>
      multi ? 100 * (m.get(d)!.close / m.get(dates[0])!.close - 1) : m.get(d)!.close,
    ),
  )
  const flat = values.flat()
  const lo = Math.min(...flat),
    hi = Math.max(...flat),
    pad = (hi - lo || Math.abs(hi) || 1) * 0.12
  const W = width,
    H = compact ? 150 : width < 440 ? 162 : 202,
    L = 6,
    R = width < 440 ? 42 : 52,
    B = 24,
    T = 12
  const x = (i: number) => L + (i / Math.max(1, dates.length - 1)) * (W - R - L)
  const y = (n: number) => T + ((hi + pad - n) / (hi - lo + 2 * pad)) * (H - T - B)
  const paths = values.map((v) =>
    v.map((n, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(n).toFixed(1)).join(' '),
  )
  const idx = hover === null ? null : Math.max(0, Math.min(dates.length - 1, hover))
  return (
    <figure ref={host} className={'price-plot ' + (compact ? 'compact' : '')}>
      <svg
        viewBox={'0 0 ' + W + ' ' + H}
        role="img"
        aria-label={
          series.map((s) => s.symbol).join(' and ') +
          ' historical ' +
          (multi ? 'percentage returns' : 'adjusted prices')
        }
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            setHover((i) =>
              Math.max(
                0,
                Math.min(
                  dates.length - 1,
                  (i ?? dates.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1),
                ),
              ),
            )
          }
        }}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onPointerMove={(e) => {
          const b = e.currentTarget.getBoundingClientRect()
          setHover(
            Math.round(
              ((((e.clientX - b.left) / b.width) * W - L) / (W - R - L)) * (dates.length - 1),
            ),
          )
        }}
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity=".20" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity=".01" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((i) => {
          const value = hi + pad - (i * (hi - lo + 2 * pad)) / 3
          return (
            <g key={i}>
              <line
                x1={L}
                x2={W - R}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--line)"
                strokeDasharray="3 5"
              />
              <text x={W - R + 8} y={y(value) + 4}>
                {multi
                  ? value.toFixed(1) + '%'
                  : value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </text>
            </g>
          )
        })}
        {!multi && (
          <path
            d={
              paths[0] +
              ' L' +
              x(dates.length - 1) +
              ' ' +
              (H - B) +
              ' L' +
              L +
              ' ' +
              (H - B) +
              ' Z'
            }
            fill={'url(#' + gradient + ')'}
          />
        )}
        {paths.map((path, i) => (
          <path
            key={i}
            d={path}
            stroke={colors[i % 4]}
            fill="none"
            strokeWidth="2.5"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {[0, Math.floor((dates.length - 1) / 2), dates.length - 1]
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((i, k) => (
            <text
              key={i}
              x={x(i)}
              y={H - 3}
              textAnchor={k === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle'}
            >
              {shortDay(dates[i])}
            </text>
          ))}
        {idx !== null && (
          <g>
            <line
              x1={x(idx)}
              x2={x(idx)}
              y1={T}
              y2={H - B}
              stroke="var(--muted)"
              strokeDasharray="3 3"
            />
            {values.map((v, i) => (
              <circle
                key={i}
                r="4.3"
                cx={x(idx)}
                cy={y(v[idx])}
                fill={colors[i % 4]}
                stroke="var(--panel)"
                strokeWidth="2"
              />
            ))}
          </g>
        )}
      </svg>
      <figcaption>
        {idx !== null ? (
          <span>
            {shortDay(dates[idx])} ·{' '}
            {series
              .map(
                (s, i) =>
                  s.symbol +
                  ' ' +
                  (multi ? pct(values[i][idx]) : amount(values[i][idx], s.currency)),
              )
              .join(' · ')}
          </span>
        ) : (
          <span>
            {multi ? 'Return since ' + shortDay(dates[0]) : 'Adjusted closing prices'} ·{' '}
            {series[0].url ? 'Through ' : 'File through '}
            {shortDay(dates[dates.length - 1])}
          </span>
        )}
        {series.map((s, i) => (
          <span key={s.symbol} style={{ color: colors[i % 4] }}>
            {s.url ? <SourceLink url={s.url}>{multi ? s.symbol : s.source}</SourceLink> : s.source}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}
export function ChatGraph({ symbols, span }: { symbols: string[]; span: string }) {
  const p = usePrices(symbols, span)
  return (
    <div className="chat-graph">
      <strong>
        {symbols.join(' / ')} · {span}
      </strong>
      {p.loading && <Busy text="Loading prices" />}
      <ErrorBox text={p.errors.join(' ')} />
      <PricePlot series={p.series} compact />
    </div>
  )
}
