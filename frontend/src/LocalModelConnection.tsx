import { useState } from 'react'
import { BookOpen, Check, RefreshCw } from 'lucide-react'
import { useResource } from './deskCommon'
import { MacSetupGuide } from './MacSetupGuide'
import { api, errorText } from './types'
import { Busy, ErrorBox, Field } from './ui'
import type { Connection } from './workspace'

type LocalModels = {
  running: boolean
  recommended: string
  models: { id: string; label: string }[]
  error?: string
}

export function LocalModelConnection({
  connection,
  changed,
  busy,
  wait,
}: {
  connection: Connection | null
  changed: (value: Connection) => void
  busy: boolean
  wait: (busy: boolean) => void
}) {
  const discovery = useResource<LocalModels>('/ai/ollama/models')
  const [choice, setChoice] = useState('')
  const [error, setError] = useState('')
  const [guideOpen, setGuideOpen] = useState(false)
  const options = discovery.data?.models || []
  const selected =
    [choice, connection?.model, discovery.data?.recommended].find((name) =>
      options.some((option) => option.id === name),
    ) ||
    options[0]?.id ||
    ''
  const ready = discovery.data?.running && selected !== '' && !discovery.loading && !discovery.error
  async function test() {
    if (!ready) return
    wait(true)
    setError('')
    try {
      changed(await api<Connection>('/ai/ollama', 'PUT', { model: selected }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      wait(false)
    }
  }
  return (
    <>
      <p>
        Your Mac runs the model. You can generate scores and chat without an API key, subscription
        or usage fees.
      </p>
      <button type="button" className="btn mac-guide-link" onClick={() => setGuideOpen(true)}>
        <BookOpen size={16} aria-hidden="true" /> Free Mac setup guide
      </button>
      <Field name="Installed local model">
        <select
          value={selected}
          disabled={!ready || busy}
          onChange={(e) => {
            setChoice(e.target.value)
            setError('')
          }}
        >
          {options.length === 0 && (
            <option value="">
              {discovery.loading ? 'Checking this Mac…' : 'No local model available'}
            </option>
          )}
          {options.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>
      {!discovery.loading && !discovery.error && !discovery.data?.error && !ready && (
        <p className="local-help">
          {discovery.data?.running
            ? 'Ollama is open. Download a local chat model, then refresh this list.'
            : 'Open Ollama in Applications, then refresh this list.'}
        </p>
      )}
      <ErrorBox text={error || discovery.error || discovery.data?.error || ''} />
      <div className="inline local-model-actions">
        <button className="btn primary" disabled={!ready || busy} onClick={() => void test()}>
          {busy ? <Busy text="Testing local generation" /> : 'Connect & test'}
        </button>
        <button
          className="btn"
          disabled={busy || discovery.loading}
          onClick={() => {
            setError('')
            discovery.reload()
          }}
        >
          <RefreshCw size={14} aria-hidden="true" /> Refresh models
        </button>
      </div>
      {ready && !error && connection?.verified && selected === connection.model && (
        <p className="connection-state" role="status">
          <Check size={15} /> Verified for generation · {connection.model}
        </p>
      )}
      <small>
        The test asks the selected model to generate a response on this Mac. Public prices, news and
        calendar updates still need internet access.
      </small>
      {guideOpen && <MacSetupGuide close={() => setGuideOpen(false)} />}
    </>
  )
}
