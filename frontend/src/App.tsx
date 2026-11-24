import { useEffect, useRef, useState } from 'react'
import {
  Bookmark,
  BriefcaseBusiness,
  ChartNoAxesCombined,
  Search,
  Settings as Gear,
  X,
} from 'lucide-react'
import { Research } from './Research'
import { Watchlists } from './Watch'
import { HoldingsPage } from './Positions'
import { PriceFiles } from './PriceFiles'
import { Settings } from './Settings'
import { Assistant } from './Assistant'
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

const pages: Page[] = ['Research', 'Watchlists', 'Portfolio', 'Settings']
const nav = [
  { name: 'Research' as const, icon: ChartNoAxesCombined },
  { name: 'Watchlists' as const, icon: Bookmark },
  { name: 'Portfolio' as const, icon: BriefcaseBusiness },
]
function readRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/')
  const page = pages.find((p) => p.toLowerCase() === parts[0]) || 'Research'
  const s = (parts[1] || '').toUpperCase()
  return { page, symbol: tickerPattern.test(s) ? s : '' }
}
function SearchStock({ select }: { select: (s: string) => void }) {
  const [text, type] = useState(''),
    [matches, set] = useState<{ symbol: string; name: string }[]>([]),
    [focus, show] = useState(false),
    [error, fail] = useState('')
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        field.current?.focus()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  useEffect(() => {
    let active = true
    set([])
    fail('')
    if (!text.trim()) return
    const t = setTimeout(() => {
      void api<{ symbol: string; name: string }[]>(
        '/symbols?q=' + encodeURIComponent(text.trim()) + '&online=true',
      )
        .then((v) => {
          if (active) set(v)
        })
        .catch((e) => {
          if (active) fail(errorText(e))
        })
    }, 240)
    return () => {
      active = false
      clearTimeout(t)
    }
  }, [text])
  function open(s: string) {
    select(s)
    type('')
    show(false)
    field.current?.blur()
  }
  return (
    <div
      className="global-search"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) show(false)
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const s = text.trim().toUpperCase()
          const exact = matches.find((m) => m.symbol === s || m.name.toUpperCase() === s)
          if (exact) open(exact.symbol)
          else if (tickerPattern.test(s)) open(s)
          else if (matches[0]) open(matches[0].symbol)
          else fail('Enter a ticker or choose a matching company.')
        }}
      >
        <Search size={16} />
        <input
          ref={field}
          aria-label="Search stocks"
          placeholder="Search stocks"
          value={text}
          maxLength={70}
          onChange={(e) => type(e.target.value)}
          onFocus={() => show(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              show(false)
              field.current?.blur()
            }
          }}
        />
        {text ? (
          <button type="button" className="bare" aria-label="Clear search" onClick={() => type('')}>
            <X size={14} />
          </button>
        ) : (
          <kbd>⌘ K</kbd>
        )}
      </form>
      {focus && text && (
        <div className="suggest">
          <button
            onClick={() => {
              const s = text.trim().toUpperCase()
              if (tickerPattern.test(s)) open(s)
              else if (matches[0]) open(matches[0].symbol)
            }}
          >
            Search for “{text}”
          </button>
          {matches.map((m) => (
            <button key={m.symbol} onClick={() => open(m.symbol)}>
              <b>{m.symbol}</b>
              <small>{m.name}</small>
            </button>
          ))}
          <ErrorBox text={error} />
        </div>
      )}
    </div>
  )
}
export default function App() {
  const [route, setRoute] = useState(readRoute),
    [prefs, setPrefs] = useState<Preferences>(firstPreferences),
    [ready, setReady] = useState(false),
    [connection, connected] = useState<Connection | null>(null),
    [err, fail] = useState(''),
    [seq, refresh] = useState(0),
    [intent, setIntent] = useState<Intent>({ kind: '', seq: 0 })
  const committed = useRef(firstPreferences),
    pending = useRef(new Map<number, Partial<Preferences>>()),
    writes = useRef(Promise.resolve()),
    writeId = useRef(0)
  const symbol = route.symbol || prefs.home_symbol,
    page = route.page
  useEffect(() => {
    let active = true
    void Promise.all([api<Preferences>('/preferences'), api<Connection>('/openai')])
      .then(([p, c]) => {
        if (active) {
          committed.current = p
          setPrefs(p)
          connected(c)
        }
      })
      .catch((e) => {
        if (active) fail(errorText(e))
      })
      .finally(() => {
        if (active) setReady(true)
      })
    const pop = () => {
      setRoute(readRoute())
      setIntent({ kind: '', seq: 0 })
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
    void api<Connection>('/openai')
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
  function go(p: Page, s?: string, focus = '') {
    const next = { page: p, symbol: (s || symbol).toUpperCase() }
    const newHash = '#/' + p.toLowerCase() + '/' + next.symbol
    if (location.hash !== newHash) history.pushState(null, '', newHash)
    setRoute(next)
    setIntent((v) => ({ kind: focus, seq: v.seq + 1 }))
    if (!focus) window.scrollTo(0, 0)
  }
  useEffect(() => {
    document.title = page === 'Research' ? symbol + ' · StockReplay' : page + ' · StockReplay'
  }, [page, symbol])
  return (
    <>
      <header className="topbar">
        <div className="top-inner">
          <button
            className="brand"
            onClick={() => go('Research', prefs.home_symbol)}
            aria-label="StockReplay home"
          >
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
          <nav aria-label="Main navigation">
            {nav.map(({ name, icon: Icon }) => (
              <button
                key={name}
                aria-current={page === name ? 'page' : undefined}
                onClick={() => go(name)}
              >
                <Icon size={16} />
                {name}
              </button>
            ))}
          </nav>
          <div className="header-right">
            <SearchStock select={(s) => go('Research', s)} />
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
        {ready && (
          <>
            {page === 'Research' && (
              <Research
                key={symbol}
                symbol={symbol}
                connection={connection}
                settings={() => go('Settings')}
                advanced={prefs.advanced}
                onAdvanced={() => save({ advanced: true })}
                updateSeq={seq}
                intent={intent}
              />
            )}
            {page === 'Watchlists' && (
              <Watchlists
                key={'w' + seq + intent.seq}
                go={(_, s) => go('Research', s)}
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
        {!ready && <p role="status">Opening your workspace…</p>}
      </main>
      <Assistant
        page={page}
        symbol={symbol}
        connection={connection}
        navigate={go}
        save={save}
        updated={() => refresh((n) => n + 1)}
        connected={connected}
      />
    </>
  )
}
