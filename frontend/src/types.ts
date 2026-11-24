export type Source = 'demo' | 'yahoo' | 'csv'
export type Rule = {
  indicator: string
  ticker: string
  operator: string
  value: number
  window: number
  slow: number
}
export type Group = { logic: 'and' | 'or'; rules: Rule[] }
export type Config = {
  name: string
  hypothesis: string
  kind: 'event' | 'portfolio'
  tickers: string[]
  benchmark: string
  start: string
  end: string
  source: Source
  entry: Group
  exit: Group | null
  holding: number
  objective: string
  cost_bps: number
  slippage_bps: number
  regime: string
  stats: {
    confidence: number
    samples: number
    block_sessions: number
    seed: number
  }
}
export type Snapshot = {
  id: string
  ticker: string
  source: Source
  first: string
  last: string
  rows: number
  fetched: string
}
export type Observation = {
  ticker: string
  signal: string
  entry: string
  exit: string
  entry_price: number
  exit_price: number
  exit_at: string
  return_pct: number
  benchmark_pct: number
  excess_pct: number
  gross_pct: number
  effect: number
  success: boolean
  regime: string
  readings: (number | null)[]
}
export type Candle = {
  time: string
  open: number
  high: number
  low: number
  close: number
}
export type Metrics = {
  count: number
  mean: number | null
  median: number | null
  win_rate: number | null
  benchmark: number | null
  excess: number | null
  effect: number | null
  best: number | null
  worst: number | null
  failures: number
  overlaps_skipped: number
  boundary_skipped: number
  total_return?: number
  benchmark_total?: number
  annualized?: number | null
  drawdown?: number
  sharpe?: number | null
}
export type Measure = {
  effect: number | null
  count: number
  mean: number | null
  win_rate: number | null
  total_return: number | null
}
export type Cell = {
  threshold: number
  holding: number
  train: Measure
  test: Measure
}
export type Robust = {
  train_end: string
  test_start: string
  quantity: string
  cells: Cell[]
  selected: Cell | null
  folds: {
    start: string
    end: string
    train_end: string
    selected: Cell | null
    test: Measure | null
  }[]
  costs: { bps: number; test: Measure }[]
  parameters: {
    config: Config
    thresholds: number[]
    holdings: number[]
    costs: number[]
    split: number
    folds: number
  }
}
export type Explanation = {
  model: string
  origin?: string
  sections: { key: string; text: string }[]
}
export type Result = {
  opening_notice?: string
  id: string
  config: Config
  engine: string
  distribution: { low: number; high: number; count: number }[]
  metrics: Metrics
  events: Observation[]
  curve: { x: string; strategy: number; benchmark: number }[]
  candles: Record<string, Candle[]>
  sources: Record<string, Snapshot>
  first: string
  last: string
  inference: {
    low: number | null
    high: number | null
    p_value: number | null
    quantity: string
    estimate: number | null
    confidence: number
    block: number
  }
  warnings: string[]
  robustness?: Robust
  explanation?: Explanation
}
export type LibraryItem = {
  id: string
  run_id: string
  name: string
  notes: string
  created: string
  updated: string
}
export type AIStatus = {
  online: boolean
  ready: boolean
  model: string
  models: string[]
}
export const sourceName: Record<Source, string> = {
  demo: 'Archived synthetic data',
  yahoo: 'Yahoo Finance',
  csv: 'Imported CSV',
}
export const indicators: Record<string, string> = {
  daily_return: 'Daily return (%)',
  cumulative_return: 'Cumulative return (%)',
  positive_streak: 'Consecutive up days',
  negative_streak: 'Consecutive down days',
  sma_distance: 'Distance from SMA (%)',
  cross_above: 'SMA bullish crossover (0/1)',
  cross_below: 'SMA bearish crossover (0/1)',
  rsi: 'Cutler RSI',
  volume: 'Share volume',
  relative_volume: 'Relative volume (×)',
  volatility: 'Annualized volatility (%)',
  drawdown: 'Rolling drawdown (%)',
  relative_return: 'Benchmark-relative return (%)',
}
export const objectives: Record<string, string> = {
  positive: 'Positive net return',
  negative: 'Negative net return',
  outperform: 'Outperform benchmark',
  underperform: 'Underperform benchmark',
  recovery: 'Recover pre-signal close',
}
export const newRule = (): Rule => ({
  indicator: 'daily_return',
  ticker: 'ASSET',
  operator: 'lt',
  value: -3,
  window: 20,
  slow: 50,
})
export const pct = (n: number | null | undefined, sign = true, digits = 2) =>
  n == null ? '—' : (sign && n > 0 ? '+' : '') + n.toFixed(digits) + '%'
export const tone = (n: number | null | undefined) =>
  n == null || n === 0 ? '' : n > 0 ? 'positive' : 'negative'
export const money = (n: number) =>
  n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
export const pinsOf = (r: Result) =>
  Object.fromEntries(Object.entries(r.sources).map(([t, s]) => [t, s.id]))
export const shortDate = (v: string) =>
  new Date(v.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json().catch(() => ({
    detail: 'The local service returned an unreadable response.',
  }))
  if (!response.ok)
    throw Error(
      Array.isArray(value.detail)
        ? value.detail
            .map((v: { loc: string[]; msg: string }) => v.loc.slice(1).join('.') + ' ' + v.msg)
            .join(' · ')
        : value.detail || 'Request failed.',
    )
  return value as T
}
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
export function filterEvents(events: Observation[], mode: string, sort: string) {
  const view = events.filter((e) => mode === 'all' || (mode === 'pass' ? e.success : !e.success))
  return view.sort((a, b) =>
    sort === 'effect'
      ? a.effect - b.effect
      : sort === 'worst'
        ? a.return_pct - b.return_pct
        : sort === 'best'
          ? b.return_pct - a.return_pct
          : b.signal.localeCompare(a.signal),
  )
}
export function validPinSet(
  c: Config,
  r: { config: Config; sources: Record<string, Pick<Snapshot, 'id'>> },
) {
  const symbols = new Set([
    ...c.tickers,
    c.benchmark,
    ...[...c.entry.rules, ...(c.exit?.rules || [])]
      .map((v) => v.ticker)
      .filter((t) => !['ASSET', 'BENCHMARK'].includes(t)),
  ])
  return c.source === r.config.source &&
    c.start >= r.config.start &&
    c.end <= r.config.end &&
    [...symbols].every((t) => t in r.sources)
    ? Object.fromEntries([...symbols].map((t) => [t, r.sources[t].id]))
    : undefined
}
