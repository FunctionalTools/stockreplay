import { useEffect, useRef, useState } from 'react'
import { Bookmark, BriefcaseBusiness, ChartNoAxesCombined, Settings as Gear } from 'lucide-react'
import { Research } from './Research'
import { ForecastCalendar } from './ForecastCalendar'
import { fromFutureFocus, futureHref } from './forecastSnapshot'
import { calendarHref, calendarSelection, type CalendarSelection } from './forecastData'
import { SearchStock } from './SearchStock'
import { ResearchHome, type HomeContext } from './ResearchHome'
import { validRangeFocus } from './priceRanges'
import { useResource } from './deskCommon'
import { Watchlists } from './Watch'
import { HoldingsPage } from './Positions'
import { PriceFiles } from './PriceFiles'
import { Settings } from './Settings'
import { Assistant } from './Assistant'
import { MyTabs, CustomTabView } from './CustomTabView'
import { tabHref } from './customTabs'
import { api, errorText } from './types'
import { ErrorBox } from './ui'
import {
  firstPreferences,
  tickerPattern,
  type Page,
  type Preferences,
  type Connection,
  type Intent,
} from './workspace'

const pages: Page[] = ['Research', 'Watchlists', 'Portfolio', 'Settings', 'Calendar']
const nav = [
  { name: 'Research' as const, icon: ChartNoAxesCombined },
  { name: 'Watchlists' as const, icon: Bookmark },
  { name: 'Portfolio' as const, icon: BriefcaseBusiness },
]
const deepLinks: Record<Page, string[]> = {
  Research: ['future', 'news', 'ratings', 'scores', 'tools', 'saved-articles'],
  Portfolio: ['import-guide', 'holdings', 'prices', 'account'],
  Watchlists: ['watchlist'],
  Settings: [],
  Calendar: [],
}
function allowsFocus(page: Page, focus: string) {
  return (
    deepLinks[page].includes(focus) || (page === 'Research' && !!focus && validRangeFocus(focus))
  )
}
function readRoute() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?')
  const parts = path.split('/')
  const tabId = parts[0] === 'tabs' && /^[0-9a-f]{32}$/.test(parts[1] || '') ? parts[1] : ''
  const page = pages.find((p) => p.toLowerCase() === parts[0]) || 'Research'
  let ticker = ''
  try {
    ticker = decodeURIComponent(parts[1] || '').toUpperCase()
  } catch {
    /* Invalid pasted address. */
  }
  return {
    page,
    query,
    symbol: tickerPattern.test(ticker) ? ticker : '',
    tabId,
    focus:
      page === 'Research' && !tabId && new URLSearchParams(query).get('view') === 'future'
        ? 'future'
        : !tabId && allowsFocus(page, parts[2] || '')
          ? parts[2]
          : '',
  }
}
export default function App() {
  const [route, setRoute] = useState(readRoute),
    [prefs, setPrefs] = useState<Preferences>(firstPreferences),
    [ready, setReady] = useState(false),
    [connection, connected] = useState<Connection | null>(null),
    [err, fail] = useState(''),
    [seq, refresh] = useState(0),
    [intent, setIntent] = useState<Intent>(() => ({ kind: route.focus, seq: route.focus ? 1 : 0 }))
  const committed = useRef(firstPreferences),
    pending = useRef(new Map<number, Partial<Preferences>>()),
    writes = useRef(Promise.resolve()),
    writeId = useRef(0)
  const {
    data: home,
    error: homeError,
    loading: loadingHome,
    reload: reloadHome,
  } = useResource<HomeContext>('/home')
  const startingSymbol =
      prefs.home_mode === 'ticker' ? prefs.home_symbol : home?.portfolio_symbol || 'SPY',
    symbol = route.symbol || startingSymbol,
    page = route.page
  const opening =
    !ready ||
    (!route.tabId &&
      (page === 'Research' || page === 'Calendar') &&
      !route.symbol &&
      prefs.home_mode === 'portfolio' &&
      !home &&
      loadingHome)
  useEffect(() => {
    const reload = () => reloadHome()
    window.addEventListener('stockreplay:holdings-changed', reload)
    window.addEventListener('focus', reload)
    return () => {
      window.removeEventListener('stockreplay:holdings-changed', reload)
      window.removeEventListener('focus', reload)
    }
  }, [reloadHome])
  useEffect(() => {
    let active = true
    void Promise.allSettled([api<Preferences>('/preferences'), api<Connection>('/ai')]).then(
      ([p, c]) => {
        if (!active) return
        if (p.status === 'fulfilled') {
          committed.current = p.value
          setPrefs(p.value)
        } else fail(errorText(p.reason))
        if (c.status === 'fulfilled') connected(c.value)
        else fail(errorText(c.reason))
        setReady(true)
      },
    )
    const pop = () => {
      const next = readRoute()
      setRoute(next)
      setIntent((prev) => ({ kind: next.focus, seq: prev.seq + 1 }))
      if (!next.focus) window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', pop)
    return () => {
      active = false
      window.removeEventListener('hashchange', pop)
    }
  }, [])
  useEffect(() => {
    document.documentElement.dataset.mode = prefs.appearance
    document.documentElement.dataset.accent = prefs.accent
  }, [prefs])
  useEffect(() => {
    if (page !== 'Settings' || !ready) return
    let active = true
    void api<Connection>('/ai')
      .then((value) => {
        if (active) connected(value)
      })
      .catch((e) => {
        if (active) fail(errorText(e))
      })
    return () => {
      active = false
    }
  }, [page, ready])
  function save(p: Partial<Preferences>) {
    if (p.home_symbol && !p.home_mode) p = { ...p, home_mode: 'ticker' }
    const id = ++writeId.current
    pending.current.set(id, p)
    setPrefs((previous) => ({ ...previous, ...p }))
    const next = writes.current.then(async () => {
      try {
        committed.current = await api<Preferences>('/preferences', 'PATCH', p)
      } finally {
        pending.current.delete(id)
        setPrefs(Object.assign({}, committed.current, ...pending.current.values()))
      }
    })
    writes.current = next.catch(() => {})
    return next
  }
  function changeResearchChart(href: string) {
    if (location.hash !== href) history.pushState(null, '', href)
    const next = readRoute()
    setRoute(next)
    setIntent((prev) => ({ kind: next.focus, seq: prev.seq + 1 }))
  }
  function go(p: Page, s?: string, focus = '') {
    const future = p === 'Research' ? fromFutureFocus(focus) : null
    if (future) {
      changeResearchChart(
        futureHref((s || symbol).toUpperCase(), future.preset, future.start, future.end),
      )
      return
    }
    const next = {
      page: p,
      query: '',
      symbol: (s || (focus ? symbol : p === 'Research' ? '' : route.symbol)).toUpperCase(),
      tabId: '',
      focus: allowsFocus(p, focus) ? focus : '',
    }
    const newHash =
      '#/' +
      p.toLowerCase() +
      (next.symbol ? '/' + next.symbol : '') +
      (next.focus ? '/' + next.focus : '')
    if (location.hash !== newHash) history.pushState(null, '', newHash)
    setRoute(next)
    setIntent((v) => ({ kind: focus, seq: v.seq + 1 }))
    if (!focus) window.scrollTo(0, 0)
  }
  function changeCalendar(selection: CalendarSelection) {
    const href = calendarHref(selection)
    if (location.hash !== href) history.pushState(null, '', href)
    setRoute(readRoute())
  }
  function selectTicker(s: string) {
    void save({ home_mode: 'ticker', home_symbol: s }).catch((e) => fail(errorText(e)))
    go('Research', s)
  }
  function followHoldings() {
    void save({ home_mode: 'portfolio' }).catch((e) => fail(errorText(e)))
    go('Research')
  }
  function openTab(id: string) {
    if (!id) {
      go('Research')
      return
    }
    if (!/^[0-9a-f]{32}$/.test(id)) return
    if (location.hash !== tabHref(id)) history.pushState(null, '', tabHref(id))
    setRoute({ page: 'Research', query: '', symbol: route.symbol, tabId: id, focus: '' })
    setIntent((v) => ({ kind: '', seq: v.seq + 1 }))
    window.scrollTo(0, 0)
  }
  useEffect(() => {
    if (route.tabId) return
    document.title = opening
      ? 'StockReplay'
      : (page === 'Research' ? symbol : page) + ' · StockReplay'
  }, [page, symbol, route.tabId, opening])
  return (
    <>
      <header className="topbar">
        <div className="top-inner">
          <button className="brand" onClick={() => go('Research')} aria-label="StockReplay home">
            <svg width="29" height="29" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="9" fill="var(--accent)" />
              <path
                d="M7 20l6-6 4 4 8-10m-7 0h7v7"
                stroke="var(--on-accent)"
                strokeWidth="2.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
            StockReplay
          </button>
          <div className="nav-cluster">
            <nav aria-label="Main navigation">
              {nav.map(({ name, icon: Icon }) => (
                <button
                  key={name}
                  aria-current={!route.tabId && page === name ? 'page' : undefined}
                  onClick={() => go(name)}
                >
                  <Icon size={16} />
                  {name}
                </button>
              ))}
            </nav>
            <MyTabs
              active={route.tabId}
              openTab={openTab}
              symbol={symbol}
              version={seq}
              changed={() => refresh((n) => n + 1)}
            />
          </div>
          <div className="header-right">
            {(page !== 'Research' || route.tabId) && <SearchStock select={selectTicker} />}
            <button
              className={'icon-btn settings-link ' + (page === 'Settings' ? 'selected' : '')}
              aria-label="Settings"
              aria-current={page === 'Settings' ? 'page' : undefined}
              onClick={() => go('Settings')}
            >
              <Gear size={19} />
            </button>
          </div>
        </div>
      </header>
      <main id="main">
        <ErrorBox text={err} />
        {!opening && (
          <>
            {route.tabId && (
              <CustomTabView
                key={route.tabId}
                id={route.tabId}
                symbol={symbol}
                version={seq}
                changed={() => refresh((n) => n + 1)}
                onRemoved={() => go('Research')}
              />
            )}
            {!route.tabId && page === 'Research' && (
              <>
                {homeError && (
                  <div>
                    <ErrorBox text={homeError} />
                    <button className="text-btn" onClick={() => reloadHome()}>
                      Retry holdings
                    </button>
                  </div>
                )}
                <ResearchHome
                  home={home}
                  mode={prefs.home_mode}
                  symbol={symbol}
                  startingSymbol={startingSymbol}
                  choose={selectTicker}
                  follow={followHoldings}
                  guide={() => go('Portfolio', symbol, 'import-guide')}
                  portfolio={() => go('Portfolio')}
                >
                  <SearchStock select={selectTicker} />
                </ResearchHome>
                <Research
                  key={symbol}
                  symbol={symbol}
                  connection={connection}
                  settings={() => go('Settings')}
                  advanced={prefs.advanced}
                  onAdvanced={() => save({ advanced: true })}
                  updateSeq={seq}
                  intent={intent}
                  query={route.query}
                  changeChart={changeResearchChart}
                />
              </>
            )}
            {page === 'Calendar' && (
              <ForecastCalendar
                selection={calendarSelection(symbol, route.query)}
                change={changeCalendar}
              />
            )}
            {page === 'Watchlists' && (
              <Watchlists
                key={'w' + seq + intent.seq}
                go={(_, s) => (s ? selectTicker(s) : go('Research'))}
                symbol={symbol}
                importOnOpen={intent.kind === 'watchlist'}
              />
            )}
            {page === 'Portfolio' && (
              <div key={'p' + seq + intent.seq}>
                <HoldingsPage initialAction={intent.kind} />
                <PriceFiles open={intent.kind === 'prices'} />
              </div>
            )}
            {page === 'Settings' && (
              <Settings prefs={prefs} save={save} connection={connection} changed={connected} />
            )}
          </>
        )}
        {opening && <p role="status">Opening your workspace…</p>}
      </main>
      <Assistant
        page={page}
        portfolioContext={
          prefs.home_mode === 'portfolio' &&
          home?.portfolio_symbol === symbol &&
          (!route.symbol || page !== 'Research' || !!route.tabId)
        }
        openTab={openTab}
        currentTab={route.tabId || undefined}
        symbol={symbol}
        connection={connection}
        navigate={go}
        save={save}
        updated={() => {
          refresh((n) => n + 1)
          reloadHome()
        }}
        connected={connected}
      />
    </>
  )
}
