import type { Prices } from './PricePlot'

export const rangePresets = [
  '1d',
  '5d',
  '1w',
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
export type Selection = { preset: string; start?: string; end?: string }
export function validDay(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const millis = Date.parse(s + 'T00:00:00Z')
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === s
}
export function fromFocus(focus: string): Selection | null {
  const [prefix, preset, start, end, ...rest] = focus.split('_')
  if (prefix !== 'range' || !rangePresets.some((v) => v === preset) || rest.length) return null
  if (preset !== 'custom') return start === undefined ? { preset } : null
  return validDay(start || '') && validDay(end || '') && start <= end
    ? { preset, start, end }
    : null
}
export const validRangeFocus = (focus: string) => !!fromFocus(focus)
export type Observation = { date: string; time: number; price: number }
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
