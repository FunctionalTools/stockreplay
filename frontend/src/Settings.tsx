import { useEffect, useState } from 'react'
import { Check, KeyRound, Monitor, Moon, Palette, SlidersHorizontal, Sun } from 'lucide-react'
import { api, errorText } from './types'
import { useResource, SourceLink } from './deskCommon'
import { Busy, ErrorBox, Field } from './ui'
import { type Preferences, type Connection, tickerPattern } from './workspace'
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
  const [key, setKey] = useState(''),
    [model, setModel] = useState(connection?.model || 'gpt-4.1-mini'),
    [remember, setRemember] = useState(connection?.storage === 'macOS Keychain'),
    [busy, wait] = useState(false),
    [error, fail] = useState(''),
    [note, setNote] = useState(''),
    [candidateModels, setCandidateModels] = useState<{ id: string; label: string }[] | null>(null),
    [discovering, discover] = useState(false),
    [home, setHome] = useState(prefs.home_symbol)
  const models = useResource<{ models: { id: string; label: string }[] }>(
    '/openai/models' + (connection?.verified ? '?discover=true' : ''),
  )
  useEffect(() => {
    setModel(connection?.model || 'gpt-4.1-mini')
    setRemember(connection?.storage === 'macOS Keychain')
  }, [connection?.model, connection?.storage])
  useEffect(() => setHome(prefs.home_symbol), [prefs.home_symbol])
  async function test() {
    wait(true)
    fail('')
    setNote('')
    try {
      const v = await api<Connection>('/openai', 'PUT', {
        model,
        remember,
        ...(key.trim() ? { key: key.trim() } : {}),
      })
      setKey('')
      setCandidateModels(null)
      models.reload()
      changed(v)
      setNote(
        'Generation verified with ' + v.model + '. You can generate scores and use the assistant.',
      )
    } catch (e) {
      fail(errorText(e))
    } finally {
      wait(false)
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
  const dirty =
    key.trim() ||
    model !== connection?.model ||
    remember !== (connection?.storage === 'macOS Keychain')
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
            <KeyRound size={18} /> OpenAI connection
          </h2>
          <p>StockReplay uses your API project to generate stock scores and power the assistant.</p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault()
              void test()
            }}
          >
            <Field name="OpenAI API key">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value)
                  setCandidateModels(null)
                  setNote('')
                }}
                placeholder={
                  connection?.configured ? 'Saved key · paste to replace' : 'Paste your API key'
                }
                required={!connection?.configured}
              />
            </Field>
            <Field name="API model">
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {(candidateModels || models.data?.models || [{ id: model, label: model }]).map(
                  (m) => (
                    <option value={m.id} key={m.id}>
                      {m.label}
                    </option>
                  ),
                )}
              </select>
            </Field>
            {key.trim() && (
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
                    }>('/openai/models', 'POST', { key: key.trim() })
                    setCandidateModels(v.models)
                    if (!v.models.some((m) => m.id === model) && v.models[0])
                      setModel(v.models[0].id)
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
                  <Busy text="Testing generation" />
                ) : dirty || !connection?.configured ? (
                  'Connect & test'
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
                      changed(await api<Connection>('/openai', 'DELETE'))
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
          {connection?.configured && (
            <p className="connection-state">
              {connection.verified ? <Check size={15} /> : <KeyRound size={15} />}{' '}
              {connection.verified ? 'Verified for generation' : 'Saved key · test to verify'} ·{' '}
              {connection.model}
            </p>
          )}
          {note && <p role="status">{note}</p>}
          <ErrorBox text={error || models.error} />
          <small>
            The test sends a small generation request. Research sends public evidence. Chat sends
            the messages you enter. Your saved statements and positions stay on this Mac.
          </small>
        </section>
        <div className="stack">
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
            <form
              className="desk-toolbar"
              onSubmit={(e) => {
                e.preventDefault()
                if (tickerPattern.test(home)) void update({ home_symbol: home })
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
                disabled={!tickerPattern.test(home) || prefs.home_symbol === home}
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
