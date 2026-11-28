import { useState, type MouseEvent } from 'react'
import { ArrowUpRight, ChevronDown, CornerDownRight } from 'lucide-react'
import { validRangeFocus } from './priceRanges'
import { fromFutureFocus, futureHref } from './forecastSnapshot'
import { ChatGraph } from './PricePlot'
import { amount, tickerPattern, type Page } from './workspace'
import type { ChatLink, Entry, Row } from './chatHistory'

const pages: Page[] = ['Portfolio', 'Watchlists', 'Settings', 'Research', 'Calendar']
const focuses = [
  '',
  'news',
  'ratings',
  'scores',
  'tools',
  'import-guide',
  'holdings',
  'prices',
  'watchlist',
  'saved-articles',
]
export function linkUrl(link: ChatLink, symbol: string) {
  if (link.tab) return /^[a-f0-9]{32}$/.test(link.tab) ? '#/tabs/' + link.tab : null
  const future = link.page === 'Research' ? fromFutureFocus(link.focus || '') : null
  if (
    !pages.includes(link.page) ||
    (!focuses.includes(link.focus || '') &&
      !future &&
      !(link.page === 'Research' && validRangeFocus(link.focus || '')))
  )
    return null
  const asset = (link.symbol || symbol).toUpperCase()
  if (!tickerPattern.test(asset)) return null
  if (future) return futureHref(asset, future.preset, future.start, future.end)
  return (
    '#/' +
    link.page.toLowerCase() +
    '/' +
    encodeURIComponent(asset) +
    (link.focus ? '/' + link.focus : '')
  )
}
type NavProps = { symbol: string; follow: (link: ChatLink) => void }
export function ChatAnchor({ link, symbol, follow }: { link: ChatLink } & NavProps) {
  const href = linkUrl(link, symbol)
  if (!href) return null
  function click(e: MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    follow(link)
  }
  return (
    <a className="chat-link" href={href} onClick={click}>
      <CornerDownRight size={12} aria-hidden />
      <span>{link.label}</span>
    </a>
  )
}
function shortText(text: string, words: number, chars: number) {
  const plain = text.replace(/\s+/g, ' ').trim()
  if (plain.length <= chars && plain.split(' ').length <= words) return null
  const lead = plain.split(' ').slice(0, words).join(' ')
  return (lead.length > chars ? lead.slice(0, chars).replace(/\s+\S*$/, '') : lead).trimEnd() + '…'
}
function StyledText({ text, entry, symbol, follow }: { text: string; entry: Entry } & NavProps) {
  // Links in prose must match an app destination or a source supplied with this answer.
  return (
    <>
      {text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]{1,140}\]\([^\s)]+\))/g).map((token, i) => {
        if (token.startsWith('**') && token.endsWith('**'))
          return <strong key={i}>{token.slice(2, -2)}</strong>
        if (token.startsWith('`') && token.endsWith('`'))
          return <code key={i}>{token.slice(1, -1)}</code>
        const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
        if (!match || entry.role === 'user') return token
        const [, label, href] = match
        const internal = entry.links?.find(
          (link) => linkUrl(link, symbol) === href || '/' + linkUrl(link, symbol) === href,
        )
        if (internal)
          return (
            <ChatAnchor key={i} link={{ ...internal, label }} symbol={symbol} follow={follow} />
          )
        if (sourceUrl(href) && entry.sources?.some((s) => sourceUrl(s.url) === sourceUrl(href)))
          return (
            <a key={i} href={href} rel="noopener noreferrer" target="_blank">
              {label}
            </a>
          )
        return label
      })}
    </>
  )
}
function Text({ entry, symbol, follow }: { entry: Entry } & NavProps) {
  const [expanded, toggle] = useState(false),
    preview = shortText(
      entry.text,
      entry.role === 'assistant' ? 26 : 34,
      entry.role === 'assistant' ? 158 : 210,
    )
  return (
    <>
      <p className="chat-text">
        <StyledText
          text={preview && !expanded ? preview : entry.text}
          entry={entry}
          symbol={symbol}
          follow={follow}
        />
      </p>
      {preview && (
        <button
          className="chat-readmore"
          aria-expanded={expanded}
          onClick={() => toggle(!expanded)}
        >
          {expanded ? 'Show less' : 'Read more'} <ChevronDown size={12} />
        </button>
      )}
    </>
  )
}
function LocalRows({ rows, allocation }: { rows: Row[]; allocation: boolean }) {
  return (
    <details className="chat-result">
      <summary>
        {allocation ? 'Allocation' : 'Positions'} · {rows.length}
      </summary>
      <div className="chat-scroll-detail">
        {[...new Set(rows.map((r) => r.currency))].map((c) => {
          const selected = rows.filter((r) => r.currency === c),
            gross = selected.reduce((sum, r) => sum + Math.abs(r.value || 0), 0)
          return (
            <div className="local-values" key={c}>
              <strong>
                {amount(
                  selected.reduce((sum, r) => sum + (r.value || 0), 0),
                  c,
                )}{' '}
                net · {c}
              </strong>
              {selected.map((r, i) => (
                <div key={i}>
                  <span>{r.name}</span>
                  <b>{amount(r.value, c)}</b>
                  {allocation && r.value != null && gross > 0 && (
                    <meter
                      aria-label={r.name + ' share of gross exposure'}
                      min={0}
                      max={gross}
                      value={Math.abs(r.value)}
                    />
                  )}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </details>
  )
}
function sourceUrl(raw: string) {
  try {
    const url = new URL(raw)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}
export function ChatMessage({
  entry: e,
  symbol,
  follow,
  busy,
  decide,
}: {
  entry: Entry
  busy: boolean
  decide: (e: Entry, yes: boolean) => void
} & NavProps) {
  const refs = (e.sources || []).filter((s) => sourceUrl(s.url))
  const links = (e.links || []).filter(
    (l, i, a) =>
      linkUrl(l, symbol) && a.findIndex((x) => linkUrl(x, symbol) === linkUrl(l, symbol)) === i,
  )
  return (
    <article
      className={'chat-entry' + (e.error ? ' chat-error' : '')}
      data-speaker={e.role}
      aria-label={e.role === 'user' ? 'Your message' : 'Assistant response'}
    >
      <Text entry={e} symbol={symbol} follow={follow} />
      {e.graph && <ChatGraph {...e.graph} />}
      {!!e.rows?.length && <LocalRows rows={e.rows} allocation={!!e.allocation} />}
      {!!links.length && (
        <div className="chat-links">
          {links.map((l) => (
            <ChatAnchor link={l} key={linkUrl(l, symbol)} symbol={symbol} follow={follow} />
          ))}
        </div>
      )}
      {!!refs.length && (
        <details className="chat-result chat-sources">
          <summary>
            {refs.length} {refs.length === 1 ? 'source' : 'sources'}
          </summary>
          <div className="chat-scroll-detail">
            {refs.map((s, i) => (
              <a
                key={s.id + '-' + i}
                href={sourceUrl(s.url)!}
                rel="noopener noreferrer"
                target="_blank"
              >
                <span>
                  <small>
                    {s.source} · {(s.date || '').slice(0, 10)}
                    {s.scope ? ' · ' + s.scope : ''}
                  </small>
                  {s.text}
                </span>
                <ArrowUpRight size={13} />
              </a>
            ))}
          </div>
        </details>
      )}
      {e.confirmation?.pending && (
        <div className="inline">
          <button className="btn small" disabled={busy} onClick={() => decide(e, false)}>
            Cancel
          </button>
          <button className="btn small primary" disabled={busy} onClick={() => decide(e, true)}>
            Apply change
          </button>
        </div>
      )}
      {e.confirmation?.expired && <small>Expired. Ask again to apply this change.</small>}
    </article>
  )
}
