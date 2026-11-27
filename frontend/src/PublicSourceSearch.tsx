import { useState, type FormEvent } from 'react'
import { BookOpen, Search } from 'lucide-react'
import { SourceLink } from './deskCommon'
import { Busy, ErrorBox } from './ui'
import { api, errorText } from './types'
import { shortDay, type Source } from './workspace'
import './public-sources.css'

export type PublicSearch = {
  symbol: string
  query: string
  checked: string
  evidence: Source[]
  coverage: { provider: string; status: string; count: number; checked: string; note: string }[]
}

export function PublicSourceSearch({
  symbol,
  initial,
}: {
  symbol: string
  initial?: PublicSearch
}) {
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState<PublicSearch | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = searched || initial
  async function search(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api<PublicSearch>(
        '/desk/web-research/' + encodeURIComponent(symbol),
        'POST',
        { question: query.trim() || symbol },
      )
      setSearched(result)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="panel public-sources" id="web-research">
      <summary>
        <span>
          <BookOpen size={17} aria-hidden="true" /> Search articles and filings
        </span>
        <small>{current ? current.evidence.length + ' sources' : symbol}</small>
      </summary>
      <div className="source-search-body">
        <form onSubmit={search}>
          <label htmlFor="source-search-topic">Research topic for {symbol}</label>
          <div>
            <input
              id="source-search-topic"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={220}
              placeholder="Earnings, cash flow, competition…"
            />
            <button className="btn" disabled={busy} type="submit">
              {busy ? (
                <Busy text="Searching" />
              ) : (
                <>
                  <Search size={14} /> Search sources
                </>
              )}
            </button>
          </div>
          <small>
            Your company search and topic words go to public sources. No AI account is required.
          </small>
        </form>
        <ErrorBox text={error} />
        {current && (
          <>
            <p role="status">
              Results for <strong>{current.query}</strong> · Checked {shortDay(current.checked)}
            </p>
            <ul className="document-list">
              {current.evidence.map((s) => (
                <li key={s.id}>
                  <div>
                    <small>
                      {s.scope} · {s.source}
                    </small>
                    <h3>{s.text}</h3>
                  </div>
                  {s.excerpt && <blockquote>{s.excerpt}</blockquote>}
                  <footer>
                    <SourceLink url={s.url}>Original source</SourceLink>
                    <small>
                      {s.date_origin} · {shortDay(s.date)}
                    </small>
                    {s.stale && <small>Cached</small>}
                  </footer>
                  <small>
                    Found via {s.discovered_via}
                    {s.read_note &&
                      (s.excerpt
                        ? ' · Showing a previously read passage'
                        : ' · Publisher text unavailable')}
                  </small>
                </li>
              ))}
            </ul>
            {!current.evidence.length && <p>No dated documents were available for this search.</p>}
            <details>
              <summary>Search coverage</summary>
              {current.coverage.map((c) => (
                <p key={c.provider}>
                  <strong>{c.provider}</strong> · {c.status} · {c.count} sources ·{' '}
                  {shortDay(c.checked)}
                  {c.note && <small> {c.note}</small>}
                </p>
              ))}
            </details>
          </>
        )}
      </div>
    </details>
  )
}
