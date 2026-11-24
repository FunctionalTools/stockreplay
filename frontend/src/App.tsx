import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  Newspaper,
  ChartCandlestick,
  Star,
  BriefcaseBusiness,
  ListFilter,
  PanelsTopLeft,
  Award,
  ArrowRight,
  BookMarked,
  Bookmark,
  Check,
  ChevronRight,
  Columns2,
  Database,
  FlaskConical,
  Menu,
  PanelLeft,
  Play,
  Plus,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react'
import { Builder } from './Builder'
import { Results } from './Results'
import { Robustness } from './Robustness'
import { Compare, DataPage, Exports, Library, SaveForm, SettingsPage } from './Pages'
import {
  api,
  type AIStatus,
  type Config,
  type Explanation,
  type LibraryItem,
  type Result,
  type Source,
  errorText,
  sourceName,
  validPinSet,
} from './types'
import { Busy, Empty, ErrorBox } from './ui'

import { MarketResearch, RatingsPage } from './ResearchDesk'
import { ChartDesk } from './ChartDesk'
import { Watchlists, Screener } from './Watch'
import { HoldingsPage } from './Positions'
import { TradingTools } from './TradingTools'

const markets = [
  { name: 'Market research', icon: Newspaper },
  { name: 'Charts', icon: ChartCandlestick },
  { name: 'Investor ratings', icon: Award },
  { name: 'Market screener', icon: ListFilter },
  { name: 'Watchlists', icon: Star },
  { name: 'Holdings', icon: BriefcaseBusiness },
  { name: 'TradingView tools', icon: PanelsTopLeft },
]
const nav = [
  { name: 'Workbench', icon: Activity },
  { name: 'Research library', icon: BookMarked },
  { name: 'Compare', icon: Columns2 },
  { name: 'Robustness lab', icon: FlaskConical },
  { name: 'Market data', icon: Database },
  { name: 'Settings', icon: Settings2 },
]
const offline: AIStatus = { online: false, ready: false, model: '', models: [] }

