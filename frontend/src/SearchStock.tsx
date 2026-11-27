import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { api, errorText } from './types'
import { ErrorBox } from './ui'
import { tickerPattern } from './workspace'

type Match = { symbol: string; name: string }
const lookup = (query: string, online = false) =>
  api<Match[]>('/symbols?q=' + encodeURIComponent(query) + (online ? '&online=true' : ''))
const companyName = (name: string) =>
  name
    .toUpperCase()
    .replace(/[.,]/g, '')
    .replace(/\s+(?:INCORPORATED|INC|CORPORATION|CORP|LIMITED|LTD)$/, '')
    .trim()
function exactMatch(items: Match[], query: string) {
  const symbol = query.toUpperCase(),
    name = companyName(query)
  return (
    items.find((item) => item.symbol === symbol) ||
    items.find((item) => companyName(item.name) === name)
  )
}

export function SearchStock({ select }: { select: (s: string) => void }) {
  const [text, setText] = useState(''),
    [matches, setMatches] = useState<Match[]>([]),
    [focused, show] = useState(false),
    [error, fail] = useState(''),
    [busy, wait] = useState(false)
  const field = useRef<HTMLInputElement>(null),
    version = useRef(0),
    online = useRef<{ query: string; results: Promise<Match[]> } | null>(null)
  function suggestions(query: string) {
    if (online.current?.query !== query) online.current = { query, results: lookup(query, true) }
    return online.current.results
  }
  function edit(value: string) {
    version.current++
    setText(value)
    setMatches([])
    fail('')
    wait(false)
  }
  function dismiss() {
    version.current++
    show(false)
    wait(false)
  }
  function open(symbol: string) {
    edit('')
    show(false)
    field.current?.blur()
    select(symbol)
  }
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        field.current?.focus()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => {
      version.current++
      window.removeEventListener('keydown', shortcut)
    }
  }, [])
  useEffect(() => {
    const query = text.trim()
    if (!query || !focused) return
    let active = true
    const timer = setTimeout(() => {
      void suggestions(query)
        .then((items) => {
          if (active) setMatches(items)
        })
        .catch((e) => {
          if (active) fail(errorText(e))
        })
    }, 240)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [text, focused])

  async function submit() {
    const query = text.trim(),
      symbol = query.toUpperCase()
    if (!query) return
    const current = ++version.current
    wait(true)
    fail('')
    const raw = tickerPattern.test(symbol)
    try {
      // The offline catalog is immediate even when Enter beats the suggestion debounce.
      const local = await lookup(
        query.replace(/\s+(?:INCORPORATED|INC|CORPORATION|CORP|LIMITED|LTD)\.?$/i, '') || query,
      )
      if (current !== version.current) return
      const exact = exactMatch(local, query)
      if (exact) return open(exact.symbol)
      if (raw && ((query === symbol && query.length <= 6) || /[0-9.^=-]/.test(query)))
        return open(symbol)
      const found = await suggestions(query).catch(() => local)
      if (current !== version.current) return
      const match =
        exactMatch(found, query) ||
        found.find((item) => companyName(item.name).startsWith(companyName(query)))
      if (match) return open(match.symbol)
      if (raw && (query.length <= 6 || query === symbol)) return open(symbol)
      if (found[0]) return open(found[0].symbol)
      fail('Choose a matching company or enter its exchange ticker.')
    } catch (e) {
      if (current === version.current) fail(errorText(e))
    } finally {
      if (current === version.current) wait(false)
    }
  }
  return (
    <div
      className="global-search"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) dismiss()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          dismiss()
          field.current?.blur()
        }
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Search size={16} />
        <input
          ref={field}
          aria-label="Search stocks"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Ticker or company name"
          value={text}
          maxLength={70}
          onChange={(e) => edit(e.target.value)}
          onFocus={() => show(true)}
        />
        {text ? (
          <button
            type="button"
            className="bare"
            aria-label="Clear search"
            onClick={() => {
              edit('')
              field.current?.focus()
            }}
          >
            <X size={14} />
          </button>
        ) : (
          <kbd>⌘ K</kbd>
        )}
      </form>
      {focused && text && (
        <div
          className="suggest"
          aria-busy={busy}
          onMouseDown={(e) => {
            // Safari blurs the input before click without focusing the pressed button.
            if (e.button === 0 && (e.target as Element).closest('button')) e.preventDefault()
          }}
        >
          <button onClick={() => void submit()}>
            {busy ? 'Looking up ticker…' : 'Search for “' + text + '”'}
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
