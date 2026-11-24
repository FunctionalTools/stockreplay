export type Page = 'Research' | 'Watchlists' | 'Portfolio' | 'Settings'
export type Preferences = {
  appearance: 'system' | 'light' | 'dark'
  accent: 'forest' | 'ocean' | 'violet' | 'amber'
  advanced: boolean
  home_symbol: string
}
export const firstPreferences: Preferences = {
  appearance: 'system',
  accent: 'forest',
  advanced: false,
  home_symbol: 'NVDA',
}
export type Connection = {
  configured: boolean
  verified: boolean
  verified_at: string | null
  model: string
  storage: string
}
export type SavedList = { id: string; name: string; symbols: string[] }
export type Source = {
  id: string
  group: string
  text: string
  date: string
  source: string
  url: string
  excerpt?: string | null
}
export type Point = { text: string; citations: string[] }
export type Opinion = {
  id: string
  symbol: string
  buy_score?: number
  risk_score?: number
  confidence?: string
  horizon?: string
  created: string
  model: string
  as_of: string
  thesis: Point
  catalysts: Point[]
  risks: Point[]
  reconsider: Point
  sources: Source[]
}
export type Intent = { kind: string; seq: number }
export const tickerPattern = /^[A-Z0-9^][A-Z0-9.^=\-]{0,19}$/
export const shortDay = (v?: string | null) =>
  v
    ? new Date(v.slice(0, 10) + 'T12:00:00Z').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : 'Date unavailable'
export const amount = (value?: number | null, currency?: string | null) =>
  value == null
    ? '—'
    : currency && /^[A-Z]{3}$/.test(currency)
      ? new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency,
          maximumFractionDigits: 2,
        }).format(value)
      : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