export default function App() {
  const [page, setPage] = useState('Workbench'),
    [mobile, setMobileOpen] = useState(false),
    [symbol, selectSymbol] = useState('NVDA'),
    [ai, setAI] = useState<AIStatus>(offline),
    [defaults, setDefaults] = useState<Config | null>(null),
    [draft, setDraft] = useState<Config | null>(null),
    [question, setQuestion] = useState(''),
    [result, setResult] = useState<Result | null>(null),
    [items, setItems] = useState<LibraryItem[]>([]),
    [active, setActiveSavedId] = useState<string | undefined>(),
    [builder, setBuilder] = useState<Config | null>(null),
    [review, setReview] = useState(''),
    [working, setWorking] = useState(''),
    [explainingId, setExplainingId] = useState(''),
    [explanationError, setExplanationError] = useState({ id: '', message: '' }),
    [err, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [save, saveOpen] = useState(false),
    [exp, exportOpen] = useState(false),
    [loading, setLoading] = useState(true)
  const openingRevision = useRef(0)
  const [openingMessage, setOpeningMessage] = useState('')
  const prompt = useRef<HTMLTextAreaElement>(null)
  const refresh = useCallback(async () => {
    setItems(await api<LibraryItem[]>('/library'))
  }, [])
  function navigate(v: string, ticker?: string) {
    if (ticker) selectSymbol(ticker)
    setPage(v)
    setMobileOpen(false)
    setError('')
    setNotice('')
    window.scrollTo({ top: 0, behavior: 'instant' })
  }
  const install = (r: Result, saved?: string) => {
    setResult(r)
    setDraft(structuredClone(r.config))
    setQuestion(r.config.hypothesis)
    setActiveSavedId(saved)
    setBuilder(null)
  }
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const revision = ++openingRevision.current
      const d = await api<Config>('/defaults')
      if (openingRevision.current !== revision) return
      setDefaults(d)
      setDraft(d)
      setQuestion(d.hypothesis)
      setOpeningMessage('Loading market history through ' + d.end)
      void api<Result>('/opening')
        .then((r) => {
          if (openingRevision.current === revision) {
            install(r)
            setNotice(r.opening_notice || '')
            setOpeningMessage('')
          }
        })
        .catch((e) => {
          if (openingRevision.current === revision) setOpeningMessage(errorText(e))
        })
      void api<AIStatus>('/ai')
        .then(setAI)
        .catch(() => setAI(offline))
      void api<LibraryItem[]>('/library')
        .then(setItems)
        .catch((e) => setError(errorText(e)))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
    return () => {
      ++openingRevision.current
    }
  }, [load])
  useEffect(() => {
    document.title = page + ' · StockReplay'
  }, [page])
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (!document.querySelector('dialog[open]')) {
          navigate('Workbench')
          setTimeout(() => prompt.current?.focus(), 0)
        }
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  function editWorkbench() {
    ++openingRevision.current
    setOpeningMessage('')
  }
  async function execute(c: Config) {
    editWorkbench()
    const pins = result ? validPinSet(c, result) : undefined
    setBuilder(null)
    setDraft(c)
    setQuestion(c.hypothesis)
    setWorking('Submitting experiment')
    setError('')
    setNotice('')
    try {
      const { job } = await api<{ job: string }>('/jobs', 'POST', {
        config: c,
        pins,
      })
      for (;;) {
        const state = await api<{
          status: string
          message: string
          run?: string
        }>('/jobs/' + job)
        if (state.status === 'error') throw Error(state.message)
        if (state.run) {
          const r = await api<Result>('/runs/' + state.run)
          install(r, active)
          setNotice('Experiment complete.')
          if (ai.ready) {
            setExplainingId(r.id)
            setExplanationError({ id: '', message: '' })
            void api<Explanation>('/runs/' + r.id + '/explain', 'POST')
              .then((answer) =>
                setResult((current) =>
                  current?.id === r.id ? { ...current, explanation: answer } : current,
                ),
              )
              .catch((e) => setExplanationError({ id: r.id, message: errorText(e) }))
              .finally(() => setExplainingId((id) => (id === r.id ? '' : id)))
          }
          break
        }
        setWorking(state.message)
        await new Promise((resolve) => setTimeout(resolve, 350))
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setWorking('')
    }
  }
  async function interpret() {
    if (!draft || !question.trim()) return
    setWorking('Interpreting with Ollama')
    setError('')
    setNotice('')
    try {
      const v = await api<{
        status: string
        config: Config | null
        message: string
      }>('/interpret', 'POST', { question, config: draft })
      if (v.config) {
        setReview(v.message)
        setBuilder(v.config)
      } else {
        setNotice(
          (v.status === 'clarify' ? 'Clarification needed. ' : 'Unavailable data or operation. ') +
            v.message,
        )
        prompt.current?.focus()
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setWorking('')
    }
  }
  function create() {
    if (!defaults) return
    editWorkbench()
    navigate('Workbench')
    const v = { ...structuredClone(defaults), name: 'Untitled experiment' }
    setDraft(v)
    setResult(null)
    setQuestion('')
    setActiveSavedId(undefined)
    setReview('')
    setTimeout(() => prompt.current?.focus(), 0)
  }
  async function open(i: LibraryItem) {
    try {
      const r = await api<Result>('/runs/' + i.run_id)
      navigate('Workbench')
      editWorkbench()
      install(r, i.id)
      setDraft({ ...r.config, name: i.name })
    } catch (e) {
      setError(errorText(e))
    }
  }
  const changed = question.trim() !== draft?.hypothesis
  const saved = items.find((i) => i.id === active)
  function navButton(item: (typeof nav)[number]) {
    return (
      <button
        key={item.name}
        className={'nav-link ' + (page === item.name ? 'active' : '')}
        aria-current={page === item.name ? 'page' : undefined}
        onClick={() => navigate(item.name)}
      >
        <item.icon size={17} />
        <span>{item.name}</span>
        {item.name === 'Research library' && items.length > 0 && <em>{items.length}</em>}
      </button>
    )
  }
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to workspace
      </a>
      {mobile && (
        <button
          className="scrim"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={'sidebar ' + (mobile ? 'visible' : '')}>
        <div className="brand">
          <img src="/mark.svg" alt="" />
          <strong>
            Stock<span>Replay</span>
          </strong>
          <button
            className="mobile-only icon-btn"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
          >
            <X size={17} />
          </button>
        </div>
        <nav aria-label="Main navigation">
          <div className="nav-section">Markets</div>
          {markets.map(navButton)}
          <div className="nav-section">Workspace</div>
          {nav.slice(0, 3).map(navButton)}
          <div className="nav-section">Laboratory</div>
          {nav.slice(3, 5).map(navButton)}
        </nav>
        <div className="sidebar-bottom">
          {navButton(nav[5])}
          <div className="engine">
            <div className="engine-icon">
              <Terminal size={16} />
            </div>
            <div>
              <b>Local engine</b>
              <small>macOS workspace</small>
            </div>
            <i className="dot" />
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-btn mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={18} />
            </button>
            <PanelLeft size={15} />
            <span>Workspace</span>
            <ChevronRight size={13} />
            <b>{page}</b>
          </div>
          <button
            className={'status ' + (ai.ready ? 'ready' : '')}
            onClick={() => navigate('Settings')}
          >
            <i />
            {ai.ready ? 'Ollama online' : ai.online ? 'Model unavailable' : 'Ollama offline'}
          </button>
        </header>
        <main id="main">
          <ErrorBox text={err} />
          {loading ? (
            <div className="load-main">
              <Busy text="Opening local research workspace" />
            </div>
          ) : !defaults || !draft ? (
            <Empty
              title="Could not open the workspace"
              body="Check the local service and try again."
            >
              <button className="btn" onClick={() => void load()}>
                Retry connection
              </button>
            </Empty>
          ) : (
            <>
              {page === 'Workbench' && (
                <>
                  <div className="page-head">
                    <div>
                      <h1>Research workbench</h1>
                      <p>Build a hypothesis and test it against historical market data.</p>
                    </div>
                    <button className="btn" onClick={create} disabled={!!working}>
                      <Plus size={15} />
                      New experiment
                    </button>
                  </div>
                  <section className="panel hypothesis">
                    <div className="hyp-head">
                      <div className="title-icon">
                        <div className="feature-icon">
                          <FlaskConical size={17} />
                        </div>
                        <h3>Hypothesis</h3>
                      </div>
                      <span className="badge">
                        {draft.kind === 'event' ? 'Event study' : 'Portfolio backtest'}
                      </span>
                    </div>
                    <div className="prompt-wrap">
                      <textarea
                        ref={prompt}
                        aria-label="Investment hypothesis"
                        placeholder="What market behavior would you like to test?"
                        value={question}
                        maxLength={2000}
                        onChange={(e) => {
                          editWorkbench()
                          setQuestion(e.target.value)
                        }}
                        onKeyDown={(e) => {
                          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !working) {
                            e.preventDefault()
                            void interpret()
                          }
                        }}
                      />
                      <kbd title="Focus hypothesis">⌘ K</kbd>
                    </div>
                    <div className="hyp-actions">
                      <div className="inline wrap">
                        <label className="source-select">
                          <i className={'dot ' + (draft.source === 'demo' ? 'amber' : '')} />
                          <select
                            aria-label="Experiment data source"
                            value={draft.source}
                            onChange={(e) => {
                              editWorkbench()
                              setDraft({
                                ...draft,
                                source: e.target.value as Source,
                              })
                            }}
                          >
                            {Object.entries(sourceName)
                              .filter(([s]) => s !== 'demo' || draft.source === s)
                              .map(([k, v]) => (
                                <option key={k} value={k}>
                                  {v}
                                </option>
                              ))}
                          </select>
                        </label>
                        <button
                          className="text-btn"
                          disabled={!!working}
                          onClick={() => {
                            editWorkbench()
                            setReview('')
                            setBuilder({
                              ...draft,
                              hypothesis: question.trim() || draft.hypothesis,
                            })
                          }}
                        >
                          <SlidersHorizontal size={14} />
                          Builder
                        </button>
                      </div>
                      <div className="inline wrap">
                        <button
                          className={'btn ' + (changed ? 'primary' : 'quiet')}
                          disabled={!!working || question.trim().length < 4}
                          onClick={() => void interpret()}
                        >
                          <Sparkles size={14} />
                          Interpret
                        </button>
                        <button
                          className={'btn ' + (changed ? '' : 'primary')}
                          disabled={!!working || changed}
                          onClick={() => void execute(draft)}
                        >
                          <Play size={14} />
                          Run experiment
                        </button>
                      </div>
                    </div>
                  </section>
                  {working && (
                    <div role="status" className="callout">
                      <Busy text={working} />
                    </div>
                  )}
                  {notice && (
                    <div role="status" className="callout">
                      {notice}
                    </div>
                  )}
                  {result ? (
                    <>
                      <div className="result-context">
                        <span className="inline">
                          <i
                            className={'dot ' + (result.config.source === 'demo' ? 'amber' : '')}
                          />
                          {sourceName[result.config.source]}
                          <span className="context-sep">/</span>
                          {result.config.tickers.join(', ')} vs {result.config.benchmark}
                        </span>
                        <button className="text-btn" onClick={() => saveOpen(true)}>
                          {saved ? <Check size={14} /> : <Bookmark size={14} />}{' '}
                          {saved
                            ? saved.run_id === result.id
                              ? 'Saved · ' + saved.name
                              : 'Update saved experiment'
                            : 'Save experiment'}
                        </button>
                      </div>
                      <Results
                        key={result.id}
                        r={result}
                        exporting={() => exportOpen(true)}
                        generating={explainingId === result.id}
                        automaticError={
                          explanationError.id === result.id ? explanationError.message : ''
                        }
                        explained={(answer) => {
                          setExplanationError({ id: '', message: '' })
                          setResult((current) =>
                            current?.id === result.id
                              ? { ...current, explanation: answer }
                              : current,
                          )
                        }}
                      />
                    </>
                  ) : (
                    <section className="panel">
                      <Empty
                        title={openingMessage || 'Ready for your first run'}
                        body={
                          'Daily study through ' +
                          draft.end +
                          '. Run the configured experiment or edit its rules in the builder.'
                        }
                      />
                    </section>
                  )}
                </>
              )}
              {page === 'Market research' && (
                <MarketResearch key={symbol} symbol={symbol} select={selectSymbol} go={navigate} />
              )}
              {page === 'Investor ratings' && (
                <RatingsPage key={symbol} symbol={symbol} select={selectSymbol} go={navigate} />
              )}
              {page === 'Charts' && (
                <ChartDesk key={symbol} symbol={symbol} select={selectSymbol} go={navigate} />
              )}
              {page === 'Market screener' && <Screener go={navigate} />}
              {page === 'Watchlists' && <Watchlists go={navigate} symbol={symbol} />}
              {page === 'Holdings' && <HoldingsPage />}
              {page === 'TradingView tools' && <TradingTools symbol={symbol} />}
              {page === 'Research library' && (
                <Library
                  items={items}
                  refresh={refresh}
                  open={open}
                  create={create}
                  imported={(r) => {
                    editWorkbench()
                    navigate('Workbench')
                    install(r)
                    setNotice('Experiment reproduced from embedded snapshots.')
                  }}
                  configure={(c) => {
                    editWorkbench()
                    navigate('Workbench')
                    setDraft(c)
                    setQuestion(c.hypothesis)
                    setReview('Imported configuration. Review before running.')
                    setBuilder(c)
                  }}
                />
              )}
              {page === 'Compare' && <Compare items={items} />}
              {page === 'Market data' && <DataPage defaults={defaults} />}
              {page === 'Settings' && <SettingsPage ai={ai} update={setAI} />}
              {page === 'Robustness lab' &&
                (result ? (
                  <Robustness
                    key={result.id}
                    r={result}
                    done={(v) =>
                      setResult({
                        ...result,
                        robustness: v,
                        explanation: undefined,
                      })
                    }
                  />
                ) : (
                  <Empty
                    title="Run an experiment first"
                    body="The robustness lab evaluates variations of the active workbench experiment."
                  >
                    <button className="btn" onClick={() => navigate('Workbench')}>
                      Open workbench <ArrowRight size={14} />
                    </button>
                  </Empty>
                ))}
            </>
          )}
        </main>
        <footer>
          <span>StockReplay Research Laboratory</span>
          <span>
            <i className="dot" />
            Local workspace
          </span>
        </footer>
      </div>
      {builder && (
        <Builder
          initial={builder}
          message={review}
          close={() => setBuilder(null)}
          apply={(c, run) => {
            setDraft(c)
            setQuestion(c.hypothesis)
            setBuilder(null)
            setNotice('Configuration applied.')
            if (run) void execute(c)
          }}
        />
      )}
      {exp && result && <Exports r={result} saved={active} close={() => exportOpen(false)} />}
      {save && result && (
        <SaveForm
          r={result}
          item={saved}
          close={() => saveOpen(false)}
          done={(id) => {
            saveOpen(false)
            setActiveSavedId(id)
            void refresh()
            setNotice('Research saved to your library.')
          }}
        />
      )}
    </div>
  )
}
