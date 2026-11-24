import { OpenAISettings } from './ResearchDesk'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Check,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileJson,
  FolderOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  api,
  type AIStatus,
  type Config,
  type Result,
  type Snapshot,
  type LibraryItem,
  type Metrics,
  errorText,
  pct,
  shortDate,
  sourceName,
} from './types'
import { Modal, Field, ErrorBox, Empty, Busy } from './ui'
import { SymbolPicker } from './Builder'

export function Exports({ r, saved, close }: { r: Result; saved?: string; close: () => void }) {
  const formats = [
    ['html', 'HTML research report', 'Self-contained report with chart and every event.'],
    [
      'bundle',
      'Reproducible experiment',
      'Configuration and exact market snapshots for offline replay.',
    ],
    ['csv', 'Event results CSV', 'Signal dates, execution prices, net and benchmark returns.'],
    ['config', 'Configuration JSON', 'Editable parameters for a new experiment.'],
  ]
  return (
    <Modal title="Export research" close={close}>
      <div className="modal-body export-list">
        {formats.map(([id, n, d]) => (
          <a
            key={id}
            className="export-item"
            href={'/api/runs/' + r.id + '/export/' + id + (saved ? '?saved=' + saved : '')}
            download
          >
            <FileJson size={20} />
            <div>
              <b>{n}</b>
              <small>{d}</small>
            </div>
            <Download size={16} />
          </a>
        ))}
      </div>
    </Modal>
  )
}
export function SaveForm({
  r,
  item,
  close,
  done,
}: {
  r?: Result
  item?: LibraryItem
  close: () => void
  done: (id: string) => void
}) {
  const [name, setName] = useState(item?.name || r?.config.name || ''),
    [notes, setNotes] = useState(item?.notes || ''),
    [busy, setBusy] = useState(false),
    [err, setErr] = useState('')
  async function save(newCopy = false) {
    setBusy(true)
    setErr('')
    try {
      const s = await api<{ id: string }>(
        item && !newCopy ? '/library/' + item.id : '/library',
        item && !newCopy ? 'PATCH' : 'POST',
        item && !newCopy ? { name, notes, run_id: r?.id } : { run_id: r!.id, name, notes },
      )
      done(s.id)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={
        item && r && item.run_id !== r.id
          ? 'Update saved experiment'
          : item
            ? 'Edit saved research'
            : 'Save experiment'
      }
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save((e.nativeEvent as SubmitEvent).submitter?.getAttribute('name') === 'copy')
        }}
      >
        <div className="modal-body stack">
          <Field name="Experiment name">
            <input
              autoFocus
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field name="Research notes">
            <textarea
              rows={5}
              maxLength={12000}
              value={notes}
              placeholder="Record an observation or follow-up question"
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
          <ErrorBox text={err} />
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          {r && item && item.run_id !== r.id && (
            <button type="submit" name="copy" className="btn" disabled={busy}>
              Save as new
            </button>
          )}
          <button className="btn primary" disabled={busy}>
            {busy ? (
              <Busy text="Saving" />
            ) : (
              <>
                <Check size={15} />
                Save research
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function Library({
  items,
  refresh,
  open,
  create,
  imported,
  configure,
}: {
  items: LibraryItem[]
  refresh: () => Promise<void>
  open: (i: LibraryItem) => void
  create: () => void
  imported: (r: Result) => void
  configure: (c: Config) => void
}) {
  const [q, setQ] = useState(''),
    [edit, setEdit] = useState<LibraryItem | null>(null),
    [del, setDel] = useState<LibraryItem | null>(null),
    [err, setErr] = useState(''),
    [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  async function action(fn: () => Promise<unknown>) {
    setErr('')
    setBusy(true)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  async function restore(f: File) {
    if (f.size > 60000000) throw Error('Choose an experiment file under 60 MB.')
    const doc = JSON.parse(await f.text())
    if (doc?.format) {
      const value = await api<Result>('/import', 'POST', doc)
      imported(value)
    } else {
      const result = await api<Config>('/validate', 'POST', doc)
      configure(result)
    }
  }
  const filtered = items.filter((i) =>
    (i.name + ' ' + i.notes).toLowerCase().includes(q.toLowerCase()),
  )
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Research library</h1>
          <p>Saved experiments, pinned datasets, and research notes.</p>
        </div>
        <button className="btn" onClick={() => file.current?.click()} disabled={busy}>
          <Upload size={15} />
          Import experiment
        </button>
        <input
          ref={file}
          className="sr-only"
          type="file"
          accept=".json"
          aria-label="Import experiment file"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void action(() => restore(f))
          }}
        />
      </div>
      <ErrorBox text={err} />
      <section className="panel">
        <div className="panel-head">
          <div className="title-icon">
            <FolderOpen size={17} />
            <h3>Saved experiments</h3>
            <em>{items.length}</em>
          </div>
          <label className="search">
            <Search size={15} />
            <input
              aria-label="Search library"
              placeholder="Search library"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
        </div>
        {filtered.length ? (
          filtered.map((i) => (
            <div className="library-row" key={i.id}>
              <button className="library-open" onClick={() => open(i)}>
                <strong>{i.name}</strong>
                <span>
                  {i.notes || 'No notes'} · {shortDate(i.updated)}
                </span>
              </button>
              <div className="inline">
                <button
                  className="icon-btn"
                  title="Edit name and notes"
                  aria-label={'Edit ' + i.name}
                  onClick={() => setEdit(i)}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon-btn"
                  title="Duplicate experiment"
                  aria-label={'Duplicate ' + i.name}
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      api('/library', 'POST', {
                        run_id: i.run_id,
                        name: (i.name + ' (copy)').slice(0, 100),
                        notes: i.notes,
                      }),
                    )
                  }
                >
                  <Copy size={15} />
                </button>
                <button
                  className="icon-btn"
                  title="Delete experiment"
                  aria-label={'Delete ' + i.name}
                  onClick={() => setDel(i)}
                >
                  <Trash2 size={15} />
                </button>
                <button className="icon-btn" title="Open experiment" onClick={() => open(i)}>
                  <ArrowRight size={16} />
                </button>
              </div>
            </div>
          ))
        ) : (
          <Empty
            title={q ? 'No matching experiments' : 'Your library is empty'}
            body={
              q
                ? 'Try a different name or note.'
                : 'Save a completed experiment from the workbench to keep its inputs, evidence, and notes.'
            }
          >
            <button className="btn" onClick={create}>
              <Plus size={14} />
              New experiment
            </button>
          </Empty>
        )}
      </section>
      {edit && (
        <SaveForm
          item={edit}
          close={() => setEdit(null)}
          done={() => {
            setEdit(null)
            void refresh()
          }}
        />
      )}
      {del && (
        <Modal title="Delete saved experiment?" close={() => setDel(null)}>
          <div className="modal-body">
            <p>Remove “{del.name}” and its library notes?</p>
          </div>
          <div className="modal-foot">
            <button className="btn" onClick={() => setDel(null)}>
              Cancel
            </button>
            <button
              className="btn danger"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api('/library/' + del.id, 'DELETE')
                  setDel(null)
                })
              }
            >
              Delete experiment
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

type Side = { run: string; config: Config; metrics: Metrics }
type Comparison = { id: string; name: string; created: string; payload: Side[] }
function Compared({ sides }: { sides: Side[] }) {
  const values = [
    ['Source', (s: Side) => sourceName[s.config.source]],
    ['Period', (s: Side) => s.config.start + ' — ' + s.config.end],
    ['Type', (s: Side) => s.config.kind],
    ['Assets', (s: Side) => s.config.tickers.join(', ')],
    ['Benchmark', (s: Side) => s.config.benchmark],
    ['Holding period', (s: Side) => s.config.holding + ' sessions'],
    ['Observations', (s: Side) => String(s.metrics.count)],
    ['Mean net return', (s: Side) => pct(s.metrics.mean)],
    ['Objective win rate', (s: Side) => pct(s.metrics.win_rate, false, 1)],
    ['Excess return', (s: Side) => pct(s.metrics.excess)],
    ['Portfolio return', (s: Side) => pct(s.metrics.total_return)],
  ] as const
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Measure</th>
            {sides.map((s, i) => (
              <th key={i}>{s.config.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {values.map(([title, get]) => (
            <tr key={title}>
              <th>{title}</th>
              {sides.map((s, i) => (
                <td key={i}>{get(s)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
export function Compare({ items }: { items: LibraryItem[] }) {
  const [left, setLeft] = useState(''),
    [right, setRight] = useState(''),
    [name, setName] = useState('Comparison report'),
    [reports, set] = useState<Comparison[]>([]),
    [view, setView] = useState<Comparison | null>(null),
    [err, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const load = () =>
    api<Comparison[]>('/comparisons')
      .then(set)
      .catch((e) => setError(errorText(e)))
  useEffect(() => {
    void load()
  }, [])
  const choices = items.filter((v, i, a) => a.findIndex((s) => s.run_id === v.run_id) === i)
  async function save() {
    setBusy(true)
    setError('')
    try {
      const v = await api<Comparison>('/comparisons', 'POST', {
        left,
        right,
        name,
      })
      setView({ ...v, name })
      await load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Compare experiments</h1>
          <p>Place two saved runs side by side and retain a comparison report.</p>
        </div>
      </div>
      <section className="panel form-panel">
        {choices.length < 2 ? (
          <Empty
            title="Two distinct saved runs are needed"
            body="Run and save two experiments from the workbench to compare their evidence."
          />
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <div className="field-grid">
              {[
                [left, setLeft, 'First experiment'],
                [right, setRight, 'Second experiment'],
              ].map(([v, fn, n], i) => (
                <Field name={n as string} key={i}>
                  <select
                    required
                    value={v as string}
                    onChange={(e) => (fn as (s: string) => void)(e.target.value)}
                  >
                    <option value="">Choose a run</option>
                    {choices.map((x) => (
                      <option key={x.id} value={x.run_id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
            <Field name="Report name">
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <button className="btn primary fit" disabled={busy || left === right}>
              Save comparison
            </button>
          </form>
        )}
        <ErrorBox text={err} />
      </section>
      {view && (
        <section className="panel form-panel">
          <h3>{view.name}</h3>
          <Compared sides={view.payload} />
        </section>
      )}
      <section className="panel form-panel">
        <h3>Saved comparisons</h3>
        {reports.length ? (
          reports.map((r) => (
            <button className="report-link" key={r.id} onClick={() => setView(r)}>
              {r.name}
              <ArrowRight size={15} />
            </button>
          ))
        ) : (
          <p className="muted">No comparison reports saved.</p>
        )}
      </section>
    </>
  )
}

export function DataPage({ defaults }: { defaults: Config }) {
  const [catalog, set] = useState<Snapshot[]>([]),
    [config, setConfig] = useState<Config>({ ...defaults, source: 'yahoo' }),
    [ticker, setTicker] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [err, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [message, setMessage] = useState(''),
    [filter, setFilter] = useState('all')
  const load = () => api<Snapshot[]>('/data').then(set)
  useEffect(() => {
    void load().catch((e) => setError(errorText(e)))
  }, [])
  async function act(text: string, fn: () => Promise<unknown>, success: string) {
    setBusy(text)
    setError('')
    setMessage('')
    try {
      await fn()
      await load()
      setMessage(success)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy('')
    }
  }
  const filtered = catalog.filter((x) => filter === 'all' || x.source === filter)
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Market data</h1>
          <p>Acquire historical prices and manage the snapshots available offline.</p>
        </div>
      </div>
      <div className="two-panels">
        <section className="panel form-panel">
          <div className="title-icon">
            <Download size={17} />
            <h3>Download market data</h3>
          </div>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault()
              void act(
                'Downloading',
                () => api('/data/fetch', 'POST', { config }),
                'Yahoo Finance snapshots are available offline.',
              )
            }}
          >
            <SymbolPicker
              value={config.tickers}
              change={(tickers) => setConfig({ ...config, tickers })}
            />
            <div className="field-grid">
              <Field name="From">
                <input
                  type="date"
                  required
                  value={config.start}
                  onChange={(e) => setConfig({ ...config, start: e.target.value })}
                />
              </Field>
              <Field name="Through">
                <input
                  type="date"
                  required
                  value={config.end}
                  onChange={(e) => setConfig({ ...config, end: e.target.value })}
                />
              </Field>
            </div>
            <Field name="Benchmark">
              <input
                required
                value={config.benchmark}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    benchmark: e.target.value.toUpperCase(),
                  })
                }
              />
            </Field>
            <button className="btn primary fit" disabled={!!busy}>
              {busy === 'Downloading' ? (
                <Busy text={busy} />
              ) : (
                <>
                  <RefreshCw size={14} />
                  Fetch from Yahoo
                </>
              )}
            </button>
          </form>
        </section>
        <section className="panel form-panel">
          <div className="title-icon">
            <Upload size={17} />
            <h3>Import daily CSV</h3>
          </div>
          <p className="helper">
            Required columns are Date, Open, High, Low, Close, Adj Close, and Volume. Dividends and
            Stock Splits are optional.
          </p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault()
              if (file)
                void act(
                  'Importing',
                  async () => {
                    if (file.size > 6000000) throw Error('Choose a CSV under 6 MB.')
                    return api('/data/import', 'POST', {
                      ticker,
                      csv: await file.text(),
                    })
                  },
                  'CSV validated and cached.',
                )
            }}
          >
            <Field name="CSV ticker">
              <input
                required
                placeholder="e.g. AAPL"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
              />
            </Field>
            <Field name="Daily price file">
              <input
                type="file"
                required
                accept=".csv"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </Field>
            <button className="btn fit" disabled={!!busy}>
              {busy === 'Importing' ? (
                <Busy text={busy} />
              ) : (
                <>
                  <Upload size={14} />
                  Import CSV
                </>
              )}
            </button>
          </form>
        </section>
      </div>
      <ErrorBox text={err} />
      {message && (
        <p className="callout" role="status">
          {message}
        </p>
      )}
      <section className="panel">
        <div className="panel-head">
          <div className="title-icon">
            <Database size={17} />
            <h3>Data snapshots</h3>
          </div>
          <select
            aria-label="Filter data source"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All sources</option>
            {Object.entries(sourceName).map(([v, n]) => (
              <option key={v} value={v}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {['Asset', 'Source', 'Coverage', 'Sessions', 'Last fetched (UTC)', ''].map(
                  (s, i) => (
                    <th key={i}>{s}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.map((x) => (
                <tr key={x.id}>
                  <td>
                    <span className="ticker">{x.ticker}</span>
                  </td>
                  <td>{sourceName[x.source]}</td>
                  <td>
                    {x.first} — {x.last}
                  </td>
                  <td>{x.rows}</td>
                  <td>{x.fetched.slice(0, 16).replace('T', ' ')}</td>
                  <td>
                    <a
                      aria-label={'Export ' + x.ticker + ' CSV'}
                      href={'/api/data/' + x.id + '/csv'}
                      download
                    >
                      <Download size={15} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <Empty
            title="No snapshots"
            body="Fetch a symbol or import a CSV to add data from this source."
          />
        )}
      </section>
    </>
  )
}
export function SettingsPage({ ai, update }: { ai: AIStatus; update: (a: AIStatus) => void }) {
  const [model, setModel] = useState(ai.model),
    [err, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [msg, setStatusMessage] = useState('')
  async function act(save: boolean) {
    setBusy(true)
    setError('')
    setStatusMessage('')
    try {
      const result = await api<AIStatus>(
        save ? '/settings' : '/ai',
        save ? 'PUT' : 'GET',
        save ? { model } : undefined,
      )
      update(result)
      setStatusMessage(save ? 'Model preference saved.' : 'Connection checked.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>AI and data settings</h1>
          <p>Connect OpenAI for market recommendations and manage local Ollama interpretation.</p>
        </div>
      </div>
      <OpenAISettings />
      <section className="panel form-panel">
        <div className="panel-head flush">
          <div className="title-icon">
            <Database size={17} />
            <h3>Ollama connection</h3>
          </div>
          <span className={'status ' + (ai.ready ? 'ready' : '')}>
            <i />
            {ai.ready ? 'Model ready' : ai.online ? 'Model unavailable' : 'Offline'}
          </span>
        </div>
        <div className="compact-row">
          <span>Local endpoint</span>
          <b>127.0.0.1:11434</b>
        </div>
        <div className="compact-row">
          <span>Installed models</span>
          <b>{ai.models.join(', ') || 'None detected'}</b>
        </div>
        <form
          className="stack settings-form"
          onSubmit={(e) => {
            e.preventDefault()
            void act(true)
          }}
        >
          <Field name="Model name">
            <input
              required
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list="models"
            />
            <datalist id="models">
              {ai.models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </datalist>
          </Field>
          <div className="inline wrap">
            <button className="btn primary" disabled={busy}>
              Save model
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void act(false)}>
              <RefreshCw size={14} />
              Check connection
            </button>
          </div>
        </form>
        {!ai.ready && (
          <p className="helper">
            Run <code>./setup.sh</code> to install the selected local model, then check the
            connection. The builder is available offline.
          </p>
        )}
        {msg && (
          <p className="positive" role="status">
            {msg}
          </p>
        )}
        <ErrorBox text={err} />
      </section>
      <section className="panel form-panel">
        <h3>Data attribution</h3>
        <p className="helper">
          Prices come from Yahoo Finance. Research uses public news and dated ratings from Yahoo
          Finance, Nasdaq, Stock Analysis and Federal Reserve releases. Candlestick rendering uses
          TradingView Lightweight Charts™. Copyright © 2025 TradingView, Inc.
        </p>
        <a
          className="text-btn"
          href="https://tradingview.github.io/lightweight-charts/"
          target="_blank"
          rel="noreferrer"
        >
          Lightweight Charts <ExternalLink size={13} />
        </a>
      </section>
    </>
  )
}
