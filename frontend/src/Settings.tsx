import { useEffect, useState } from 'react'
import { Check, KeyRound, Monitor, Moon, Palette, SlidersHorizontal, Sun } from 'lucide-react'
import { api, errorText } from './types'
import { OllamaSearchKey } from './OllamaSearchKey'
import { LocalModelConnection } from './LocalModelConnection'
import { useResource, SourceLink } from './deskCommon'
import { Busy, ErrorBox, Field } from './ui'
import { type Preferences, type Connection, type AIProvider, tickerPattern } from './workspace'

const providers: { id: AIProvider; title: string; detail: string }[] = [
  { id: 'ollama_cloud', title: 'Ollama website API', detail: 'Key from ollama.com' },
  { id: 'openai', title: 'OpenAI API', detail: 'OpenAI project key' },
  { id: 'ollama', title: 'On this Mac', detail: 'Local Ollama model' },
]

function HostedAISettings({
  provider,
  connection,
  changed,
  busy,
  wait,
}: {
  provider: 'ollama_cloud' | 'openai'
  connection: Connection | null
  changed: (value: Connection) => void
  busy: boolean
  wait: (busy: boolean) => void
}) {
  const ollama = provider === 'ollama_cloud'
  const endpoint = ollama ? '/ai/ollama-cloud' : '/openai'
  const defaultModel = ollama ? 'gpt-oss:20b' : 'gpt-4.1-mini'
  const [key, setKey] = useState(''),
    [model, setModel] = useState(connection?.model || defaultModel),
    [remember, setRemember] = useState(connection?.storage === 'macOS Keychain'),
    [error, fail] = useState(''),
    [note, setNote] = useState(''),
    [candidateModels, setCandidateModels] = useState<{ id: string; label: string }[] | null>(null),
    [discovering, discover] = useState(false)
  const models = useResource<{ models: { id: string; label: string }[] }>(
    endpoint + '/models' + (!ollama && connection?.verified ? '?discover=true' : ''),
  )
  useEffect(() => {
    setModel(connection?.model || defaultModel)
    setRemember(connection?.storage === 'macOS Keychain')
  }, [connection?.model, connection?.storage, defaultModel])
  async function test() {
    wait(true)
    fail('')
    setNote('')
    try {
      const v = await api<Connection>(endpoint, 'PUT', {
        model,
        remember,
        ...(key.trim() ? { key: key.trim() } : {}),
      })
      setKey('')
      setCandidateModels(null)
      models.reload()
      changed(v)
      setNote(
        ollama
          ? ''
          : 'Generation verified with ' +
              v.model +
              '. You can generate scores and use the assistant.',
      )
    } catch (e) {
      fail(errorText(e))
    } finally {
      wait(false)
    }
  }
  const available = candidateModels || models.data?.models || []
  const options = available.some((item) => item.id === model)
    ? available
    : [{ id: model, label: model }, ...available]
  const changedCredentials = !!key.trim() || model !== connection?.model
  const dirty = changedCredentials || remember !== (connection?.storage === 'macOS Keychain')
  return (
    <>
      <div className="hosted-setup">
        <p>
          Research automatically requests a price prediction when you select a ticker or forecast
          period. These requests use your selected model and its account limits.
        </p>
        {ollama ? (
          <p>
            Paste your ollama.com key to run the model and search the web through Ollama Cloud.{' '}
            <SourceLink url="https://ollama.com/settings/keys">Get an Ollama API key</SourceLink>
          </p>
        ) : (
          <p>
            Your API project pays for the connection test, scores, forecasts and chat.{' '}
            <SourceLink url="https://platform.openai.com/api-keys">
              Get an OpenAI API key
            </SourceLink>
          </p>
        )}
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void test()
        }}
      >
        <Field name={ollama ? 'Ollama website API key' : 'OpenAI API key'}>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={busy || discovering}
            value={key}
            onChange={(e) => {
              setKey(e.target.value)
              setCandidateModels(null)
              setNote('')
              fail('')
            }}
            placeholder={
              connection?.configured ? 'Saved key · paste to replace' : 'Paste your API key'
            }
            required={!connection?.configured}
          />
        </Field>
        {ollama && (
          <small>
            Ollama bills hosted generation per token, including the test. Individual accounts
            include a free web search allowance.{' '}
            <SourceLink url="https://ollama.com/pricing">Cloud pricing</SourceLink> ·{' '}
            <SourceLink url="https://ollama.com/blog/web-search">Search limits</SourceLink>
          </small>
        )}
        <Field name="API model">
          <select
            value={model}
            disabled={busy || discovering}
            onChange={(e) => {
              setModel(e.target.value)
              setNote('')
              fail('')
            }}
          >
            {options.map((m) => (
              <option value={m.id} key={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        {!ollama && key.trim() && (
          <button
            className="text-btn model-lookup"
            type="button"
            disabled={busy || discovering}
            onClick={async () => {
              discover(true)
              fail('')
              try {
                const v = await api<{
                  models: { id: string; label: string }[]
                  source: string
                }>(endpoint + '/models', 'POST', { key: key.trim() })
                setCandidateModels(v.models)
                if (!v.models.some((m) => m.id === model) && v.models[0]) setModel(v.models[0].id)
                setNote(
                  v.source === 'project'
                    ? 'Loaded models available to this project. Connect to test generation.'
                    : 'Model discovery is restricted. Choose a suggested model and test generation.',
                )
              } catch (e) {
                fail(errorText(e))
              } finally {
                discover(false)
              }
            }}
          >
            {discovering ? 'Finding models…' : 'Find models for this key'}
          </button>
        )}
        <label className="check">
          <input
            type="checkbox"
            disabled={busy || discovering}
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />{' '}
          Remember key in macOS Keychain
        </label>
        <small>
          {remember
            ? 'Available after you restart StockReplay.'
            : 'Session storage lasts until the local service stops.'}
        </small>
        <div className="inline">
          <button
            className="btn primary"
            disabled={busy || discovering || (!connection?.configured && !key.trim())}
          >
            {busy ? (
              <Busy text={ollama ? 'Checking model and web search' : 'Testing generation'} />
            ) : dirty || !connection?.configured ? (
              'Connect & test'
            ) : ollama ? (
              'Test model and web search'
            ) : (
              'Test generation'
            )}
          </button>
          {connection?.configured && (
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={async () => {
                wait(true)
                try {
                  changed(await api<Connection>(endpoint, 'DELETE'))
                  setKey('')
                  setNote('Key removed.')
                  fail('')
                } catch (e) {
                  fail(errorText(e))
                } finally {
                  wait(false)
                }
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      </form>
      {connection?.configured && changedCredentials ? (
        <small role="status">Connect &amp; test to verify this key and model.</small>
      ) : ollama && connection?.configured ? (
        <div className="hosted-checks" role="status">
          <p>
            <strong>Model generation</strong> · {connection.verified ? 'Verified' : 'Unverified'} ·{' '}
            {connection.model}
          </p>
          {connection.generation_detail && <small>{connection.generation_detail}</small>}
          <p>
            <strong>Web search</strong> ·{' '}
            {connection.web_search?.verified ? 'Verified' : 'Unverified'}
          </p>
          {connection.web_search?.detail && <small>{connection.web_search.detail}</small>}
        </div>
      ) : (
        connection?.configured && (
          <p className="connection-state">
            {connection.verified ? <Check size={15} /> : <KeyRound size={15} />}{' '}
            {connection.verified ? 'Verified for generation' : 'Saved key · test to verify'} ·{' '}
            {connection.model}
          </p>
        )
      )}
      {note && <p role="status">{note}</p>}
      <ErrorBox
        text={
          error ||
          (models.error
            ? 'Model list unavailable. You can still test the selected model. ' + models.error
            : '')
        }
      />
      <small>
        {ollama
          ? 'The test sends one public search and a small generation request to Ollama.'
          : 'The test sends a small generation request.'}{' '}
        Research sends public evidence. Chat sends the messages you enter. Your saved statements and
        positions stay on this Mac.
      </small>
    </>
  )
}

export function Settings({
  prefs,
  save,
  connection,
  changed,
}: {
  prefs: Preferences
  save: (p: Partial<Preferences>) => Promise<void>
  connection: Connection | null
  changed: (c: Connection) => void
}) {
  const [home, setHome] = useState(prefs.home_symbol)
  const [busy, wait] = useState(false)
  const [switching, setSwitching] = useState<AIProvider | null>(null)
  const [error, fail] = useState('')
  const [switchError, setSwitchError] = useState('')
  const provider = connection?.provider ?? 'ollama'
  const selected = switching ?? provider
  useEffect(() => setHome(prefs.home_symbol), [prefs.home_symbol])
  async function switchProvider(next: AIProvider) {
    setSwitching(next)
    setSwitchError('')
    try {
      changed(await api<Connection>('/ai', 'PATCH', { provider: next }))
    } catch (e) {
      setSwitchError(errorText(e))
    } finally {
      setSwitching(null)
    }
  }
  async function update(p: Partial<Preferences>) {
    try {
      await save(p)
      fail('')
    } catch (e) {
      fail(errorText(e))
    }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
        </div>
      </div>
      <div className="settings-grid">
        <section className="panel settings-card">
          <h2>
            <KeyRound size={18} /> AI connection
          </h2>
          <fieldset className="ai-provider-picker" disabled={busy || !!switching}>
            <legend>AI provider</legend>
            <div className="ai-provider-options">
              {providers.map(({ id, title, detail }) => (
                <label key={id} className={selected === id ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="ai-provider"
                    value={id}
                    checked={selected === id}
                    onChange={() => void switchProvider(id)}
                  />
                  <span>
                    <strong>{title}</strong>
                    <small>{detail}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <ErrorBox text={switchError} />
          {switching ? (
            <Busy text="Switching provider" />
          ) : provider === 'ollama' ? (
            <>
              <LocalModelConnection
                connection={connection}
                changed={changed}
                busy={busy}
                wait={wait}
              />
              <OllamaSearchKey busy={busy} wait={wait} />
            </>
          ) : (
            <HostedAISettings
              key={provider}
              provider={provider}
              connection={connection}
              changed={changed}
              busy={busy}
              wait={wait}
            />
          )}
        </section>
        <div className="stack">
          <ErrorBox text={error} />
          <section className="panel settings-card">
            <h2>
              <Palette size={18} /> Appearance
            </h2>
            <h3>Display mode</h3>
            <div className="chips">
              {(['system', 'light', 'dark'] as const).map((m, i) => {
                const Icon = [Monitor, Sun, Moon][i]
                return (
                  <button
                    key={m}
                    aria-pressed={prefs.appearance === m}
                    className={prefs.appearance === m ? 'selected' : ''}
                    onClick={() => void update({ appearance: m })}
                  >
                    <Icon size={14} />
                    {m}
                  </button>
                )
              })}
            </div>
            <h3>Color theme</h3>
            <div className="swatches">
              {(['forest', 'ocean', 'violet', 'amber'] as const).map((c) => (
                <button
                  key={c}
                  aria-pressed={c === prefs.accent}
                  onClick={() => void update({ accent: c })}
                >
                  <i data-color={c} />
                  {c}
                  {c === prefs.accent && <Check size={14} />}
                </button>
              ))}
            </div>
          </section>
          <section className="panel settings-card">
            <h2>
              <SlidersHorizontal size={18} /> Research preferences
            </h2>
            <label className="setting-toggle">
              <span>
                <strong>Advanced trader tools</strong>
                <small>Candlesticks, indicators, price levels, trend lines and boxes.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={prefs.advanced}
                onChange={(e) => void update({ advanced: e.target.checked })}
              />
            </label>
            <Field name="Open Research with">
              <select
                value={prefs.home_mode}
                onChange={(e) =>
                  void update({ home_mode: e.target.value as Preferences['home_mode'] })
                }
              >
                <option value="portfolio">Follow my holdings</option>
                <option value="ticker">My saved ticker</option>
              </select>
            </Field>
            <small>
              Follow my holdings opens a ticker from your local portfolio, or the SPY market
              benchmark when no holding has a researchable ticker.
            </small>
            <form
              className="desk-toolbar"
              onSubmit={(e) => {
                e.preventDefault()
                if (tickerPattern.test(home))
                  void update({ home_mode: 'ticker', home_symbol: home })
              }}
            >
              <Field name="Starting stock">
                <input
                  value={home}
                  onChange={(e) => setHome(e.target.value.toUpperCase())}
                  required
                  maxLength={20}
                />
              </Field>
              <button
                className="btn"
                disabled={
                  !tickerPattern.test(home) ||
                  (prefs.home_symbol === home && prefs.home_mode === 'ticker')
                }
              >
                Save ticker
              </button>
            </form>
          </section>
        </div>
      </div>
      <footer className="credits">
        Advanced charts use{' '}
        <SourceLink url="https://www.tradingview.com/lightweight-charts/">
          TradingView Lightweight Charts™
        </SourceLink>
        .
      </footer>
    </>
  )
}
