import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { api, errorText } from './types'
import { Busy, ErrorBox } from './ui'

export type Packet<T> = {
  data: T | null
  fetched: string | null
  error: string | null
  stale: boolean
}
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
      <ArrowUpRight size={12} aria-hidden="true" />
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
