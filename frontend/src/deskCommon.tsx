import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, RefreshCw, Search } from 'lucide-react'
import { api, errorText } from './types'
import { Busy, ErrorBox } from './ui'

export type Packet<T> = {
  data: T | null
  fetched: string | null
  error: string | null
  stale: boolean
}
export type Evidence = {
  id: string
  group: string
  text: string
  url: string
  date: string
  source: string
}
export type Rating = {
  score: number
  label: string
  as_of: string
  current: boolean
  formula: string
  factors: {
    label: string
    value: number
    weight: number
    points: number
    floor: number
    ceiling: number
  }[]
}
export type OpenStatus = { configured: boolean; model: string; storage: string }
export type Navigate = (page: string, symbol?: string) => void
export const fmt = (value: number | null | undefined, digits = 2) =>
  value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits })
export function when(v: string | null | undefined) {
  return v ? v.slice(0, 10) : 'Unavailable'
}
export function useResource<T>(path: string | null) {
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<{
    key: string | null
    value: T | null
    error: string
    loading: boolean
  }>({ key: null, value: null, error: '', loading: false })
  const [forcePath, setForcePath] = useState<string | null>(null)
  const reload = useCallback(
    (fresh = false) => {
      setForcePath(fresh ? path : null)
      setVersion((n) => n + 1)
    },
    [path],
  )
  useEffect(() => {
    let active = true
    if (!path) return
    setState((s) => ({
      key: path,
      value: s.key === path ? s.value : null,
      error: '',
      loading: true,
    }))
    const url = forcePath === path ? path + (path.includes('?') ? '&' : '?') + 'refresh=true' : path
    void api<T>(url)
      .then((value) => {
        if (active) setState({ key: path, value, error: '', loading: false })
      })
      .catch((e) => {
        if (active)
          setState({
            key: path,
            value: null,
            error: errorText(e),
            loading: false,
          })
      })
    return () => {
      active = false
    }
  }, [path, version, forcePath])
  return {
    data: state.key === path ? state.value : null,
    error: state.key === path ? state.error : '',
    loading: !!path && (state.key !== path || state.loading),
    reload,
  }
}
export function PageHead({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </div>
  )
}
export function TickerBar({
  symbol,
  select,
  refresh,
  busy,
}: {
  symbol: string
  select: (v: string) => void
  refresh?: () => void
  busy?: boolean
}) {
  const [input, setInput] = useState(symbol)
  useEffect(() => setInput(symbol), [symbol])
  return (
    <div className="desk-toolbar">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (input.trim()) select(input.trim().toUpperCase())
        }}
      >
        <label className="desk-search">
          <Search size={16} />
          <input
            aria-label="Market symbol"
            value={input}
            maxLength={20}
            required
            onChange={(e) => setInput(e.target.value)}
            placeholder="Symbol"
          />
        </label>
        <button className="btn" type="submit">
          Open symbol
        </button>
      </form>
      {refresh && (
        <button className="btn" disabled={busy} onClick={refresh}>
          <RefreshCw size={14} />
          Refresh sources
        </button>
      )}
    </div>
  )
}
export function FetchState({ loading, error }: { loading: boolean; error: string }) {
  return (
    <>
      <ErrorBox text={error} />
      {loading && (
        <p className="fetch-state" role="status">
          <Busy text="Reading market sources" />
        </p>
      )}
    </>
  )
}
export function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <a className="source-link" href={url} target="_blank" rel="noopener noreferrer">
      {children}
      <ArrowUpRight size={12} />
    </a>
  )
}
export function PacketNote({
  p,
}: {
  p: { error: string | null; stale: boolean; fetched: string | null }
}) {
  return p.error ? (
    <p className="data-warning">
      {p.stale ? 'Cached response from ' + when(p.fetched) + '. ' : ''}
      {p.error}
    </p>
  ) : null
}
export function RatingCard({ rating }: { rating: Rating | null }) {
  return (
    <section className="panel desk-card">
      <h3>StockReplay technical rating</h3>
      {rating ? (
        <>
          <div className="rating-number">
            {rating.score}
            <small> / 100</small>{' '}
            <span
              className={'badge ' + (rating.score >= 60 ? 'green' : rating.score < 40 ? 'red' : '')}
            >
              {rating.label}
            </span>
          </div>
          <p className="helper">
            Adjusted closes through {rating.as_of}
            {rating.current ? '' : ' · older than the latest US session'}
          </p>
          <div className="factor-list">
            {rating.factors.map((f) => (
              <div key={f.label}>
                <span>{f.label}</span>
                <b>{fmt(f.value)}%</b>
                <meter min="0" max={f.weight} value={f.points} />
                <small>
                  {fmt(f.points, 1)} / {f.weight} pts
                </small>
              </div>
            ))}
          </div>
          <details>
            <summary>Score calculation</summary>
            <p>
              Each factor earns points linearly between its floor and ceiling. Values outside those
              bounds earn zero or full weight. The score sums the four contributions.
            </p>
            {rating.factors.map((f) => (
              <p key={f.label}>
                {f.label} · {f.floor}% to {f.ceiling}% · {f.weight} possible points
              </p>
            ))}
          </details>
        </>
      ) : (
        <p className="helper">This score needs 200 shared daily closes for the security and SPY.</p>
      )}
    </section>
  )
}
