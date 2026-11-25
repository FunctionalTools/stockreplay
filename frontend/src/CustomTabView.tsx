import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  ChevronDown,
  FolderOpen,
  History,
  LayoutGrid,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { api, errorText } from './types'
import { Busy, ErrorBox, Field, Modal } from './ui'
import { useResource, SourceLink } from './deskCommon'
import { usePrices, PricePlot } from './PricePlot'
import { NewsPreviews } from './NewsPreviews'
import { amount, shortDay, type Source, type SavedList } from './workspace'
import {
  tabHref,
  tabSpans,
  tabViews,
  type CustomTab,
  type TabBlock,
  type TabSummary,
} from './customTabs'
import './customTabs.css'

const labels: Record<TabBlock['view'], string> = {
  chart: 'Price chart',
  news: 'Latest news',
  ratings: 'Analyst ratings',
  watchlist: 'Watchlist',
  portfolio: 'Portfolio totals',
  note: 'Note',
}
const newBlock = (view: TabBlock['view'], symbol: string): TabBlock => ({
  view,
  value: ['chart', 'news', 'ratings'].includes(view) ? symbol : '',
  span: '1y',
})

export function MyTabs({
  active,
  symbol,
  openTab,
  version,
  changed,
}: {
  active: string
  symbol: string
  openTab: (id: string) => void
  version: number
  changed: () => void
}) {
  const [menu, show] = useState(false),
    [creating, create] = useState(false)
  const host = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null)
  const tabs = useResource<TabSummary[]>(menu ? '/tabs?v=' + version : null)
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) show(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        show(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [menu])
  return (
    <div className="my-tabs" ref={host}>
      <button
        className={'my-tabs-trigger' + (active ? ' selected' : '')}
        ref={trigger}
        aria-label="My tabs"
        aria-expanded={menu}
        aria-controls="saved-tabs-popover"
        onClick={() => show((v) => !v)}
      >
        <LayoutGrid size={15} />
        <span>My tabs</span>
        <ChevronDown size={13} />
      </button>
      {menu && (
        <div id="saved-tabs-popover" className="my-tabs-popover">
          <div className="tabs-popover-title">
            My tabs
            <button
              className="icon-btn"
              aria-label="Create saved tab"
              onClick={() => {
                show(false)
                create(true)
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          {tabs.loading && <Busy text="Loading tabs" />}
          <ErrorBox text={tabs.error} />
          {tabs.data?.length === 0 && <p>Keep charts, news and notes in a tab of your own.</p>}
          <div className="tab-list">
            {tabs.data?.map((t) => (
              <a
                key={t.id}
                href={tabHref(t.id)}
                aria-current={active === t.id ? 'page' : undefined}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                  e.preventDefault()
                  show(false)
                  openTab(t.id)
                }}
              >
                <FolderOpen size={15} />
                {t.title}
              </a>
            ))}
          </div>
          <a
            className="tabs-bookmarks"
            href={'#/research/' + symbol + '/saved-articles'}
            onClick={() => show(false)}
          >
            <Bookmark size={14} /> Saved articles
          </a>
          <button
            className="tabs-history"
            onClick={() => {
              show(false)
              window.dispatchEvent(new Event('stockreplay:chat-history'))
            }}
          >
            <History size={14} /> Chat history
          </button>
        </div>
      )}
      {creating && (
        <TabEditor
          symbol={symbol}
          close={() => create(false)}
          saved={(t) => {
            create(false)
            changed()
            openTab(t.id)
          }}
        />
      )}
    </div>
  )
}

