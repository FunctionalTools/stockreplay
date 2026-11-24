import { useEffect, useRef, useState } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  BookmarkPlus,
  Check,
  ChevronRight,
  Newspaper,
  RefreshCw,
  Shield,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import { api, errorText, pct } from './types'
import { useResource, SourceLink } from './deskCommon'
import { Busy, ErrorBox, Modal } from './ui'
import { PricePlot, usePrices } from './PricePlot'
import { ChartDesk } from './ChartDesk'
import {
  amount,
  shortDay,
  type Connection,
  type Intent,
  type Opinion,
  type Point,
  type SavedList,
  type Source,
} from './workspace'

type Grade = {
  date: string
  firm: string
  analyst?: string
  source: string
  url: string
  grade: string
  target?: number | null
  action?: string
}
type Forecast = {
  grade: string
  count: number | null
  targets: Record<string, number>
  votes: Record<string, number>
  period: string | null
  url: string
  source: string
  provider: string | null
}
type Brief = {
  symbol: string
  name: string
  sector: string | null
  as_of: string
  price_as_of: string | null
  current_prices: boolean
  current_context: boolean
  issues: string[]
  evidence: Source[]
  fundamentals: { currency?: string; shortName?: string; recommendationKey?: string }
  metrics: {
    group: string
    label: string
    value: number
    unit: string
    url: string
    date: string
    source: string
  }[]
  public_ratings: {
    forecast: Forecast | null
    forecast_fetched: string | null
    consensus: Record<string, number | string | null> | null
    consensus_fetched: string | null
    consensus_url: string
    consensus_grade: string | null
  }
  analyst_actions: Grade[]
}
const voteNames = ['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell'],
  voteKeys = ['strongBuy', 'buy', 'hold', 'sell', 'strongSell']
