import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { api, errorText, pct } from './types'
import { Busy, ErrorBox } from './ui'
import { SourceLink, useResource, type Packet } from './deskCommon'
import { amount, shortDay } from './workspace'
export type Prices = {
  symbol: string
  currency: string | null
  interval?: string
  timezone?: string
  price_basis?: string
  as_of: string
  source: string
  url: string | null
  bars: { time: number; date: string; raw_close: number; close: number }[]
}
export function marketPrice(value?: number | null, currency?: string | null) {
  if (value == null || Math.abs(value) >= 1 || value === 0) return amount(value, currency)
  // Extra precision keeps genuine sub-dollar quotes distinct at historical prices.
  const digits = Math.min(12, 2 - Math.floor(Math.log10(Math.abs(value))))
  return value.toLocaleString(undefined, {
    ...(currency && /^[A-Z]{3}$/.test(currency) ? { style: 'currency', currency } : {}),
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  })
}
type PriceRequest = { symbol: string; path: string }
export function usePricePackets<T extends Prices = Prices>(requests: PriceRequest[], raw = false) {
  const key = JSON.stringify(requests)
  const [state, set] = useState<{ key: string; series: T[]; errors: string[] }>({
    key: '',
    series: [],
    errors: [],
  })
  useEffect(() => {
    let active = true
    const paths: PriceRequest[] = JSON.parse(key)
    Promise.allSettled(
      paths.map(async ({ symbol, path }) => {
        if (raw) return api<T>(path)
        const packet = await api<Packet<T>>(path)
        if (!packet.data)
          throw Error(symbol + ' · ' + (packet.error || 'Price history is unavailable.'))
        return { ...packet.data, source: packet.data.source + (packet.stale ? ' (cached)' : '') }
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
  }, [key, raw])
  return {
    loading: state.key !== key,
    series: state.key === key ? state.series : [],
    errors: state.key === key ? state.errors : [],
  }
}
export function usePrices(symbols: string[], span: string, snapshot = '', version = 0) {
  return usePricePackets(
    symbols.map((symbol) => ({
      symbol,
      path: snapshot
        ? '/prices/imports/' + encodeURIComponent(snapshot)
        : '/desk/chart/' +
          encodeURIComponent(symbol) +
          '?interval=1d&span=' +
          encodeURIComponent(span) +
          (version ? '&refresh=true&v=' + version : ''),
    })),
    !!snapshot,
  )
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
  const multi = series.length > 1
  // Align intraday bars by instant and daily bars by their exchange-date UTC anchor.
  const plot = useMemo(() => {
    const maps = series.map((s) => new Map(s.bars.map((b) => [b.time, b])))
    const times = [...(maps[0]?.keys() || [])]
      .filter((t) => maps.every((m) => m.has(t)))
      .sort((a, b) => a - b)
    const days = times.map((t) => maps[0].get(t)!.date)
    let lo = Infinity,
      hi = -Infinity
    const values = maps.map((m) =>
      times.map((t) => {
        const value = multi ? 100 * (m.get(t)!.close / m.get(times[0])!.close - 1) : m.get(t)!.close
        lo = Math.min(lo, value)
        hi = Math.max(hi, value)
        return value
      }),
    )
    return { times, days, values, lo, hi }
  }, [series, multi])
  if (!series.length) return null
  const { times, days, values, lo, hi } = plot
  if (!times.length || (multi && times.length < 2))
    return <p>Too few shared trading observations to chart this range.</p>
  const intraday = series[0].interval === '5m'
  const timeFormat = intraday
    ? new Intl.DateTimeFormat(undefined, {
        timeZone: series[0].timezone || 'UTC',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null
  const label = (i: number, compactDate = false) => {
    if (!timeFormat) return shortDay(days[i])
    const clock = timeFormat.format(times[i] * 1000)
    if (compactDate && days[0] === days.at(-1)) return clock
    return (compactDate ? days[i].slice(5).replace('-', '/') : shortDay(days[i])) + ' ' + clock
  }
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.12
  const axisPrecision = Math.min(
    12,
    Math.max(2, 1 - Math.floor(Math.log10((hi - lo + 2 * pad) / 3))),
  )
  const ticks = Array.from({ length: 4 }, (_, i) => {
    const value = hi + pad - (i * (hi - lo + 2 * pad)) / 3
    const text = multi
      ? value.toFixed(1) + '%'
      : value.toLocaleString(undefined, { maximumFractionDigits: axisPrecision })
    return { value, text }
  })
  const W = width,
    H = compact ? 150 : width < 440 ? 162 : 202,
    L = 6,
    R = Math.max(38, 10 + Math.max(...ticks.map((t) => t.text.length)) * 7),
    B = 24,
    T = 12
  const x = (i: number) => L + (i / Math.max(1, times.length - 1)) * (W - R - L)
  const y = (n: number) => T + ((hi + pad - n) / (hi - lo + 2 * pad)) * (H - T - B)
  const paths = values.map((v) =>
    v.map((n, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(n).toFixed(1)).join(' '),
  )
  const idx = hover === null ? null : Math.max(0, Math.min(times.length - 1, hover))
  return (
    <figure ref={host} className={'price-plot ' + (compact ? 'compact' : '')}>
      <svg
        viewBox={'0 0 ' + W + ' ' + H}
        role="img"
        aria-label={
          series.map((s) => s.symbol).join(' and ') +
          ' historical ' +
          (multi
            ? 'percentage returns'
            : intraday
              ? 'intraday prices'
              : series[0].price_basis === 'nominal'
                ? 'reported prices'
                : 'adjusted prices')
        }
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            setHover((i) =>
              Math.max(
                0,
                Math.min(
                  times.length - 1,
                  (i ?? times.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1),
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
              ((((e.clientX - b.left) / b.width) * W - L) / (W - R - L)) * (times.length - 1),
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
        {ticks.map(({ value, text }, i) => {
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
              <text x={W - 2} textAnchor="end" y={y(value) + 4}>
                {text}
              </text>
            </g>
          )
        })}
        {!multi && (
          <path
            d={
              paths[0] +
              ' L' +
              x(times.length - 1) +
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
        {times.length === 1 && <circle r="3.5" cx={x(0)} cy={y(values[0][0])} fill={colors[0]} />}
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
        {(W - R - L < 360
          ? [0, times.length - 1]
          : [0, Math.floor((times.length - 1) / 2), times.length - 1]
        )
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((i, k) => (
            <text
              key={i}
              x={x(i)}
              y={H - 3}
              textAnchor={k === 0 ? 'start' : i === times.length - 1 ? 'end' : 'middle'}
            >
              {label(i, true)}
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
            {label(idx)} ·{' '}
            {series
              .map(
                (s, i) =>
                  s.symbol +
                  ' ' +
                  (multi ? pct(values[i][idx]) : marketPrice(values[i][idx], s.currency)),
              )
              .join(' · ')}
          </span>
        ) : (
          <span>
            {multi
              ? 'Return since ' + label(0)
              : intraday
                ? '5-minute prices'
                : series[0].price_basis === 'nominal'
                  ? 'Reported closing prices'
                  : 'Adjusted closing prices'}{' '}
            · {series[0].url ? 'Through ' : 'File through '}
            {label(times.length - 1)}
            {intraday && ' · ' + (series[0].timezone || 'UTC')}
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
type GraphRequest = { symbols: string[]; span: string; snapshot?: string }
export function ChatGraph({ snapshot, ...request }: GraphRequest) {
  return snapshot ? <CapturedGraph snapshot={snapshot} {...request} /> : <LiveGraph {...request} />
}
function CapturedGraph({ snapshot, symbols, span }: GraphRequest) {
  const { data, error, loading } = useResource<{ series: Prices[]; errors: string[] }>(
    '/assistant/charts/' + encodeURIComponent(snapshot!),
  )
  return (
    <div className="chat-graph">
      <strong>
        {symbols.join(' / ')} · {span}
      </strong>
      {loading && <Busy text="Opening saved chart" />}
      <ErrorBox text={error || data?.errors.join(' ') || ''} />
      {data && <PricePlot series={data.series} compact />}
    </div>
  )
}
function LiveGraph({ symbols, span }: GraphRequest) {
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
