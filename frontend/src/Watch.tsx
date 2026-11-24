import { useEffect, useState, type FormEvent } from 'react'
import { Bell, Plus, Star, Trash2 } from 'lucide-react'
import { api, errorText, pct } from './types'
import { Field, Modal, ErrorBox, Empty } from './ui'
import {
  PageHead,
  useResource,
  FetchState,
  PacketNote,
  fmt,
  when,
  SourceLink,
  type Packet,
  type Navigate,
} from './deskCommon'
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
        <button className="text-btn ticker" onClick={() => go('Charts', symbol)}>
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
          <button className="text-btn" onClick={() => go('Market research', symbol)}>
            Research
          </button>
          <button className="text-btn" onClick={() => go('Investor ratings', symbol)}>
            Ratings
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
export function Watchlists({ go, symbol }: { go: Navigate; symbol: string }) {
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
        description="Follow public tickers and monitor price thresholds while StockReplay is running."
      />
      <ErrorBox text={error || ls.error || alerts.error} />
      <section className="panel desk-card">
        <div className="desk-toolbar">
          <label className="field">
            <span>Watchlist</span>
            <select value={list?.id || ''} onChange={(e) => setId(e.target.value)}>
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
            <p className="helper">
              Quote requests send individual symbols to Yahoo Finance. List names and groupings stay
              on this Mac.
            </p>
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
                body="Add a ticker or save a result from the market screener."
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
      <section className="panel desk-card">
        <h3>
          <Bell size={16} />
          Price alerts
        </h3>
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
      </section>
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
type ScreenQuote = {
  symbol: string
  shortName: string | null
  longName: string | null
  regularMarketPrice: number | null
  regularMarketChangePercent: number | null
  regularMarketVolume: number | null
  marketCap: number | null
  regularMarketTime: number | null
  currency: string | null
  fullExchangeName: string | null
}
const screens: Record<string, string> = {
  most_actives: 'Most active',
  day_gainers: 'Day gainers',
  day_losers: 'Day losers',
  growth_technology_stocks: 'Growth technology',
  undervalued_large_caps: 'Undervalued large caps',
  aggressive_small_caps: 'Aggressive small caps',
}
export function Screener({ go }: { go: Navigate }) {
  const [screen, setScreen] = useState('most_actives'),
    [term, setTerm] = useState(''),
    [sort, setSort] = useState('regularMarketVolume'),
    [asc, setAsc] = useState(false),
    [min, setMin] = useState(''),
    [cap, setCap] = useState(''),
    [id, setId] = useState(''),
    [note, setNote] = useState('')
  const res = useResource<Packet<ScreenQuote[]>>('/desk/screener?screen_name=' + screen),
    lists = useResource<List[]>('/watchlists')
  const chosen = id || lists.data?.[0]?.id
  const rows = (res.data?.data || [])
    .filter(
      (v) =>
        (v.symbol + ' ' + v.shortName + ' ' + v.longName)
          .toLowerCase()
          .includes(term.toLowerCase()) &&
        (!min || (v.regularMarketPrice != null && v.regularMarketPrice >= Number(min))) &&
        (!cap || (v.marketCap != null && v.marketCap >= Number(cap) * 1e9)),
    )
    .sort((a, b) => {
      const field = sort as keyof ScreenQuote,
        x = a[field],
        y = b[field]
      if (x == null) return y == null ? 0 : 1
      if (y == null) return -1
      return (asc ? 1 : -1) * (typeof x === 'string' ? x.localeCompare(String(y)) : x - Number(y))
    })
  return (
    <>
      <PageHead
        title="Market screener"
        description="Screen up to 100 current quotes from each Yahoo Finance market screen."
      />
      <section className="panel desk-card">
        <div className="desk-toolbar">
          <Field name="Market screen">
            <select value={screen} onChange={(e) => setScreen(e.target.value)}>
              {Object.entries(screens).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field name="Company or ticker">
            <input value={term} onChange={(e) => setTerm(e.target.value)} />
          </Field>
          <Field name="Minimum price">
            <input type="number" min="0" value={min} onChange={(e) => setMin(e.target.value)} />
          </Field>
          <Field name="Minimum market cap (billions)">
            <input type="number" min="0" value={cap} onChange={(e) => setCap(e.target.value)} />
          </Field>
          <button className="btn" disabled={res.loading} onClick={() => res.reload(true)}>
            Refresh screen
          </button>
        </div>
        <FetchState {...res} />
        {res.data && (
          <>
            <PacketNote p={res.data} />
            <div className="desk-toolbar">
              <small>
                {rows.length} matches · retrieved{' '}
                {res.data.fetched ? new Date(res.data.fetched).toLocaleString() : '—'}
              </small>
              <Field name="Save symbols to">
                <select value={chosen || ''} onChange={(e) => setId(e.target.value)}>
                  {lists.data?.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <p role="status">{note}</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {Object.entries({
                      symbol: 'Ticker',
                      shortName: 'Company',
                      regularMarketPrice: 'Price',
                      regularMarketChangePercent: 'Change',
                      regularMarketVolume: 'Volume',
                      marketCap: 'Market cap',
                      regularMarketTime: 'Quote date',
                    }).map(([k, v]) => (
                      <th key={k}>
                        <button
                          className="text-btn"
                          onClick={() => {
                            setAsc(k === sort ? !asc : k === 'symbol' || k === 'shortName')
                            setSort(k)
                          }}
                        >
                          {v}
                          {k === sort ? (asc ? ' ↑' : ' ↓') : ''}
                        </button>
                      </th>
                    ))}
                    <th>Watch</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((q) => (
                    <tr key={q.symbol}>
                      <td>
                        <button className="text-btn ticker" onClick={() => go('Charts', q.symbol)}>
                          {q.symbol}
                        </button>
                      </td>
                      <td>
                        <button
                          className="text-btn"
                          onClick={() => go('Market research', q.symbol)}
                        >
                          {q.shortName || q.longName || '—'}
                        </button>
                      </td>
                      <td>
                        {fmt(q.regularMarketPrice)} {q.currency}
                      </td>
                      <td>{pct(q.regularMarketChangePercent)}</td>
                      <td>{fmt(q.regularMarketVolume, 0)}</td>
                      <td>{fmt(q.marketCap, 0)}</td>
                      <td>
                        {q.regularMarketTime
                          ? when(new Date(q.regularMarketTime * 1000).toISOString())
                          : '—'}
                      </td>
                      <td>
                        <button
                          className="icon-btn"
                          disabled={!chosen}
                          aria-label={'Watch ' + q.symbol}
                          onClick={async () => {
                            try {
                              await api('/watchlists/' + chosen + '/symbols', 'POST', {
                                symbol: q.symbol,
                              })
                              setNote(q.symbol + ' saved to the watchlist.')
                            } catch (e) {
                              setNote(errorText(e))
                            }
                          }}
                        >
                          <Star size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <SourceLink url="https://finance.yahoo.com/markets/stocks/">
              Yahoo Finance markets
            </SourceLink>
          </>
        )}
      </section>
    </>
  )
}
