import { useEffect, useRef, useState } from 'react'
import { api, errorText } from './types'
import { useResource } from './deskCommon'
import { snapshotPath, type ForecastResponse, type ForecastSnapshot } from './forecastSnapshot'

const pending = new Map<string, Promise<ForecastResponse>>()
export function useSavedForecast(path: string) {
  const saved = useResource<ForecastResponse>(path)
  const [result, setResult] = useState<ForecastSnapshot | null>(null),
    [busy, wait] = useState(() => pending.has(path)),
    [error, fail] = useState('')
  const mounted = useRef(false)
  function observe(job: Promise<ForecastResponse>) {
    wait(true)
    fail('')
    void job
      .then((r) => {
        if (mounted.current) {
          if (!r.forecast) throw Error('The model did not return a forecast.')
          setResult(r.forecast)
        }
      })
      .catch((e) => {
        if (mounted.current) fail(errorText(e))
      })
      .finally(() => {
        if (mounted.current) wait(false)
      })
  }
  useEffect(() => {
    mounted.current = true
    const saved = (event: Event) => {
      const snapshot = (event as CustomEvent<ForecastSnapshot>).detail
      if (!snapshot?.symbol || !snapshot.range) return
      const selection = {
        preset: snapshot.range,
        start: snapshot.requested_start || undefined,
        end: snapshot.requested_end || undefined,
      }
      if (snapshotPath(snapshot.symbol, selection) === path) {
        setResult(snapshot)
        fail('')
      }
    }
    window.addEventListener('stockreplay:forecast-saved', saved)
    const job = pending.get(path)
    if (job) observe(job)
    return () => {
      mounted.current = false
      window.removeEventListener('stockreplay:forecast-saved', saved)
    }
  }, [path])
  function generate() {
    const existing = pending.get(path)
    if (existing) {
      observe(existing)
      return
    }
    const job = api<ForecastResponse>(path, 'POST').finally(() => pending.delete(path))
    pending.set(path, job)
    observe(job)
  }
  return {
    forecast: result || saved.data?.forecast || null,
    generated: result,
    busy,
    loading: saved.loading,
    error: error || saved.error,
    generate,
  }
}