function TabEditor({
  tab,
  symbol,
  close,
  saved,
}: {
  tab?: CustomTab
  symbol: string
  close: () => void
  saved: (t: CustomTab) => void
}) {
  const [title, setTitle] = useState(tab?.title || ''),
    [blocks, setBlocks] = useState<TabBlock[]>(tab?.blocks || []),
    [view, choose] = useState<TabBlock['view']>('chart'),
    [error, fail] = useState(''),
    [busy, wait] = useState(false)
  function edit(i: number, patch: Partial<TabBlock>) {
    setBlocks((old) => old.map((b, n) => (n === i ? { ...b, ...patch } : b)))
  }
  function move(i: number, step: number) {
    setBlocks((old) => {
      const next = [...old]
      ;[next[i], next[i + step]] = [next[i + step], next[i]]
      return next
    })
  }
  return (
    <Modal
      title={tab ? 'Edit tab' : 'Create a tab'}
      close={() => {
        if (!busy) close()
      }}
    >
      <form
        className="modal-body tab-editor"
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy) return
          fail('')
          wait(true)
          try {
            const updated = await api<CustomTab>(
              tab ? '/tabs/' + tab.id : '/tabs',
              tab ? 'PUT' : 'POST',
              { title, blocks, ...(tab ? { revision: tab.revision } : {}) },
            )
            saved(updated)
          } catch (ex) {
            fail(errorText(ex))
          } finally {
            wait(false)
          }
        }}
      >
        <Field name="Tab name">
          <input
            autoFocus
            required
            maxLength={70}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Chip stocks"
          />
        </Field>
        <div className="block-edit-list">
          {blocks.map((block, i) => (
            <fieldset key={i}>
              <legend>{labels[block.view]}</legend>
              <div className="block-controls">
                <button
                  className="icon-btn"
                  type="button"
                  disabled={i === 0}
                  aria-label={'Move block ' + (i + 1) + ' up'}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  className="icon-btn"
                  type="button"
                  disabled={i === blocks.length - 1}
                  aria-label={'Move block ' + (i + 1) + ' down'}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={'Remove block ' + (i + 1)}
                  onClick={() => setBlocks((old) => old.filter((_, n) => n !== i))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {block.view === 'note' ? (
                <Field name="Note text">
                  <textarea
                    required
                    maxLength={2500}
                    rows={3}
                    value={block.value}
                    onChange={(e) => edit(i, { value: e.target.value })}
                  />
                </Field>
              ) : (
                block.view !== 'portfolio' && (
                  <Field
                    name={
                      block.view === 'watchlist'
                        ? 'Watchlist name (blank for all)'
                        : block.view === 'chart'
                          ? 'Tickers (up to four)'
                          : 'Ticker'
                    }
                  >
                    <input
                      required={block.view !== 'watchlist'}
                      value={block.value}
                      maxLength={80}
                      onChange={(e) =>
                        edit(i, {
                          value:
                            block.view === 'watchlist'
                              ? e.target.value
                              : e.target.value.toUpperCase(),
                        })
                      }
                    />
                  </Field>
                )
              )}
              {block.view === 'chart' && (
                <Field name="Chart period">
                  <select
                    value={block.span}
                    onChange={(e) => edit(i, { span: e.target.value as TabBlock['span'] })}
                  >
                    {tabSpans.map((span) => (
                      <option key={span}>{span}</option>
                    ))}
                  </select>
                </Field>
              )}
            </fieldset>
          ))}
        </div>
        <div className="block-add">
          <Field name="Block type">
            <select value={view} onChange={(e) => choose(e.target.value as TabBlock['view'])}>
              {tabViews.map((v) => (
                <option value={v} key={v}>
                  {labels[v]}
                </option>
              ))}
            </select>
          </Field>
          <button
            className="btn"
            type="button"
            disabled={blocks.length >= 20}
            onClick={() => setBlocks((old) => [...old, newBlock(view, symbol)])}
          >
            <Plus size={14} />
            Add block
          </button>
        </div>
        <ErrorBox text={error} />
        <div className="inline">
          <button disabled={busy} className="btn primary" type="submit">
            {busy ? 'Saving…' : tab ? 'Save changes' : 'Create tab'}
          </button>
          <button className="btn" disabled={busy} type="button" onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ChartBlock({ block }: { block: TabBlock }) {
  const symbols = block.value.split(',').map((s) => s.trim()),
    prices = usePrices(symbols, block.span)
  return (
    <>
      <div className="tab-widget-title">
        <h2>{symbols.join(' / ')}</h2>
        <small>{block.span}</small>
      </div>
      {prices.loading && <Busy text="Loading chart" />}
      <ErrorBox text={prices.errors.join(' ')} />
      <PricePlot series={prices.series} compact />
    </>
  )
}
type MarketBrief = {
  evidence: Source[]
  public_ratings: {
    forecast: {
      grade: string
      count: number
      source: string
      provider: string | null
      url: string
      targets: { average?: number }
    } | null
    forecast_fetched: string | null
    consensus_grade: string | null
    consensus_url: string
    consensus_fetched: string | null
  }
  fundamentals: { currency?: string }
}
function MarketBlock({ block }: { block: TabBlock }) {
  const data = useResource<MarketBrief>('/desk/brief/' + encodeURIComponent(block.value)),
    ratings = data.data?.public_ratings,
    f = ratings?.forecast,
    news = data.data?.evidence.filter((e) => e.group.endsWith('_news')) || []
  const research = '#/research/' + encodeURIComponent(block.value) + '/' + block.view
  return (
    <>
      <div className="tab-widget-title">
        <h2>{labels[block.view]}</h2>
        <a href={research}>{block.value}</a>
      </div>
      {data.loading && <Busy text={'Loading ' + block.value} />}
      <ErrorBox text={data.error} />
      {data.data &&
        (block.view === 'news' ? (
          news.length ? (
            <NewsPreviews items={news} compact limit={3} />
          ) : (
            <p>No recent articles for {block.value}.</p>
          )
        ) : (
          <div className="tab-ratings">
            {f && (
              <div>
                <strong>{f.grade}</strong>
                <span>
                  {f.count != null ? f.count + ' analysts · ' : ''}
                  {shortDay(ratings?.forecast_fetched)}
                </span>
                {f.targets.average != null && (
                  <small>
                    Average target {amount(f.targets.average, data.data.fundamentals.currency)}
                  </small>
                )}
                <SourceLink url={f.url}>
                  {f.source}
                  {f.provider ? ' · ' + f.provider : ''}
                </SourceLink>
              </div>
            )}
            {ratings?.consensus_grade && (
              <div>
                <strong>{ratings.consensus_grade.replaceAll('_', ' ')}</strong>
                <span>{shortDay(ratings.consensus_fetched)}</span>
                <SourceLink url={ratings.consensus_url}>Yahoo Finance</SourceLink>
              </div>
            )}
            {!f && !ratings?.consensus_grade && (
              <p>No published rating is available for {block.value}.</p>
            )}
          </div>
        ))}
    </>
  )
}
function WatchBlock({ name }: { name: string }) {
  const result = useResource<SavedList[]>('/watchlists'),
    lists = result.data?.filter((x) => !name || x.name.toLowerCase() === name.toLowerCase())
  return (
    <>
      <div className="tab-widget-title">
        <h2>{name || 'Watchlists'}</h2>
        <Bookmark size={16} />
      </div>
      {result.loading && <Busy text="Reading watchlists" />}
      <ErrorBox text={result.error} />
      {lists?.map((list) => (
        <div className="tab-tickers" key={list.id}>
          {!name && <strong>{list.name}</strong>}
          {list.symbols.map((s) => (
            <a key={s} href={'#/research/' + encodeURIComponent(s)}>
              {s}
            </a>
          ))}
          {!list.symbols.length && <span>No symbols yet.</span>}
        </div>
      ))}
      {lists && !lists.length && <p>Watchlist unavailable.</p>}
      <a href="#/watchlists">Manage watchlists</a>
    </>
  )
}
function PortfolioBlock() {
  const result =
      useResource<{ positions: { currency: string; value: number | null }[] }[]>('/holdings'),
    positions = result.data?.flatMap((a) => a.positions) || [],
    totals = new Map<string, number>()
  for (const p of positions)
    if (p.value != null) totals.set(p.currency, (totals.get(p.currency) || 0) + p.value)
  return (
    <>
      <h2>Portfolio totals</h2>
      {result.loading && <Busy text="Reading local portfolio" />}
      <ErrorBox text={result.error} />
      {result.data && (
        <>
          {[...totals].map(([cc, total]) => (
            <div className="tab-balance" key={cc}>
              <span>{cc}</span>
              <strong>{amount(total, cc)}</strong>
            </div>
          ))}
          {!totals.size && <p>No valued positions yet.</p>}
          <small>
            {positions.length} statement positions ·{' '}
            {positions.filter((p) => p.value == null).length} unvalued
          </small>
        </>
      )}
      <a href="#/portfolio">Open portfolio</a>
    </>
  )
}
export function CustomTabView({
  id,
  version,
  symbol,
  changed,
  onRemoved,
}: {
  id: string
  version: number
  symbol: string
  changed: () => void
  onRemoved: () => void
}) {
  const tab = useResource<CustomTab>('/tabs/' + id)
  const refreshTab = tab.reload
  const observedVersion = useRef(version)
  useEffect(() => {
    if (version !== observedVersion.current) {
      observedVersion.current = version
      refreshTab()
    }
  }, [version, refreshTab])
  const [edit, setEdit] = useState<CustomTab | null>(null),
    [remove, setRemove] = useState<CustomTab | null>(null),
    [error, fail] = useState(''),
    [busy, wait] = useState(false)
  useEffect(() => {
    if (tab.data) document.title = tab.data.title + ' · StockReplay'
  }, [tab.data])
  if (!tab.data)
    return (
      <section>
        {tab.loading ? (
          <Busy text="Opening saved tab" />
        ) : (
          <>
            <ErrorBox text={tab.error} />
            <a href="#/research">Return to Research</a>
          </>
        )}
      </section>
    )
  const data = tab.data
  return (
    <section className="custom-tab">
      <div className="page-head">
        <div>
          <h1>{data.title}</h1>
        </div>
        <div className="inline">
          <button className="btn" onClick={() => setEdit(data)}>
            <Pencil size={14} /> Edit tab
          </button>
          <button
            className="icon-btn"
            aria-label={'Delete tab ' + data.title}
            onClick={() => {
              fail('')
              setRemove(data)
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <div className="tab-widgets">
        {data.blocks.map((b, i) => (
          <section key={i} className={'panel tab-widget tab-widget-' + b.view}>
            {b.view === 'chart' ? (
              <ChartBlock block={b} />
            ) : b.view === 'news' || b.view === 'ratings' ? (
              <MarketBlock block={b} />
            ) : b.view === 'watchlist' ? (
              <WatchBlock name={b.value} />
            ) : b.view === 'portfolio' ? (
              <PortfolioBlock />
            ) : (
              <>
                <h2>Note</h2>
                <p className="tab-note">{b.value}</p>
              </>
            )}
          </section>
        ))}
      </div>
      {!data.blocks.length && (
        <div className="panel tab-empty">
          <LayoutGrid size={23} />
          <p>Add a chart, news, watchlist, portfolio total or a note.</p>
          <button className="btn" onClick={() => setEdit(data)}>
            <Plus size={15} />
            Add a block
          </button>
        </div>
      )}
      {edit && (
        <TabEditor
          tab={edit}
          symbol={symbol}
          close={() => {
            setEdit(null)
            tab.reload()
          }}
          saved={() => {
            setEdit(null)
            changed()
          }}
        />
      )}
      {remove && (
        <Modal
          title={'Delete ' + remove.title + '?'}
          close={() => {
            if (!busy) setRemove(null)
          }}
        >
          <div className="modal-body stack">
            <p>Delete this tab and its saved layout from this Mac?</p>
            <ErrorBox text={error} />
            <div className="inline">
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setRemove(null)
                  tab.reload()
                }}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={async () => {
                  wait(true)
                  try {
                    await api('/tabs/' + id + '?revision=' + remove.revision, 'DELETE')
                    changed()
                    onRemoved()
                  } catch (e) {
                    fail(errorText(e))
                    wait(false)
                  }
                }}
              >
                Delete saved tab
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}
