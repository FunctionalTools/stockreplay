import { tickerPattern } from './workspace'

export const horizons = {
  '1d': 'Day',
  '1w': 'Week',
  '1mo': 'Month',
  '6mo': '6 months',
  '1y': '1 year',
  '5y': '5 years',
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
export type CalendarSelection = { symbols: string[]; horizon: Horizon }
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
  return { symbols, horizon: Object.hasOwn(horizons, horizon) ? (horizon as Horizon) : '1mo' }
}
export function calendarHref({ symbols, horizon }: CalendarSelection) {
  const params = new URLSearchParams()
  if (symbols.length > 1) params.set('symbols', symbols.join(','))
  if (horizon !== '1mo') params.set('horizon', horizon)
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
export const dayTime = (day: string) => Date.parse(day + 'T00:00:00Z')
export function eventPeriod(series: Forecast[]) {
  if (!series.length) return null
  const anchors = series.map((s) => s.as_of).sort()
  const ends = series
    .flatMap((s) => (s.points.length ? [s.points[s.points.length - 1].date] : []))
    .sort()
  return ends.length ? { start: anchors[0], end: ends[ends.length - 1] } : null
}
