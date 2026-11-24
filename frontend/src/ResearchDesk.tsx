import { useEffect, useState } from 'react'
import { BookmarkPlus, Sparkles, KeyRound } from 'lucide-react'
import { Busy, ErrorBox, Field } from './ui'
import { api, errorText } from './types'
import {
  FetchState,
  PageHead,
  TickerBar,
  SourceLink,
  RatingCard,
  PacketNote,
  useResource,
  when,
  fmt,
  type Packet,
  type Evidence,
  type Rating,
  type OpenStatus,
  type Navigate,
} from './deskCommon'

type Brief = {
  symbol: string
  name: string
  sector: string | null
  sector_etf: string | null
  as_of: string
  current_prices: boolean
  current_context: boolean
  evidence: Evidence[]
  issues: string[]
  rating: Rating | null
  fundamentals: Record<string, string | number | null>
  profile_fetched: string | null
}
type Point = { text: string; citations: string[] }
type Opinion = {
  stance: string
  horizon: string
  thesis: Point
  catalysts: Point[]
  risks: Point[]
  reconsider: Point
  model: string
  created: string
  as_of: string
  sources: Evidence[]
}
const groups: Record<string, string> = {
  price: 'Price history',
  sector: 'Sector benchmark',
  market: 'Market benchmark',
  technical: 'Technical rating',
  analysts: 'Analyst views',
  company_news: 'Company news',
  sector_news: 'Sector news',
  market_news: 'Market news',
  macro_news: 'Federal Reserve',
}
type DeskProps = { symbol: string; select: (s: string) => void; go: Navigate }
function EvidenceList({ items }: { items: Evidence[] }) {
  return (
    <div className="news-feed">
      {items.map((e) => (
        <article key={e.id}>
          <small>
            {groups[e.group]} · {when(e.date)}
          </small>
          <a href={e.url} target="_blank" rel="noopener noreferrer">
            {e.text}
          </a>
          <span>{e.source}</span>
        </article>
      ))}
      {!items.length && (
        <p className="helper">No dated source items were available for this selection.</p>
      )}
    </div>
  )
}
function OpinionView({ opinion: o }: { opinion: Opinion }) {
  const evidence = new Map(o.sources.map((e, i) => [e.id, { ...e, n: i + 1 }]))
  const point = (p: Point) => (
    <div className="opinion-point">
      {p.text}{' '}
      {p.citations.map((id) => {
        const e = evidence.get(id)
        return e ? (
          <a
            key={id}
            className="ref"
            href={e.url}
            target="_blank"
            rel="noopener noreferrer"
            title={e.text + ' · ' + when(e.date)}
          >
            [{e.n}]
          </a>
        ) : null
      })}
    </div>
  )
  return (
    <div className="opinion">
      <div className="inline">
        <strong>{o.stance}</strong>
        <span className="badge">{o.horizon}</span>
      </div>
      <p className="helper">
        {o.model} · generated {new Date(o.created).toLocaleString()} · market session {o.as_of}
      </p>
      {point(o.thesis)}
      {[
        ['Catalysts', o.catalysts],
        ['Risks', o.risks],
        ['What would change the view', [o.reconsider]],
      ].map(([label, items]) => (
        <section key={String(label)}>
          <h4>{String(label)}</h4>
          {(items as Point[]).map((p, i) => (
            <div key={i}>{point(p)}</div>
          ))}
        </section>
      ))}
      <details>
        <summary>Sources cited ({o.sources.length})</summary>
        <EvidenceList items={o.sources} />
      </details>
    </div>
  )
}
export function MarketResearch({ symbol, select, go }: DeskProps) {
  const data = useResource<Brief>('/desk/brief/' + encodeURIComponent(symbol)),
    key = useResource<OpenStatus>('/openai'),
    [filter, setFilter] = useState('all'),
    [busy, wait] = useState(false),
    [error, setError] = useState(''),
    [answer, setAnswer] = useState<Opinion | null>(null)
  const b = data.data
  async function generate() {
    wait(true)
    setError('')
    setAnswer(null)
    try {
      setAnswer(await api<Opinion>('/desk/recommend/' + encodeURIComponent(symbol), 'POST'))
    } catch (e) {
      setError(errorText(e))
    } finally {
      wait(false)
    }
  }
  return (
    <>
      <PageHead
        title="Market research"
        description="Assess a stock using dated headlines, sector conditions and historical market returns."
      />
      <TickerBar
        symbol={symbol}
        select={select}
        refresh={() => {
          setAnswer(null)
          data.reload(true)
        }}
        busy={data.loading || busy}
      />
      <FetchState {...data} />
      {b && (
        <>
          <div className="security-head">
            <div>
              <span className="ticker">{b.symbol}</span>
              <h2>{b.name}</h2>
              <p>{[b.sector, b.sector_etf, 'US session ' + b.as_of].filter(Boolean).join(' · ')}</p>
            </div>
            <button className="btn" onClick={() => go('Investor ratings', symbol)}>
              Investor ratings
            </button>
          </div>
          <div className="desk-grid">
            <section className="panel desk-card">
              <h3>
                <Sparkles size={17} /> OpenAI research recommendation
              </h3>
              <p>
                Generate a stock-level view from the public evidence below. OpenAI receives this
                ticker, dated headlines and market statistics. Your holdings, watchlists and notes
                stay on this Mac. Your OpenAI API account is billed for generation.
              </p>
              {!key.data?.configured ? (
                <button className="btn primary" onClick={() => go('Settings')}>
                  <KeyRound size={15} />
                  Connect an OpenAI API key
                </button>
              ) : (
                <button
                  className="btn primary"
                  disabled={busy || data.loading || !b.current_prices || !b.current_context}
                  onClick={generate}
                >
                  {busy ? <Busy text="Generating recommendation" /> : 'Generate recommendation'}
                </button>
              )}
              {(!b.current_prices || !b.current_context) && (
                <p className="data-warning">
                  Current security, sector ETF and benchmark closes are required for a
                  recommendation.
                </p>
              )}
              <ErrorBox text={error} />
              {answer && <OpinionView opinion={answer} />}
            </section>
            <RatingCard rating={b.rating} />
          </div>
          <section className="panel desk-card">
            <div className="section-head">
              <h3>Company fundamentals</h3>
              <small>Yahoo Finance · retrieved {when(b.profile_fetched)}</small>
            </div>
            <div className="facts">
              {Object.entries({
                industry: 'Industry',
                currency: 'Currency',
                trailingPE: 'Trailing P/E',
                forwardPE: 'Forward P/E',
                trailingEps: 'Trailing EPS',
                marketCap: 'Market capitalization',
                fiftyTwoWeekLow: '52-week low',
                fiftyTwoWeekHigh: '52-week high',
              }).map(([k, n]) => (
                <div key={k}>
                  <small>{n}</small>
                  <b>
                    {typeof b.fundamentals[k] === 'number'
                      ? fmt(Number(b.fundamentals[k]))
                      : (b.fundamentals[k] ?? '—')}
                  </b>
                </div>
              ))}
            </div>
          </section>
          <section className="panel desk-card">
            <div className="section-head">
              <h3>Research evidence</h3>
              <select
                aria-label="Evidence category"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">All sources ({b.evidence.length})</option>
                {Object.entries(groups).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v} ({b.evidence.filter((e) => e.group === k).length})
                  </option>
                ))}
              </select>
            </div>
            <EvidenceList
              items={b.evidence.filter((e) => filter === 'all' || e.group === filter)}
            />
          </section>
          {b.issues.length > 0 && (
            <section className="panel desk-card">
              <h3>Source availability</h3>
              {b.issues.map((v) => (
                <p key={v} className="data-warning">
                  {v}
                </p>
              ))}
            </section>
          )}
        </>
      )}
    </>
  )
}
type Grade = {
  analyst?: string
  date: string
  firm: string
  grade: string
  previous?: string
  action?: string
  target?: number | null
  url: string
  source?: string
  id?: string
}
type Grades = {
  symbol: string
  actions: Packet<Grade[]>
  stockanalysis: Packet<Grade[]>
  consensus: Packet<({ period: string } & Record<string, number | string | null>)[]>
  nasdaq: Packet<{
    grade: string
    summary: string
    url: string
    contributors: unknown[]
  }>
  profile: Packet<Record<string, string | number | null>>
  stockreplay: Rating | null
  price_issues: string[]
  disclosures: Grade[]
}
export function RatingsPage({ symbol, select, go }: DeskProps) {
  const res = useResource<Grades>('/desk/ratings/' + encodeURIComponent(symbol)),
    r = res.data,
    [term, setTerm] = useState(''),
    [page, setPage] = useState(0),
    [adding, setAdd] = useState(false),
    [error, setErr] = useState('')
  const all = [
    ...(r?.actions.data || []),
    ...(r?.stockanalysis?.data || []),
    ...(r?.disclosures || []).map((g) => ({
      ...g,
      source: 'Saved public disclosure',
    })),
  ]
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((g) =>
      (g.firm + ' ' + (g.analyst || '') + ' ' + g.grade + ' ' + g.action)
        .toLowerCase()
        .includes(term.toLowerCase()),
    )
  const size = 25,
    cur = Math.min(page, Math.max(0, Math.ceil(all.length / size) - 1))
  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = Object.fromEntries(new FormData(e.currentTarget))
    try {
      await api('/desk/ratings/' + symbol + '/disclosures', 'POST', f)
      setAdd(false)
      setErr('')
      res.reload()
    } catch (ex) {
      setErr(errorText(ex))
    }
  }
  return (
    <>
      <PageHead
        title="Investor ratings"
        description="Compare publisher consensus, individual analyst actions and StockReplay’s price-based assessment."
      />
      <TickerBar
        symbol={symbol}
        select={select}
        refresh={() => res.reload(true)}
        busy={res.loading}
      />
      <FetchState {...res} />
      {r && (
        <>
          <div className="security-head">
            <div>
              <span className="ticker">{symbol}</span>
              <h2>{r.profile.data?.longName || symbol}</h2>
            </div>
            <button className="btn" onClick={() => go('Market research', symbol)}>
              Market research
            </button>
          </div>
          <div className="desk-grid">
            <RatingCard rating={r.stockreplay} />
            <section className="panel desk-card">
              <h3>Nasdaq analyst consensus</h3>
              {r.nasdaq.data ? (
                <>
                  <div className="rating-number">{r.nasdaq.data.grade}</div>
                  <p>{r.nasdaq.data.summary}</p>
                  {r.nasdaq.data.contributors?.length > 0 && (
                    <details>
                      <summary>Contributing firms ({r.nasdaq.data.contributors.length})</summary>
                      <p>{r.nasdaq.data.contributors.map(String).join(' · ')}</p>
                    </details>
                  )}
                  <SourceLink url={r.nasdaq.data.url}>
                    Nasdaq analyst research · retrieved {when(r.nasdaq.fetched)}
                  </SourceLink>
                </>
              ) : (
                <p>Consensus unavailable for {symbol}.</p>
              )}
              <PacketNote p={r.nasdaq} />
              <h4>Published price targets</h4>
              <p>
                Low {fmt(NumberOrNull(r.profile.data?.targetLowPrice))} · Mean{' '}
                {fmt(NumberOrNull(r.profile.data?.targetMeanPrice))} · High{' '}
                {fmt(NumberOrNull(r.profile.data?.targetHighPrice))} {r.profile.data?.currency}
              </p>
              <small>
                Yahoo Finance · {fmt(NumberOrNull(r.profile.data?.numberOfAnalystOpinions), 0)}{' '}
                contributing opinions · retrieved {when(r.profile.fetched)}
              </small>
              <PacketNote p={r.profile} />
            </section>
          </div>
          <section className="panel desk-card">
            <h3>Yahoo Finance consensus history</h3>
            <p className="helper">
              Counts from Yahoo’s rolling monthly buckets. Each publisher maintains its own
              coverage.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {['Period', 'Strong buy', 'Buy', 'Hold', 'Sell', 'Strong sell'].map((v) => (
                      <th key={v}>{v}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.consensus.data?.map((row) => (
                    <tr key={row.period}>
                      <td>{row.period === '0m' ? 'Current' : row.period}</td>
                      {['strongBuy', 'buy', 'hold', 'sell', 'strongSell'].map((k) => (
                        <td key={k}>{row[k] ?? '—'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <SourceLink url={'https://finance.yahoo.com/quote/' + symbol + '/analysis/'}>
              Yahoo Finance · retrieved {when(r.consensus.fetched)}
            </SourceLink>
            <PacketNote p={r.consensus} />
          </section>
          <section className="panel desk-card">
            <div className="section-head">
              <div>
                <h3>Published analyst actions</h3>
                <p className="helper">
                  {all.length} matching records · full history returned by the connected sources
                </p>
              </div>
              <button className="btn" onClick={() => setAdd(!adding)}>
                <BookmarkPlus size={15} />
                Add a public rating
              </button>
            </div>
            {adding && (
              <form className="desk-form" onSubmit={add}>
                {[
                  ['firm', 'Firm or investor', 'text'],
                  ['grade', 'Published rating', 'text'],
                  ['date', 'Publication date', 'date'],
                  ['url', 'Public source URL', 'url'],
                ].map(([k, v, t]) => (
                  <Field key={k} name={v}>
                    <input name={k} type={t} required />
                  </Field>
                ))}
                <button className="btn primary">Save disclosure locally</button>
              </form>
            )}
            <ErrorBox text={error} />
            <input
              aria-label="Filter analyst actions"
              placeholder="Filter by analyst, rating or action"
              value={term}
              onChange={(e) => {
                setTerm(e.target.value)
                setPage(0)
              }}
            />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {[
                      'Published',
                      'Firm or investor',
                      'Previous',
                      'Rating',
                      'Action',
                      'Target',
                      'Source',
                    ].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {all.slice(cur * size, (cur + 1) * size).map((g, i) => (
                    <tr key={g.date + g.firm + i}>
                      <td>{when(g.date)}</td>
                      <td>
                        {g.firm}
                        <small className="cell-note">{g.analyst}</small>
                      </td>
                      <td>{g.previous || '—'}</td>
                      <td>{g.grade || '—'}</td>
                      <td>{g.action || '—'}</td>
                      <td>{fmt(g.target)}</td>
                      <td>
                        <SourceLink url={g.url}>{g.source || 'Publisher'}</SourceLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!all.length && <p>No matching dated rating is available.</p>}
            <div className="pagination">
              <span>
                {all.length ? cur * size + 1 : 0}–{Math.min(all.length, (cur + 1) * size)} of{' '}
                {all.length}
              </span>
              <div className="inline">
                <button className="btn small" disabled={!cur} onClick={() => setPage(cur - 1)}>
                  Previous
                </button>
                <button
                  className="btn small"
                  disabled={(cur + 1) * size >= all.length}
                  onClick={() => setPage(cur + 1)}
                >
                  Next
                </button>
              </div>
            </div>
            <PacketNote p={r.actions} />
            <PacketNote p={r.stockanalysis} />
            {r.price_issues.map((x) => (
              <p className="data-warning" key={x}>
                {x}
              </p>
            ))}
          </section>
        </>
      )}
    </>
  )
}
function NumberOrNull(v: unknown) {
  return typeof v === 'number' ? v : null
}
export function OpenAISettings() {
  const s = useResource<OpenStatus>('/openai'),
    [model, setModel] = useState('gpt-4.1-mini'),
    [key, enter] = useState(''),
    [remember, keep] = useState(false),
    [busy, wait] = useState(false),
    [message, show] = useState(''),
    [error, setError] = useState('')
  useEffect(() => {
    if (s.data) {
      setModel(s.data.model)
      keep(s.data.storage === 'macOS Keychain')
    }
  }, [s.data])
  async function act(mode: 'save' | 'test' | 'forget') {
    wait(true)
    show('')
    setError('')
    try {
      if (mode === 'save') {
        await api('/openai', 'PUT', { key, model, remember })
        enter('')
        show('API key saved.')
      } else if (mode === 'test') {
        await api('/openai/test', 'POST')
        show('OpenAI confirmed access to the selected model.')
      } else {
        await api('/openai', 'DELETE')
        enter('')
        show('API key removed.')
      }
      s.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      wait(false)
    }
  }
  return (
    <section className="panel desk-card">
      <div className="section-head">
        <h3>
          <KeyRound size={16} />
          OpenAI API
        </h3>
        <span className="badge">{s.data?.configured ? 'Key configured' : 'No key configured'}</span>
      </div>
      <p>
        Use your OpenAI API project for on-demand market recommendations. The local server sends the
        selected stock’s public evidence to api.openai.com with response storage disabled. OpenAI’s
        API data controls apply. A ChatGPT subscription and API billing are separate.
      </p>
      <form
        className="desk-form"
        onSubmit={(e) => {
          e.preventDefault()
          void act('save')
        }}
      >
        <Field name="OpenAI API key">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            value={key}
            onChange={(e) => enter(e.target.value)}
            placeholder={s.data?.configured ? 'Enter a replacement key' : 'sk-…'}
          />
        </Field>
        <Field name="OpenAI model">
          <input value={model} required onChange={(e) => setModel(e.target.value)} />
        </Field>
        <label className="check-line">
          <input type="checkbox" checked={remember} onChange={(e) => keep(e.target.checked)} />
          Remember in macOS Keychain
        </label>
        <p className="helper">Session-only keys are cleared when StockReplay stops.</p>
        <div className="inline wrap">
          <button className="btn primary" disabled={busy || !key}>
            Save API key
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy || !s.data?.configured}
            onClick={() => act('test')}
          >
            Test OpenAI connection
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !s.data?.configured}
            onClick={() => act('forget')}
          >
            Remove API key
          </button>
        </div>
      </form>
      {message && <p role="status">{message}</p>}
      <ErrorBox text={error || s.error} />
    </section>
  )
}
