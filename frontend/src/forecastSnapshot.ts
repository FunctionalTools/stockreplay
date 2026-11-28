import type { Forecast, MarketEvent } from './forecastData'
import { fromFocus, rangePresets, validDay, type Selection } from './priceRanges'

export type ForecastSource = {
  id: string
  title: string
  url: string
  source: string
  date: string | null
  kind: string
  excerpt?: string
  date_basis?: string | null
}
export type FiscalQuarter = {
  quarter: string
  period: string | null
  date: string | null
  date_kind: 'period_end' | null
  timing: string
  expectation: string
  consensus: { metric: string; value: number; unit: string; period: string; source_id: string }[]
  source_ids: string[]
}
export type ForecastSnapshot = Forecast & {
  id: string
  created: string
  model: string
  provider: string
  range: string
  requested_start: string | null
  requested_end: string | null
  summary: string
  summary_source_ids: string[]
  drivers: { title: string; direction: string; reason: string; source_ids: string[] }[]
  quarters: FiscalQuarter[]
  sources: ForecastSource[]
}
export type ForecastResponse = { forecast: ForecastSnapshot | null }
export function fromFutureFocus(focus: string): Selection | null {
  if (focus === 'future') return { preset: '6mo' }
  return focus.startsWith('future_') ? fromFocus('range_' + focus.slice('future_'.length)) : null
}
export function selectedFuture(query: string): Selection {
  const params = new URLSearchParams(query),
    preset = params.get('range') || '6mo'
  if (preset === 'custom') {
    const start = params.get('start') || '',
      end = params.get('end') || ''
    if (validDay(start) && validDay(end) && start <= end) return { preset, start, end }
  } else if (rangePresets.some((p) => p === preset)) return { preset }
  return { preset: '6mo' }
}
export function futureHref(
  symbol: string,
  preset: string,
  start?: string,
  end?: string,
  extras: string[] = [],
) {
  const q = new URLSearchParams({ view: 'future' })
  if (preset !== '6mo') q.set('range', preset)
  if (preset === 'custom' && start && end) {
    q.set('start', start)
    q.set('end', end)
  }
  if (extras.length) q.set('compare', extras.join(','))
  return '#/research/' + encodeURIComponent(symbol) + '?' + q.toString()
}
export function snapshotPath(symbol: string, s: Selection) {
  const q = new URLSearchParams({ range: s.preset })
  if (s.preset === 'custom' && s.start && s.end) {
    q.set('start', s.start)
    q.set('end', s.end)
  }
  return '/desk/forecast/' + encodeURIComponent(symbol) + '?' + q.toString()
}
export const providerName = (id?: string) =>
  id === 'openai'
    ? 'OpenAI'
    : id === 'ollama_cloud'
      ? 'Ollama Cloud'
      : id === 'ollama'
        ? 'Ollama on this Mac'
        : 'AI provider'
export function quarterMarkers(f: ForecastSnapshot): MarketEvent[] {
  const end = f.requested_end || f.points.at(-1)?.date || f.as_of
  return f.quarters.flatMap((q) => {
    const source = q.source_ids
      .map((id) => f.sources.find((s) => s.id === id))
      .find((s) => s && /^https?:\/\//i.test(s.url))
    if (
      !q.date ||
      q.date_kind !== 'period_end' ||
      q.date <= f.as_of ||
      q.date > end ||
      !source ||
      (f.range === 'custom' && f.requested_start && q.date < f.requested_start)
    )
      return []
    return [
      {
        id: 'forecast-' + f.symbol + '-' + q.quarter,
        date: q.date,
        title: f.symbol + ' ' + q.quarter + ' fiscal period end',
        kind: 'fiscal',
        status: q.timing,
        symbols: [f.symbol],
        source: source.source,
        url: source.url,
        excerpt: q.expectation,
        relevance: 'Model outlook for this fiscal period. ' + (q.period || ''),
        checked_at: f.created,
      },
    ]
  })
}

export function modelEventMarkers(f: ForecastSnapshot): MarketEvent[] {
  const end = f.requested_end || f.points.at(-1)?.date || f.as_of
  const start = f.range === 'custom' && f.requested_start ? f.requested_start : f.as_of
  return f.sources.flatMap((s) => {
    if (
      s.date_basis !== 'event' ||
      !s.date ||
      !validDay(s.date) ||
      s.date < start ||
      s.date > end ||
      !/^https?:\/\//i.test(s.url)
    )
      return []
    // The stored packet explicitly dates this event. Article publication and
    // retrieval timestamps never become forecast events.
    const driver = f.drivers.find((d) => d.source_ids.includes(s.id))
    return [
      {
        id: 'saved-' + f.symbol + '-' + s.id,
        date: s.date,
        title: s.title,
        kind: s.kind,
        status: driver ? 'Model driver' : 'Forecast source',
        symbols: [f.symbol],
        source: s.source,
        url: s.url,
        excerpt: s.excerpt || s.title,
        relevance: driver ? driver.reason : 'Included in the saved forecast evidence.',
        checked_at: f.created,
      },
    ]
  })
}
