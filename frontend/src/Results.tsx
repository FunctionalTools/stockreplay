import { useState } from 'react'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Download,
  Layers3,
  ListFilter,
  Sparkles,
  Target,
} from 'lucide-react'
import {
  type Result,
  type Observation,
  filterEvents,
  pct,
  tone,
  money,
  shortDate,
  indicators,
  api,
  type Explanation,
  errorText,
} from './types'
import { ChartPanel, Confidence } from './Charts'
import { Modal, Empty, Busy, ErrorBox } from './ui'

function EventInspector({ r, e, close }: { r: Result; e: Observation; close: () => void }) {
  return (
    <Modal title={e.ticker + ' · ' + shortDate(e.signal)} close={close} wide>
      <div className="modal-body stack">
        <div className="inline">
          <span className={'badge ' + (e.success ? 'green' : 'red')}>
            {e.success ? 'Met objective' : 'Counterexample'}
          </span>
          <span className="muted">{e.regime} market regime</span>
        </div>
        <div className="event-numbers">
          {[
            ['Entry · ' + e.entry, '$' + money(e.entry_price)],
            ['Exit ' + e.exit_at + ' · ' + e.exit, '$' + money(e.exit_price)],
            ['Net return', pct(e.return_pct)],
            ['Benchmark', pct(e.benchmark_pct)],
          ].map(([k, v]) => (
            <div key={k}>
              <small>{k}</small>
              <strong>{v}</strong>
            </div>
          ))}
        </div>
        <ChartPanel r={r} focus={e} />
        <h3>Signal conditions at close</h3>
        {r.config.entry.rules.map((rule, j) => (
          <div className="compact-row" key={j}>
            <span>
              {rule.ticker} · {indicators[rule.indicator]}
            </span>
            <b>{e.readings[j]?.toFixed(3) ?? 'Unavailable'}</b>
          </div>
        ))}
      </div>
    </Modal>
  )
}
export function Events({ r }: { r: Result }) {
  const [mode, setMode] = useState('all'),
    [sort, setSort] = useState('recent'),
    [page, setPage] = useState(0),
    [item, select] = useState<Observation | null>(null)
  const list = filterEvents(r.events, mode, sort),
    last = Math.max(0, Math.ceil(list.length / 8) - 1),
    cur = Math.min(page, last)
  return (
    <section className="panel events">
      <div className="panel-head">
        <div>
          <div className="title-icon">
            <Layers3 size={17} />
            <h3>Event explorer</h3>
          </div>
          <p>Inspect the signal, execution prices, and outcome of each observation.</p>
        </div>
        <label className="sort">
          <ListFilter size={14} />
          <select
            aria-label="Sort events"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value)
              setPage(0)
            }}
          >
            <option value="recent">Most recent</option>
            <option value="worst">Worst return</option>
            <option value="best">Best return</option>
          </select>
        </label>
      </div>
      <div className="filter-row">
        <div className="seg">
          <button
            className={mode === 'all' ? 'on' : ''}
            onClick={() => {
              setMode('all')
              setPage(0)
            }}
          >
            All events <em>{r.metrics.count}</em>
          </button>
          <button
            className={mode === 'fail' ? 'on' : ''}
            onClick={() => {
              setMode('fail')
              setPage(0)
              setSort('worst')
            }}
          >
            Counterexamples <em>{r.metrics.failures}</em>
          </button>
        </div>
      </div>
      {list.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {['Signal date', 'Asset', 'Net return', 'Benchmark', 'Excess', 'Outcome', ''].map(
                  (h, i) => (
                    <th key={i}>{h}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {list.slice(cur * 8, cur * 8 + 8).map((e) => (
                <tr key={e.signal + e.ticker} onClick={() => select(e)}>
                  <td className="mono">{shortDate(e.signal)}</td>
                  <td>
                    <span className="ticker">{e.ticker}</span>
                  </td>
                  <td className={'mono ' + tone(e.return_pct)}>{pct(e.return_pct)}</td>
                  <td className="mono">{pct(e.benchmark_pct)}</td>
                  <td className={'mono ' + tone(e.excess_pct)}>{pct(e.excess_pct)}</td>
                  <td>
                    <span className={e.success ? 'outcome positive' : 'outcome negative'}>
                      {e.success ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{' '}
                      {e.success ? 'Met objective' : 'Counterexample'}
                    </span>
                  </td>
                  <td>
                    <button
                      className="icon-btn"
                      aria-label={'Inspect ' + e.ticker + ' ' + e.signal}
                      onClick={(ev) => {
                        ev.stopPropagation()
                        select(e)
                      }}
                    >
                      <ChevronRight size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={mode === 'fail' ? 'No counterexamples in this sample' : 'No qualifying events'}
          body="The complete result set is shown for the selected rules."
        />
      )}
      {list.length > 0 && (
        <div className="pagination">
          <span>
            {cur * 8 + 1}–{Math.min(list.length, cur * 8 + 8)} of {list.length} events
          </span>
          <div className="inline">
            <button
              className="icon-btn"
              aria-label="Previous events"
              disabled={!cur}
              onClick={() => setPage(cur - 1)}
            >
              <ChevronLeft size={15} />
            </button>
            <button
              className="icon-btn"
              aria-label="Next events"
              disabled={cur === last}
              onClick={() => setPage(cur + 1)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      )}
      {item && <EventInspector r={r} e={item} close={() => select(null)} />}
    </section>
  )
}

export function Results({
  r,
  exporting,
  explained,
  generating,
  automaticError,
}: {
  r: Result
  generating: boolean
  automaticError: string
  exporting: () => void
  explained: (a: Explanation) => void
}) {
  const m = r.metrics,
    [busy, setBusy] = useState(false),
    [err, setErr] = useState('')
  async function explain() {
    setBusy(true)
    setErr('')
    try {
      explained(await api<Explanation>('/runs/' + r.id + '/explain', 'POST'))
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const cards = [
    {
      name: r.config.kind === 'portfolio' ? 'Executed trades' : 'Qualifying events',
      value: String(m.count),
      sub: r.config.tickers.join(', ') + ' · ' + r.config.holding + '-session hold',
      icon: Crosshair,
    },
    {
      name: 'Mean net return',
      value: pct(m.mean),
      sub: 'After costs and slippage',
      color: tone(m.mean),
      icon: Activity,
    },
    {
      name: 'Objective win rate',
      value: pct(m.win_rate, false, 1),
      sub: m.count - m.failures + ' of ' + m.count + ' met objective',
      icon: Target,
    },
    {
      name: 'Mean excess return',
      value: pct(m.excess),
      sub: 'Relative to ' + r.config.benchmark,
      color: tone(m.excess),
      icon: BarChart3,
    },
  ]
  return (
    <>
      <div className="section-head">
        <div>
          <h2>Research results</h2>
          <span className="meta-line">
            {r.config.name} <i /> {r.first.slice(0, 4)}–{r.last.slice(0, 4)}
          </span>
        </div>
        <button className="btn small" onClick={exporting}>
          <Download size={14} />
          Export
        </button>
      </div>
      <div className="metrics">
        {cards.map((c) => (
          <div className="metric" key={c.name}>
            <div className="metric-label">
              {c.name}
              <c.icon size={15} />
            </div>
            <strong className={c.color}>{c.value}</strong>
            <small>{c.sub}</small>
          </div>
        ))}
      </div>
      {r.config.kind === 'portfolio' && (
        <div className="panel portfolio-strip">
          {[
            ['Portfolio return', pct(m.total_return)],
            ['Buy & hold', pct(m.benchmark_total)],
            ['Annualized', pct(m.annualized)],
            ['Max drawdown', pct(m.drawdown)],
            ['Sharpe', m.sharpe?.toFixed(2) ?? '—'],
          ].map(([k, v]) => (
            <div key={k}>
              <small>{k}</small>
              <b>{v}</b>
            </div>
          ))}
        </div>
      )}
      <div className="charts">
        <ChartPanel r={r} />
        <Confidence r={r} />
      </div>
      <Events r={r} />
      <section className="panel research-note">
        <div className="panel-head">
          <div className="title-icon">
            <Sparkles size={17} />
            <h3>Research assistant</h3>
          </div>
          <button className="btn small" onClick={explain} disabled={busy || generating}>
            {busy || generating ? (
              <Busy text="Reading evidence" />
            ) : r.explanation ? (
              'Regenerate'
            ) : (
              'Explain results'
            )}
          </button>
        </div>
        {r.explanation ? (
          <div className="assistant-body">
            <small>
              {r.explanation.origin === 'engine' ? 'Engine summary' : r.explanation.model} ·
              engine-grounded evidence
            </small>
            {r.explanation.sections.map((s) => (
              <p key={s.key}>{s.text}</p>
            ))}
          </div>
        ) : (
          <p className="helper">
            Ask the local model to summarize effect size, contradictory events, and statistical
            uncertainty.
          </p>
        )}
        <ErrorBox text={err || automaticError} />
      </section>
      <details className="panel methods">
        <summary>Methodology and sample limitations</summary>
        <p>
          Signals are observed at the close. Entries use the next session’s adjusted open. Planned
          exits use the holding-period close. Early exit signals execute at the next open.
        </p>
        <p>
          {m.boundary_skipped} signals fell outside a complete holding window. {m.overlaps_skipped}{' '}
          overlapping trades were excluded in portfolio mode.
        </p>
        {r.warnings.map((t) => (
          <p key={t}>{t}</p>
        ))}
      </details>
    </>
  )
}
