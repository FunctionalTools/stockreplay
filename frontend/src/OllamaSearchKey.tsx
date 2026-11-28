import { useState } from 'react'
import { SourceLink, useResource } from './deskCommon'
import { api, errorText } from './types'
import { Busy, ErrorBox, Field } from './ui'

type SearchConnection = {
  configured: boolean
  verified: boolean
  verified_at: string | null
  storage: string
  detail?: string
}

const endpoint = '/ai/ollama-search'

export function OllamaSearchKey({
  busy,
  wait,
}: {
  busy: boolean
  wait: (working: boolean) => void
}) {
  const saved = useResource<SearchConnection>(endpoint)
  const [key, setKey] = useState('')
  const [remember, setRemember] = useState<boolean | null>(null)
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<SearchConnection | null>(null)
  const [error, setError] = useState('')
  const connection = result || saved.data
  const persistent = remember ?? connection?.storage === 'macOS Keychain'

  async function change(action: 'PUT' | 'DELETE') {
    wait(true)
    setWorking(true)
    setError('')
    try {
      const body =
        action === 'PUT'
          ? { remember: persistent, ...(key.trim() ? { key: key.trim() } : {}) }
          : undefined
      const next = await api<SearchConnection>(endpoint, action, body)
      setResult(next)
      setKey('')
      setRemember(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setWorking(false)
      wait(false)
    }
  }

  return (
    <section className="local-search-setup" aria-label="Ollama web search">
      <h3>Add web search to your local model</h3>
      <p>
        This optional key adds Ollama web search to research, forecasts and chat. Your local model
        generates the answers. Searches count toward your Ollama account’s allowance.
      </p>
      <p>
        <SourceLink url="https://ollama.com/settings/keys">Create an Ollama API key</SourceLink> ·{' '}
        <SourceLink url="https://docs.ollama.com/capabilities/web-search">
          Web search guide
        </SourceLink>
      </p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          void change('PUT')
        }}
      >
        <Field name="Ollama web search API key">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            placeholder={
              connection?.configured
                ? 'Saved search key · paste to replace'
                : 'Paste your Ollama website API key'
            }
            required={!connection?.configured}
            onChange={(event) => {
              setKey(event.target.value)
              setError('')
            }}
          />
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={persistent}
            onChange={(event) => setRemember(event.target.checked)}
          />{' '}
          Remember search key in macOS Keychain
        </label>
        <div className="inline local-model-actions">
          <button className="btn" disabled={busy || (!key.trim() && !connection?.configured)}>
            {working ? <Busy text="Checking web search" /> : 'Test web search'}
          </button>
          {connection?.configured && (
            <button
              className="text-btn"
              type="button"
              disabled={busy}
              onClick={() => void change('DELETE')}
            >
              Remove search key
            </button>
          )}
        </div>
      </form>
      {!error && connection?.configured && (
        <p role="status">
          {connection.verified ? 'Web search verified' : 'Saved search key · test to verify'} ·{' '}
          {connection.storage}
        </p>
      )}
      {!connection?.configured && result && <p role="status">Search key removed.</p>}
      <ErrorBox text={error || connection?.detail || saved.error} />
    </section>
  )
}