function Distribution({ votes }: { votes: Record<string, number> }) {
  const total = Object.values(votes).reduce((a, b) => a + b, 0)
  if (!total) return null
  return (
    <div className="distribution">
      <div className="vote-bar" aria-hidden="true">
        {voteNames.map((n, i) => (
          <i key={n} className={'v' + i} style={{ flex: votes[n] || 0 }} />
        ))}
      </div>
      <div className="vote-labels">
        {voteNames
          .filter((n) => n in votes)
          .map((n) => (
            <span key={n}>
              <i className={'v' + voteNames.indexOf(n)} />
              {n} <b>{votes[n]}</b>
            </span>
          ))}
      </div>
    </div>
  )
}
function Gauge({ score, risk }: { score: number | undefined; risk?: boolean }) {
  const color = risk ? 'var(--risk)' : 'var(--accent)'
  return (
    <div className="gauge">
      <svg viewBox="0 0 100 63" aria-hidden="true">
        <path
          d="M9 53a41 41 0 0 1 82 0"
          fill="none"
          stroke="var(--soft)"
          strokeWidth="8"
          strokeLinecap="round"
        />
        {score != null && (
          <path
            d="M9 53a41 41 0 0 1 82 0"
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            pathLength="100"
            strokeDasharray={score + ' 100'}
          />
        )}
      </svg>
      <span className="gauge-value">{score ?? '—'}</span>
      <strong>{risk ? 'Risk score' : 'Buy score'}</strong>
      <small>{risk ? 'Higher = more risk' : 'Higher = stronger case'}</small>
    </div>
  )
}
function Cited({ point, sources }: { point?: Point; sources: Source[] }) {
  if (!point) return null
  return (
    <div className="cue">
      <p>{point.text}</p>
      {point.citations.map((id) => {
        const s = sources.find((x) => x.id === id)
        return (
          s && (
            <div key={id}>
              <SourceLink url={s.url}>{s.group?.endsWith('_news') ? s.text : s.source}</SourceLink>
              <small> · {shortDay(s.date)}</small>
            </div>
          )
        )
      })}
    </div>
  )
}
export function OpinionDetails({ opinion: o }: { opinion: Opinion }) {
  return (
    <div className="opinion">
      <Cited point={o.thesis} sources={o.sources} />
      <div className="two-col">
        <div>
          <h3>
            <ArrowUpRight size={18} /> Reasons to buy
          </h3>
          {o.catalysts.map((p, i) => (
            <Cited key={i} point={p} sources={o.sources} />
          ))}
        </div>
        <div>
          <h3>
            <Shield size={17} /> Reasons for caution
          </h3>
          {o.risks.map((p, i) => (
            <Cited key={i} point={p} sources={o.sources} />
          ))}
        </div>
      </div>
      <details>
        <summary>What would change this view?</summary>
        <Cited point={o.reconsider} sources={o.sources} />
      </details>
    </div>
  )
}
function ExternalRatings({ b, symbol }: { b: Brief; symbol: string }) {
  const [query, setQuery] = useState(''),
    [limit, setLimit] = useState(15)
  const [more, setMore] = useState(false)
  const p = b.public_ratings,
    f = p.forecast,
    y = p.consensus,
    cc = b.fundamentals.currency
  const records = useResource<{ disclosures: Grade[] }>(
    more ? '/desk/ratings/' + encodeURIComponent(symbol) : null,
  )
  const rows = [
    ...b.analyst_actions,
    ...(records.data?.disclosures || []).map((d) => ({ ...d, source: 'Saved public source' })),
  ].filter((g) =>
    (g.firm + ' ' + (g.analyst || '') + ' ' + g.grade + ' ' + g.source)
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  const votes = Object.fromEntries(
    voteKeys.flatMap((k, i) =>
      typeof y?.[k] === 'number' ? [[voteNames[i], y[k] as number]] : [],
    ),
  )
  return (
    <section id="ratings" className="section-anchor">
      <div className="section-title">
        <h2>Analyst ratings</h2>
        <span>Published opinions</span>
      </div>
      <div className="two-col">
        <article className="panel publisher">
          <small>{f?.provider ? 'Stock Analysis · ' + f.provider : 'Stock Analysis'}</small>
          <h3>{f?.grade || 'No forecast available'}</h3>
          {f && (
            <>
              <p>
                {f.count != null ? f.count + ' analysts · ' : ''}Checked{' '}
                {shortDay(p.forecast_fetched)}
              </p>
              <Distribution votes={f.votes} />
              {f.targets.average != null && (
                <div className="target">
                  <span>Average target</span>
                  <strong>{amount(f.targets.average, cc)}</strong>
                  {f.targets.low != null && f.targets.high != null && (
                    <small>
                      Range {amount(f.targets.low, cc)} – {amount(f.targets.high, cc)}
                    </small>
                  )}
                </div>
              )}
              <SourceLink url={f.url}>View the published forecast</SourceLink>
            </>
          )}
        </article>
        <article className="panel publisher">
          <small>Yahoo Finance</small>
          <h3>
            {p.consensus_grade
              ? p.consensus_grade.replaceAll('_', ' ')
              : y
                ? 'Analyst consensus'
                : 'No consensus available'}
          </h3>
          {y && (
            <>
              <p>Current recommendation breakdown · Checked {shortDay(p.consensus_fetched)}</p>
              <Distribution votes={votes} />
            </>
          )}
          <SourceLink url={p.consensus_url}>View Yahoo Finance analysis</SourceLink>
        </article>
      </div>
      <details className="panel analyst-table" onToggle={(e) => setMore(e.currentTarget.open)}>
        <summary>
          Individual analyst ratings{' '}
          <span>{b.analyst_actions.length.toLocaleString()} published records</span>
        </summary>
        <label className="field">
          <span>Search firms or ratings</span>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setLimit(15)
            }}
            placeholder="Firm, analyst or rating"
          />
        </label>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {['Date', 'Firm', 'Rating', 'Target', 'Source'].map((a) => (
                  <th key={a}>{a}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((g, i) => (
                <tr key={i}>
                  <td>{shortDay(g.date)}</td>
                  <td>
                    {g.firm}
                    <small className="cell-note">{g.analyst}</small>
                  </td>
                  <td>{g.grade || g.action}</td>
                  <td>{amount(g.target, cc)}</td>
                  <td>
                    <SourceLink url={g.url}>{g.source}</SourceLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && <p>No matching published ratings.</p>}
        {limit < rows.length && (
          <button className="btn" onClick={() => setLimit((l) => l + 50)}>
            Show more ratings
          </button>
        )}
      </details>
    </section>
  )
}
function News({ b, opinion }: { b: Brief; opinion: Opinion | null }) {
  const [filter, set] = useState('All'),
    [limit, show] = useState(6)
  const cited = new Set(opinion?.sources.map((s) => s.url))
  const items = b.evidence
    .filter((s) => s.group.endsWith('_news'))
    .sort((a, b) => b.date.localeCompare(a.date))
  const choices = ['All', 'Company', 'Sector', 'Market', 'Used in scores']
  const rows = items.filter(
    (s) =>
      filter === 'All' ||
      (filter === 'Used in scores'
        ? cited.has(s.url)
        : filter === 'Market'
          ? ['market_news', 'macro_news'].includes(s.group)
          : s.group === filter.toLowerCase() + '_news'),
  )
  return (
    <section id="news" className="section-anchor">
      <div className="section-title">
        <h2>News behind the numbers</h2>
        <Newspaper size={20} />
      </div>
      <div className="chips">
        {choices.map((v) => (
          <button
            onClick={() => {
              set(v)
              show(6)
            }}
            className={v === filter ? 'selected' : ''}
            aria-pressed={v === filter}
            key={v}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="news-grid">
        {rows.slice(0, limit).map((n) => (
          <article className="panel story" key={n.id}>
            <small>
              {n.source} · {shortDay(n.date)}
            </small>
            <h3>{n.text}</h3>
            {n.excerpt && <p>{n.excerpt}</p>}
            <footer>
              <SourceLink url={n.url}>Read article</SourceLink>
              {cited.has(n.url) && (
                <small>
                  <Check size={12} /> Used in scores
                </small>
              )}
            </footer>
          </article>
        ))}
      </div>
      {!rows.length && (
        <p className="muted">
          No recent articles in this selection. Citations from a saved assessment stay with its
          reasons.
        </p>
      )}
      {rows.length > limit && (
        <button className="btn" onClick={() => show((n) => n + 6)}>
          More articles
        </button>
      )}
    </section>
  )
}
export function Research({
  symbol,
  connection,
  settings,
  advanced,
  onAdvanced,
  intent,
  updateSeq,
}: {
  symbol: string
  connection: Connection | null
  settings: () => void
  advanced: boolean
  onAdvanced: () => Promise<void>
  intent: Intent
  updateSeq: number
}) {
  const eb = useResource<Brief>('/desk/brief/' + encodeURIComponent(symbol)),
    history = useResource<Opinion[]>('/desk/recommend/' + encodeURIComponent(symbol)),
    lists = useResource<SavedList[]>('/watchlists')
  const [span, period] = useState('6mo'),
    [busy, wait] = useState(false),
    [message, say] = useState(''),
    [err, fail] = useState(''),
    [watch, setWatch] = useState(false),
    [listId, choose] = useState(''),
    [revision, refresh] = useState(0),
    [layoutRevision, refreshLayout] = useState(0),
    [selected, setSelected] = useState(''),
    [adv, setAdv] = useState(advanced)
  const prices = usePrices([symbol], span, '', revision),
    series = prices.series[0],
    bars = series?.bars,
    last = bars?.at(-1),
    prior = bars?.at(-2),
    diff = last && prior ? 100 * (last.raw_close / prior.raw_close - 1) : null
  const o = history.data?.find((row) => row.id === selected) || history.data?.[0] || null,
    b = eb.data
  const focus = useRef<HTMLElement | null>(null)
  useEffect(() => setAdv(advanced), [advanced])
  useEffect(() => {
    if (intent.kind === 'layout_saved') refreshLayout(intent.seq)
  }, [intent.kind, intent.seq])
  const readHistory = history.reload,
    readLists = lists.reload
  useEffect(() => {
    if (updateSeq) {
      readHistory()
      readLists()
    }
  }, [updateSeq, readHistory, readLists])
  useEffect(() => {
    if (!intent.seq) return
    if (
      intent.kind.startsWith('control_') ||
      ['news', 'ratings', 'scores', 'layout_saved', 'tools', 'box', 'trend', 'horizontal'].includes(
        intent.kind,
      )
    ) {
      const isTool =
        intent.kind.startsWith('control_') ||
        ['layout_saved', 'tools', 'box', 'horizontal', 'trend'].includes(intent.kind)
      if (isTool) setAdv(true)
      const id = requestAnimationFrame(() =>
        document.getElementById(isTool ? 'tools' : intent.kind)?.scrollIntoView({ block: 'start' }),
      )
      return () => cancelAnimationFrame(id)
    }
  }, [intent, b])
  async function generate() {
    wait(true)
    fail('')
    try {
      const a = await api<Opinion>('/desk/recommend/' + encodeURIComponent(symbol), 'POST')
      setSelected(a.id)
      history.reload()
    } catch (e) {
      fail(errorText(e))
    } finally {
      wait(false)
    }
  }
  async function save() {
    try {
      let id = listId || lists.data?.[0]?.id
      if (!id) id = (await api<{ id: string }>('/watchlists', 'POST', { name: 'Watchlist' })).id
      await api('/watchlists/' + id + '/symbols', 'POST', { symbol })
      lists.reload()
      setWatch(false)
      say(symbol + ' saved to your watchlist.')
    } catch (e) {
      fail(errorText(e))
    }
  }
  return (
    <div className="research">
      <div className="page-head">
        <div>
          <div className="kicker">
            <span className="live-dot" />
            {symbol}
            {b?.sector && ' / ' + b.sector}
          </div>
          <h1>{b?.fundamentals.shortName || b?.name || symbol}</h1>
        </div>
        <div className="inline">
          <button
            className="btn"
            onClick={() => {
              eb.reload(true)
              refresh((n) => n + 1)
            }}
            disabled={eb.loading || prices.loading}
            aria-label="Refresh stock sources"
          >
            <RefreshCw size={15} />
          </button>
          <button className="btn" onClick={() => setWatch(true)}>
            <BookmarkPlus size={15} /> Watch
          </button>
        </div>
      </div>
      {message && <p role="status">{message}</p>}
      <div className="research-top">
        <section className="panel quote-card">
          <div className="section-head">
            <div>
              <small>Last close</small>
              <div className="quote">{amount(last?.raw_close, series?.currency)}</div>
            </div>
            {diff != null && (
              <span className={'delta ' + (diff >= 0 ? 'up' : 'down')}>
                {diff >= 0 ? <TrendingUp size={16} /> : <ArrowDownRight size={16} />} {pct(diff)}
              </span>
            )}
          </div>
          <div className="quote-row">
            <small>
              {last
                ? shortDay(last.date) + ' · ' + (series?.currency || 'currency unreported')
                : 'Awaiting price history'}
            </small>
            <div className="range">
              {['1mo', '6mo', '1y', '2y', '5y'].map((v) => (
                <button
                  key={v}
                  aria-pressed={span === v}
                  className={v === span ? 'selected' : ''}
                  onClick={() => period(v)}
                >
                  {v.toUpperCase().replace('MO', 'M')}
                </button>
              ))}
            </div>
          </div>
          {prices.loading ? (
            <div className="plot-wait">
              <Busy text="Reading price history" />
            </div>
          ) : (
            <PricePlot series={prices.series} />
          )}
          <ErrorBox text={prices.errors.join(' ')} />
        </section>
        <section id="scores" ref={focus} className="panel scores">
          <div className="section-head">
            <h2>
              <Sparkles size={17} /> AI assessment
            </h2>
          </div>
          <div className="gauges">
            <Gauge score={o?.buy_score} />
            <Gauge score={o?.risk_score} risk />
          </div>
          {o?.buy_score != null ? (
            <p>
              {o.confidence} confidence · {o.horizon}
              <br />
              <small>
                {o.model} · {shortDay(o.created)}
              </small>
            </p>
          ) : (
            <p>
              Get two independent scores from the news, price history, risk measures and analyst
              estimates.
            </p>
          )}
          {connection?.configured ? (
            <button className="btn primary" disabled={busy} onClick={generate}>
              {busy ? (
                <Busy text="Generating assessment" />
              ) : (
                <>
                  <Sparkles size={14} />
                  {o ? 'Update scores' : 'Generate scores'}
                </>
              )}
            </button>
          ) : (
            <button className="btn primary" onClick={settings}>
              Connect OpenAI <ChevronRight size={15} />
            </button>
          )}
          <ErrorBox text={err} />
        </section>
      </div>
      {o && (
        <section className="panel explanation">
          <div className="section-head">
            <h2>Why these scores?</h2>
            {(history.data?.length || 0) > 1 && (
              <select
                aria-label="Saved assessment"
                value={o.id}
                onChange={(e) => setSelected(e.target.value)}
              >
                {history.data!.map((g) => (
                  <option key={g.id} value={g.id}>
                    {new Date(g.created).toLocaleString()} · {g.model}
                  </option>
                ))}
              </select>
            )}
          </div>
          {o.buy_score == null && (
            <p>
              Saved assessment from the earlier version. Generate scores to add the two new
              measures.
            </p>
          )}
          <OpinionDetails opinion={o} />
        </section>
      )}
      <ErrorBox text={eb.error || history.error} />
      {eb.loading && !b && (
        <div className="panel tip">
          <Busy text="Gathering news and analyst ratings" />
        </div>
      )}
      {b && (
        <>
          <ExternalRatings b={b} symbol={symbol} />
          <News b={b} opinion={o} />
          <details className="panel evidence-detail">
            <summary>Company risk and financial estimates</summary>
            <div className="metrics">
              {b.metrics.map((m, i) => (
                <article key={i}>
                  <small>{m.label}</small>
                  <strong>
                    {m.value.toLocaleString()} {m.unit}
                  </strong>
                  <SourceLink url={m.url}>
                    {m.source} · {shortDay(m.date)}
                  </SourceLink>
                </article>
              ))}
            </div>
            {!b.metrics.length && (
              <p>No figures were available from the publishers for this stock.</p>
            )}
          </details>
          {!!b.issues.length && (
            <details className="coverage">
              <summary>Source availability</summary>
              {b.issues.map((s, i) => (
                <p key={i}>{s}</p>
              ))}
            </details>
          )}
        </>
      )}
      <section id="tools" className="advanced-block">
        <div className="section-head">
          <h2>
            <SlidersHorizontal size={18} /> Advanced chart
          </h2>
          <button
            className="btn"
            aria-expanded={adv}
            onClick={async () => {
              if (!advanced && !adv) {
                try {
                  await onAdvanced()
                } catch (e) {
                  fail(errorText(e))
                  return
                }
              }
              setAdv(!adv)
            }}
          >
            {adv ? 'Hide chart tools' : 'Show chart tools'}
          </button>
        </div>
        {adv && (
          <ChartDesk
            key={symbol + ':' + layoutRevision}
            symbol={symbol}
            control={intent}
            initialTool={['box', 'trend', 'horizontal'].includes(intent.kind) ? intent.kind : ''}
          />
        )}
      </section>
      {watch && (
        <Modal title={'Watch ' + symbol} close={() => setWatch(false)}>
          <div className="modal-body stack">
            <label className="field">
              <span>Watchlist</span>
              <select
                value={listId || lists.data?.[0]?.id || ''}
                onChange={(e) => choose(e.target.value)}
              >
                {lists.data?.length ? (
                  lists.data.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))
                ) : (
                  <option value="">Watchlist</option>
                )}
              </select>
            </label>
            <button className="btn primary" onClick={save}>
              Save to watchlist
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
