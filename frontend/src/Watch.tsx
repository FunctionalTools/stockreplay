import { useEffect, useState, useRef, type FormEvent } from 'react'
import { Bell, Plus, Star, Trash2 } from 'lucide-react'
import { api, errorText, pct } from './types'
import { Field, Modal, ErrorBox, Empty } from './ui'
import { PageHead, useResource, PacketNote, fmt, type Packet, type Navigate } from './deskCommon'
type List = { id: string; name: string; symbols: string[] }
type Quote = {
  price: number
  currency: string | null
  time: number
  previous: number | null
  url: string
}
type Alert = {
  id: string
  symbol: string
  direction: 'above' | 'below'
  threshold: number
  triggered: string | null
  price: number | null
  observed: number | null
}
function QuoteRow({
  symbol,
  version,
  go,
  remove,
}: {
  symbol: string
  version: number
  go: Navigate
  remove: () => void
}) {
  const q = useResource<Packet<Quote>>(
      '/desk/quote/' +
        encodeURIComponent(symbol) +
        (version ? '?refresh=true&request=' + version : ''),
    ),
    p = q.data?.data
  return (
    <tr>
      <td>
        <button className="text-btn ticker" onClick={() => go('Research', symbol)}>
          {symbol}
        </button>
      </td>
      <td>{p ? fmt(p.price) + ' ' + (p.currency || '') : q.loading ? 'Loading…' : '—'}</td>
      <td>{p?.previous ? pct(100 * (p.price / p.previous - 1)) : '—'}</td>
      <td>
        {p ? new Date(p.time * 1000).toLocaleString() : '—'}
        {q.data && <PacketNote p={q.data} />}
        <ErrorBox text={q.error} />
      </td>
      <td>
        <div className="inline">
          <button className="text-btn" onClick={() => go('Research', symbol)}>
            Research
          </button>
          <button
            className="icon-btn"
            aria-label={'Remove ' + symbol + ' from watchlist'}
            onClick={remove}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </td>
    </tr>
  )
}
export function Watchlists({
  go,
  symbol,
  importOnOpen = false,
}: {
  go: Navigate
  symbol: string
  importOnOpen?: boolean
}) {
  const file = useRef<HTMLInputElement>(null),
    [importNote, report] = useState(''),
    [importOpen, setImportOpen] = useState(importOnOpen)
  useEffect(() => setImportOpen(importOnOpen), [importOnOpen])
  const ls = useResource<List[]>('/watchlists'),
    alerts = useResource<Alert[]>('/alerts'),
    [id, setId] = useState(''),
    [name, setName] = useState(''),
    [rename, setRename] = useState(''),
    [ticker, setTicker] = useState(''),
    [error, setErr] = useState(''),
    [version, refresh] = useState(0),
    [deleting, del] = useState(false),
    [busy, wait] = useState(false)
  const list = ls.data?.find((l) => l.id === id) || ls.data?.[0]
  useEffect(() => setRename(list?.name || ''), [list?.name])
  const reloadAlerts = alerts.reload
  useEffect(() => {
    const timer = setInterval(() => reloadAlerts(), 30000)
    return () => clearInterval(timer)
  }, [reloadAlerts])
  async function mutate(path: string, method: string, body?: unknown) {
    setErr('')
    try {
      const result = await api<{ id?: string }>(path, method, body)
      if (path === '/watchlists' && result.id) setId(result.id)
      ls.reload()
      alerts.reload()
      setName('')
      setTicker('')
      del(false)
    } catch (e) {
      setErr(errorText(e))
    }
  }
  async function alert(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    await mutate('/alerts', 'POST', {
      symbol: f.get('symbol'),
      direction: f.get('direction'),
      threshold: Number(f.get('threshold')),
    })
  }
  return (
    <>
      <PageHead
        title="Watchlists"
        description="Track the stocks you follow and get alerts when they reach a price you choose."
      />
      <ErrorBox text={error || ls.error || alerts.error} />
      <section className="panel desk-card">
        <div className="desk-toolbar">
          <label className="field">
            <span>Watchlist</span>
            <select
              aria-label="Watchlist"
              value={list?.id || ''}
              onChange={(e) => setId(e.target.value)}
            >
              {ls.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void mutate('/watchlists', 'POST', { name })
            }}
          >
            <input
              aria-label="New watchlist name"
              placeholder="New watchlist name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="btn">
              <Plus size={14} />
              Create list
            </button>
          </form>
        </div>
        {list && (
          <>
            <div className="desk-toolbar">
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void mutate('/watchlists/' + list.id + '/symbols', 'POST', {
                    symbol: ticker,
                  })
                }}
              >
                <input
                  aria-label="Add watchlist symbol"
                  placeholder="Ticker symbol"
                  required
                  value={ticker}
                  onChange={(e) => setTicker(e.target.value.toUpperCase())}
                />
                <button className="btn primary">
                  <Star size={14} />
                  Add symbol
                </button>
              </form>
              <button
                className="btn"
                disabled={!list.symbols.length}
                onClick={() => refresh((n) => n + 1)}
              >
                Refresh quotes
              </button>
            </div>
            <div className="import-watch">
              <button className="text-btn" onClick={() => setImportOpen(!importOpen)}>
                Import symbols
              </button>
              {importOpen && (
                <div className="tip">
                  <label className="field">
                    <span>Watchlist CSV</span>
                    <input
                      ref={file}
                      type="file"
                      accept=".csv,.txt,text/csv,text/plain"
                      onChange={async (e) => {
                        const f = e.target.files?.[0]
                        if (!f) return
                        try {
                          if (f.size > 1000000) throw Error('Choose a file smaller than 1 MB.')
                          const result = await api<{ added: number; existing: number }>(
                            '/watchlists/' + list.id + '/import',
                            'POST',
                            { content: await f.text() },
                          )
                          report(
                            result.added + ' added, ' + result.existing + ' already on this list.',
                          )
                          ls.reload()
                          setErr('')
                        } catch (ex) {
                          setErr(errorText(ex))
                        } finally {
                          if (file.current) file.current.value = ''
                        }
                      }}
                    />
                  </label>
                  <small>Use a Symbol or Ticker column, or one ticker per line.</small>
                </div>
              )}
              {importNote && <p role="status">{importNote}</p>}
            </div>
            {list.symbols.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {[
                        'Ticker',
                        'Last price',
                        'Change vs previous session',
                        'Quote time',
                        'Actions',
                      ].map((s) => (
                        <th key={s}>{s}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {list.symbols.map((s) => (
                      <QuoteRow
                        key={s}
                        symbol={s}
                        version={version}
                        go={go}
                        remove={() =>
                          mutate(
                            '/watchlists/' + list.id + '/symbols/' + encodeURIComponent(s),
                            'DELETE',
                          )
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title="No symbols in this watchlist"
                body="Add a ticker above, import a list, or save a stock from Research."
              />
            )}
            <details>
              <summary>Manage this watchlist</summary>
              <form
                className="desk-toolbar"
                onSubmit={(e) => {
                  e.preventDefault()
                  void mutate('/watchlists/' + list.id, 'PATCH', {
                    name: rename,
                  })
                }}
              >
                <input
                  aria-label="Rename watchlist"
                  value={rename}
                  required
                  onChange={(e) => setRename(e.target.value)}
                />
                <button className="btn">Rename list</button>
                <button className="btn" type="button" onClick={() => del(true)}>
                  Delete list
                </button>
              </form>
            </details>
          </>
        )}
      </section>
      <details className="panel desk-card">
        <summary>
          <Bell size={16} /> Price alerts
        </summary>
        <p>
          StockReplay checks the latest available five-minute price approximately every two minutes
          while the service is running. Alerts display here when an observed price reaches the
          threshold. Prices can be delayed.
        </p>
        <form className="desk-toolbar" onSubmit={alert}>
          <Field name="Alert symbol">
            <input name="symbol" defaultValue={symbol} required />
          </Field>
          <Field name="Condition">
            <select name="direction">
              <option value="above">At or above</option>
              <option value="below">At or below</option>
            </select>
          </Field>
          <Field name="Threshold price">
            <input type="number" step="any" min="0.000001" name="threshold" required />
          </Field>
          <button className="btn primary">Create alert</button>
        </form>
        {alerts.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {['Ticker', 'Condition', 'Status', 'Observed price', 'Observation time', ''].map(
                    (s, i) => (
                      <th key={i}>{s}</th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {alerts.data.map((a) => (
                  <tr key={a.id}>
                    <td>{a.symbol}</td>
                    <td>
                      {a.direction} {fmt(a.threshold)}
                    </td>
                    <td>{a.triggered ? 'Triggered' : 'Watching'}</td>
                    <td>{fmt(a.price)}</td>
                    <td>
                      {a.observed
                        ? new Date(a.observed * 1000).toLocaleString()
                        : 'Awaiting new bar'}
                    </td>
                    <td>
                      <button
                        className="icon-btn"
                        aria-label={'Delete alert for ' + a.symbol}
                        onClick={() => mutate('/alerts/' + a.id, 'DELETE')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <small>No saved price alerts.</small>
        )}
        <button
          className="btn small"
          disabled={busy || !alerts.data?.length}
          onClick={async () => {
            wait(true)
            try {
              await api('/alerts/check', 'POST')
              alerts.reload()
            } catch (e) {
              setErr(errorText(e))
            } finally {
              wait(false)
            }
          }}
        >
          {busy ? 'Checking…' : 'Check alerts now'}
        </button>
      </details>
      {deleting && list && (
        <Modal title={'Delete ' + list.name + '?'} close={() => del(false)}>
          <div className="modal-body stack">
            <p>This removes the list and its ticker memberships from this Mac.</p>
            <button className="btn" onClick={() => del(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => mutate('/watchlists/' + list.id, 'DELETE')}
            >
              Delete watchlist
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
