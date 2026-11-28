import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText } from './types'
import { useResource } from './deskCommon'
import { predictedPrice, type Forecast } from './forecastData'
import { snapshotPath, type ForecastResponse, type ForecastSnapshot } from './forecastSnapshot'
import type { Connection } from './workspace'

type Options = { connection?: Connection | null; base?: Forecast; automatic?: boolean }
type Outcome = { id?: string; problem?: string; at: number }
const jobs = new Map<
  string,
  { inputs: string; provider: string; result: Promise<ForecastResponse> }
>()
const recent = new Map<string, Outcome>()
const retryWindow = 5 * 60 * 1000
const failureKey = 'stockreplay.forecast-failures.v1'
export function invalidateForecastCache() {
  recent.clear()
}
function lastFailures(): Record<string, Outcome> {
  try {
    return Object.fromEntries(
      Object.entries(
        JSON.parse(sessionStorage.getItem(failureKey) || '{}') as Record<string, Outcome>,
      ).filter(([, row]) => row?.problem && Date.now() - row.at < retryWindow),
    )
  } catch {
    return {}
  }
}

function providerKey(connection?: Connection | null) {
  return JSON.stringify([connection?.provider, connection?.model, connection?.revision])
}

// The assistant and chart share in-flight work. The backend also joins requests
// across browser windows and checks the saved data, evidence, scores and model.
export function requestForecast(
  path: string,
  connection?: Connection | null,
  automatic = false,
  inputs = '',
) {
  const scope = path + providerKey(connection)
  const existing = jobs.get(scope)
  if (existing && (!inputs || !existing.inputs || existing.inputs === inputs))
    return existing.result
  const revision = connection?.revision
  const url =
    path + (automatic ? '&auto=true' : '') + (revision == null ? '' : '&revision=' + revision)
  const job = api<ForecastResponse>(url, 'POST')
    .then((result) => {
      if (!result.forecast) throw Error('The model did not return a forecast.')
      return result
    })
    .finally(() => {
      if (jobs.get(scope)?.result === job) jobs.delete(scope)
    })
  jobs.set(scope, { inputs, provider: providerKey(connection), result: job })
  return job
}

function remember(id: string, value: Omit<Outcome, 'at'>) {
  for (const [key, row] of recent) if (Date.now() - row.at >= retryWindow) recent.delete(key)
  const entry = { ...value, at: Date.now() }
  recent.set(id, entry)
  // Reloading a tab should not keep retrying a busy or unavailable provider.
  const failures = lastFailures()
  if (value.problem) failures[id] = entry
  else delete failures[id]
  try {
    sessionStorage.setItem(
      failureKey,
      JSON.stringify(Object.fromEntries(Object.entries(failures).slice(-32))),
    )
  } catch {
    /* In-memory protection still applies. */
  }
}

function failureMessage(error: unknown) {
  const detail = errorText(error)
  if (/429|quota|rate.limit|credit|billing/i.test(detail))
    return 'The AI provider reported a usage limit.'
  if (/401|403|unauthori|credential|api key|forbidden/i.test(detail))
    return 'The AI provider could not verify the saved connection.'
  return 'The AI forecast is unavailable for this period.'
}

