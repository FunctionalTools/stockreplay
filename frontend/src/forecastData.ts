import { tickerPattern } from './workspace'
import { validDay } from './priceRanges'

export const horizons = {
  '1d': 'Day',
  '5d': '5 sessions',
  '1w': 'Week',
  '1mo': 'Month',
  '3mo': '3 months',
  '6mo': '6 months',
  ytd: 'Year-end',
  '1y': '1 year',
  '2y': '2 years',
  '5y': '5 years',
  '10y': '10 years',
  max: 'Max (10Y)',
  custom: 'Custom',
} as const
export type Horizon = keyof typeof horizons
export type Forecast = {
  symbol: string
  currency: string | null
  timezone: string
  calendar: string
  source: string
  url: string | null
  fetched: string | null
  as_of: string
  history: { date: string; price: number }[]
  points: { date: string; low: number; median: number; high: number; baseline?: number }[]
  coverage: { start: string; end: string; observations: number; returns: number }
  model_version?: string
  data_digest?: string
  requested_start?: string | null
  requested_end?: string | null
  expected_session?: string
  horizon_origin?: string
  anchor_kind?: 'confirmed_close' | 'intraday'
  anchor_time?: string | null
  data_note?: string | null
  price_sources?: { source: string; url: string | null }[]
  validation_1d?: {
    tested_sessions: number
    inside_band_sessions: number
    observed_coverage_pct: number | null
  }
  annualized_volatility_pct: number
  method: string
  assumptions: string[]
  stale: boolean
}
export type Projections = {
  horizon: Horizon
  seed: number
  series: Forecast[]
  errors: { symbol: string; error: string }[]
}
export type EventSource = {
  label: 'Fiscal date' | 'Consensus' | 'Forecast evidence'
  publisher: string
  url: string
}
export type MarketEvent = {
  id: string
  date: string
  end_date?: string | null
  title: string
  kind: string
  status: string
  symbols: string[]
  source: string
  url: string
  excerpt: string
  relevance: string
  checked_at: string
  sources?: EventSource[]
}
export type Events = {
  start: string
  end: string
  checked_at: string
  events: MarketEvent[]
  gaps: { source: string; symbols: string[]; reason: string }[]
}
export type CalendarSelection = {
  symbols: string[]
  horizon: Horizon
  start?: string
  end?: string
}
export function calendarSelection(symbol: string, query: string): CalendarSelection {
  const params = new URLSearchParams(query)
  const symbols = [
    ...new Set(
      [symbol, ...(params.get('symbols') || '').split(',')]
        .map((s) => s.trim().toUpperCase())
        .filter((s) => tickerPattern.test(s)),
    ),
  ].slice(0, 8)
  const horizon = params.get('horizon') || ''
  if (horizon === 'custom') {
    const start = params.get('start') || '',
      end = params.get('end') || ''
    return validDay(start) && validDay(end) && start <= end
      ? { symbols, horizon, start, end }
      : { symbols, horizon: '1mo' }
  }
  return { symbols, horizon: Object.hasOwn(horizons, horizon) ? (horizon as Horizon) : '1mo' }
}
export function calendarHref({ symbols, horizon, start, end }: CalendarSelection) {
  const params = new URLSearchParams()
  if (symbols.length > 1) params.set('symbols', symbols.join(','))
  if (horizon !== '1mo') params.set('horizon', horizon)
  if (horizon === 'custom' && start && end) {
    params.set('start', start)
    params.set('end', end)
  }
  const q = params.toString()
  return '#/calendar/' + encodeURIComponent(symbols[0] || '') + (q ? '?' + q : '')
}

export function latestSharedClose(series: Forecast[]) {
  if (!series.length) return null
  const others = series.slice(1).map((s) => new Set(s.history.map((b) => b.date)))
  return (
    [...series[0].history].reverse().find((b) => others.every((set) => set.has(b.date)))?.date ||
    null
  )
}
export function forecastInspectionDate(series: Forecast[]) {
  const [primary, ...others] = series
  if (!primary) return null
  const future = primary.points.filter((p) => p.date > primary.as_of).reverse()
  const calendars = others.map(
    (s) => new Set(s.points.filter((p) => p.date > s.as_of).map((p) => p.date)),
  )
  // Different exchanges can have different last sessions, or no overlap for a one-day forecast.
  return (
    future.find((p) => calendars.every((days) => days.has(p.date)))?.date || future[0]?.date || null
  )
}
export const dayTime = (day: string) => Date.parse(day + 'T00:00:00Z')
export function eventPaths(symbols: string[], start: string, end: string) {
  const make = (a: string, b: string) =>
    '/desk/events?' + new URLSearchParams({ symbols: symbols.join(','), start: a, end: b })
  // The source API accepts at most six years at a time.
  const midway = new Date(dayTime(start))
  midway.setUTCFullYear(midway.getUTCFullYear() + 5)
  const split = midway.toISOString().slice(0, 10)
  if (end <= split) return [make(start, end), null] as const
  midway.setUTCDate(midway.getUTCDate() + 1)
  if (dayTime(end) - midway.getTime() > 2192 * 86400000) return [null, null] as const
  return [make(start, split), make(midway.toISOString().slice(0, 10), end)] as const
}
export function eventPeriod(series: Forecast[]) {
  if (!series.length) return null
  const anchors = series.map((s) => s.horizon_origin || s.as_of).sort()
  const ends = series.flatMap((s) => s.requested_end || s.points.at(-1)?.date || []).sort()
  return ends.length ? { start: anchors[0], end: ends[ends.length - 1] } : null
}
