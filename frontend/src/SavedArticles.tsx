import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Bookmark, BookmarkCheck, BookOpen, Trash2 } from 'lucide-react'
import { api, errorText } from './types'
import { Busy, ErrorBox, Modal } from './ui'
import { shortDay } from './workspace'
import './saved-articles.css'

export type ArticleReference = {
  url: string
  title: string
  source: string
  published: string
  excerpt?: string | null
}
type SavedArticle = ArticleReference & { id: string; saved_at: string }
type ReadingList = {
  entries: SavedArticle[] | null
  error: string
  open: () => void
  reload: () => Promise<void>
  save: (article: ArticleReference) => Promise<void>
  remove: (id: string) => Promise<void>
}
const ReadingListContext = createContext<ReadingList | null>(null)
const endpoint = '/reading-list'

export function ReadingListProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<SavedArticle[] | null>(null)
  const [error, setError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const open = useCallback(() => setDialogOpen(true), [])
  const queryVersion = useRef(0)
  const channel = useRef<BroadcastChannel | null>(null)
  const reload = useCallback(async () => {
    const version = ++queryVersion.current
    try {
      const rows = await api<SavedArticle[]>(endpoint)
      if (queryVersion.current === version) {
        setEntries(rows)
        setError('')
      }
    } catch (e) {
      if (queryVersion.current === version) setError(errorText(e))
    }
  }, [])
  useEffect(() => {
    void reload()
    window.addEventListener('focus', reload)
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('stockreplay-reading-list')
      channel.current.onmessage = () => void reload()
    }
    return () => {
      queryVersion.current++
      window.removeEventListener('focus', reload)
      channel.current?.close()
      channel.current = null
    }
  }, [reload])
  async function save(article: ArticleReference) {
    const row = await api<SavedArticle>(endpoint, 'PUT', article)
    queryVersion.current++
    setEntries((items) => [row, ...(items || []).filter((a) => a.id !== row.id)])
    setError('')
    channel.current?.postMessage('updated')
  }
  async function remove(id: string) {
    await api(endpoint + '/' + id, 'DELETE')
    queryVersion.current++
    setEntries((items) => (items || []).filter((a) => a.id !== id))
    setError('')
    channel.current?.postMessage('updated')
  }
  return (
    <ReadingListContext.Provider value={{ entries, error, reload, save, remove, open }}>
      {children}
      {dialogOpen && <ReadingListDialog close={() => setDialogOpen(false)} />}
    </ReadingListContext.Provider>
  )
}

function useReadingList() {
  const value = useContext(ReadingListContext)
  if (!value) throw Error('Reading list provider is missing.')
  return value
}

function articleKey(url: string) {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    return url
  }
}

export function ArticleBookmark({ article }: { article: ArticleReference }) {
  const { entries, save, remove } = useReadingList()
  const [busy, setBusy] = useState(false)
  const [error, fail] = useState('')
  const saved = entries?.find((a) => a.url === articleKey(article.url))
  const title = (saved ? 'Unsave ' : 'Save ') + article.title
  return (
    <span className="article-bookmark">
      <button
        type="button"
        className="icon-btn article-save"
        disabled={busy || !entries}
        title={title}
        aria-label={title}
        aria-pressed={Boolean(saved)}
        onClick={async () => {
          setBusy(true)
          try {
            if (saved) await remove(saved.id)
            else await save(article)
            fail('')
          } catch (e) {
            fail(errorText(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        {saved ? (
          <BookmarkCheck size={16} aria-hidden="true" />
        ) : (
          <Bookmark size={16} aria-hidden="true" />
        )}
      </button>
      {error && <small role="alert">{error}</small>}
    </span>
  )
}

export function OpenSavedArticles({ request }: { request?: number }) {
  const { open } = useReadingList()
  useEffect(() => {
    if (request !== undefined) open()
  }, [open, request])
  return null
}

export function SavedArticlesMenu() {
  const { open, entries } = useReadingList()
  return (
    <button
      type="button"
      className="btn small saved-articles-trigger"
      onClick={open}
      aria-haspopup="dialog"
    >
      <BookOpen size={15} aria-hidden="true" /> Saved articles
      {entries?.length ? ' (' + entries.length + ')' : ''}
    </button>
  )
}

function ReadingListDialog({ close }: { close: () => void }) {
  const { entries, error, reload, remove } = useReadingList()
  const [search, setSearch] = useState(''),
    [failure, fail] = useState(''),
    [busy, wait] = useState('')
  useEffect(() => {
    void reload()
  }, [reload])
  const term = search.trim().toLowerCase()
  const results = (entries || []).filter((a) =>
    (a.title + ' ' + a.source).toLowerCase().includes(term),
  )
  return (
    <Modal title="Saved articles" close={close}>
      <div className="modal-body reading-list-body">
        <ErrorBox text={failure || error} />
        {error && (
          <button type="button" className="btn small" onClick={() => void reload()}>
            Try again
          </button>
        )}
        {!entries && !error && <Busy text="Loading saved articles" />}
        {entries?.length === 0 && <p>Tap the bookmark on a news story to save it here.</p>}
        {entries && entries.length > 1 && (
          <label className="field">
            <span>Find a saved article</span>
            <input
              type="search"
              placeholder="Title or publisher"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        )}
        {entries && entries.length > 0 && !results.length && <p>No matching articles.</p>}
        <ul className="reading-list-items">
          {results.map((a) => (
            <li key={a.id}>
              <div>
                <small>
                  {a.source} · {shortDay(a.published)}
                </small>
                <a href={a.url} target="_blank" rel="noopener noreferrer">
                  {a.title}
                </a>
                {a.excerpt && <p>{a.excerpt}</p>}
              </div>
              <button
                type="button"
                className="icon-btn"
                title="Remove bookmark"
                aria-label={'Remove ' + a.title + ' from saved articles'}
                disabled={busy === a.id}
                onClick={async () => {
                  wait(a.id)
                  try {
                    await remove(a.id)
                    fail('')
                  } catch (e) {
                    fail(errorText(e))
                  } finally {
                    wait('')
                  }
                }}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