export function useSavedForecast(path: string, options: Options = {}) {
  const { connection, base, automatic = false } = options
  const saved = useResource<ForecastResponse>(path)
  const scope = path + providerKey(connection)
  const providerFailure = 'provider:' + providerKey(connection)
  const canGenerate = !!connection?.configured
  const eligible =
    canGenerate &&
    !connection?.generation_detail &&
    (connection?.provider === 'ollama' || !!(connection?.verified || connection?.generation_ready))
  const active = useRef('')
  const latestJob = useRef<Promise<ForecastResponse> | null>(null)
  const [generation, setGeneration] = useState<{
    scope: string
    busy: boolean
    forecast?: ForecastSnapshot
    error?: string
    automaticError?: string
  } | null>(null)
  const [scoreRevision, scoreChanged] = useState(0)
  const examined = useRef('')
  const last = base?.points.at(-1)
  const inputs =
    base && last
      ? JSON.stringify([
          scope,
          base.model_version,
          base.data_digest,
          base.as_of,
          base.anchor_time,
          predictedPrice(base.points[0]),
          last.date,
          predictedPrice(last),
          base.points.length,
          scoreRevision,
        ])
      : ''
  const result = generation?.scope === scope ? generation : null

  useEffect(() => {
    active.current = scope
    const updateScores = (event: Event) => {
      if ((event as CustomEvent<string>).detail === base?.symbol) scoreChanged((n) => n + 1)
    }
    const receive = (event: Event) => {
      const f = (event as CustomEvent<ForecastSnapshot>).detail
      if (
        !f?.symbol ||
        (connection?.configured &&
          (f.provider !== connection.provider || f.model !== connection.model))
      )
        return
      if (
        snapshotPath(f.symbol, {
          preset: f.range,
          start: f.requested_start || undefined,
          end: f.requested_end || undefined,
        }) === path
      ) {
        latestJob.current = null
        setGeneration({ scope, busy: false, forecast: f })
      }
    }
    window.addEventListener('stockreplay:forecast-saved', receive)
    window.addEventListener('stockreplay:forecast-inputs-changed', updateScores)
    return () => {
      active.current = ''
      window.removeEventListener('stockreplay:forecast-saved', receive)
      window.removeEventListener('stockreplay:forecast-inputs-changed', updateScores)
    }
  }, [scope, path, base?.symbol, connection?.configured, connection?.provider, connection?.model])

  const start = useCallback(
    (auto: boolean) => {
      const job = requestForecast(path, connection, auto, inputs)
      latestJob.current = job
      setGeneration((prev) => ({
        scope,
        busy: true,
        forecast: prev?.scope === scope ? prev.forecast : undefined,
      }))
      void job
        .then(({ forecast }) => {
          if (inputs && forecast) remember(inputs, { id: forecast.id })
          if (forecast) remember(providerFailure, { id: forecast.id })
          if (active.current === scope && latestJob.current === job && forecast)
            setGeneration({ scope, busy: false, forecast })
        })
        .catch((e) => {
          const message = failureMessage(e)
          if (inputs) remember(inputs, { problem: message })
          if (
            /429|quota|rate.limit|credit|billing|401|403|unauthori|forbidden/i.test(errorText(e))
          ) {
            remember(providerFailure, { problem: message })
          }
          if (active.current === scope && latestJob.current === job)
            setGeneration((prev) => ({
              scope,
              busy: false,
              forecast: prev?.scope === scope ? prev.forecast : undefined,
              ...(auto ? { automaticError: message } : { error: errorText(e) }),
            }))
        })
    },
    [path, connection, scope, inputs, providerFailure],
  )

  const passive = window.history.state?.stockreplayReadOnlyForecast === true
  const latest = result?.forecast || saved.data?.forecast || null
  useEffect(() => {
    if (
      !automatic ||
      passive ||
      !eligible ||
      !inputs ||
      !saved.data ||
      saved.loading ||
      examined.current === inputs
    )
      return
    const failures = lastFailures()
    const prior = failures[providerFailure] || recent.get(inputs) || failures[inputs]
    if (
      prior &&
      Date.now() - prior.at < retryWindow &&
      (prior.problem || (latest && prior.id === latest.id))
    ) {
      examined.current = inputs
      if (prior.problem) setGeneration({ scope, busy: false, automaticError: prior.problem })
      return
    }
    // Let keyboard navigation and rapid changes settle on a single chosen period.
    let selected = true
    const timer = window.setTimeout(async () => {
      // A slow model may still be working on the previously visible selection.
      // Let it finish and only submit the period the user has kept open.
      const previous = [...jobs.entries()]
        .filter(([key, job]) => key !== scope && job.provider === providerKey(connection))
        .map(([, job]) => job.result)
      if (previous.length) await Promise.allSettled(previous)
      if (selected) {
        examined.current = inputs
        const blocked = lastFailures()[providerFailure]
        if (blocked?.problem) setGeneration({ scope, busy: false, automaticError: blocked.problem })
        else start(true)
      }
    }, 650)
    return () => {
      selected = false
      window.clearTimeout(timer)
    }
  }, [
    automatic,
    passive,
    eligible,
    inputs,
    saved.data,
    saved.loading,
    latest,
    scope,
    start,
    providerFailure,
    connection,
  ])

  return {
    forecast: latest,
    generated: result?.forecast || null,
    busy: !!result?.busy,
    loading: saved.loading,
    error: result?.error || saved.error,
    automaticError: result?.automaticError || '',
    canGenerate,
    eligible,
    generate: () => {
      examined.current = inputs
      start(false)
    },
  }
}
