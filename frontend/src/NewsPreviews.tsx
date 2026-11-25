import { useState } from 'react'
import { BookOpen, Check } from 'lucide-react'
import { SourceLink } from './deskCommon'
import { Modal } from './ui'
import { ArticleBookmark } from './SavedArticles'
import { shortDay, type Source } from './workspace'
import './news-previews.css'

type Article = Source & {
  preview?: {
    images?: string[]
    byline?: string | null
    format?: 'article' | 'video'
    subscription?: boolean
  }
}

function PublisherPhoto({ urls, reader = false }: { urls: string[]; reader?: boolean }) {
  const [attempt, setAttempt] = useState(0)
  const [decoded, setDecoded] = useState('')
  const url = urls[attempt]
  if (!url) return null
  const reject = () => setAttempt((current) => (current === attempt ? current + 1 : current))
  return (
    <img
      key={url}
      src={url}
      alt=""
      decoding="async"
      loading={reader ? 'eager' : 'lazy'}
      referrerPolicy="no-referrer"
      className={decoded === url ? 'publisher-photo' : 'publisher-photo pending-photo'}
      onError={reject}
      onLoad={async ({ currentTarget: img }) => {
        try {
          await img.decode()
          if (img.naturalWidth < 128 || img.naturalHeight < 72) throw Error()
          setDecoded(url)
        } catch {
          reject()
        }
      }}
    />
  )
}

function ArticleCard({ item, cited }: { item: Article; cited: boolean }) {
  const [reading, open] = useState(false)
  const preview = item.preview
  const photos = Array.isArray(preview?.images)
    ? preview.images.filter((path) => /^\/api\/news\/images\/[\da-f]{64}$/.test(path)).slice(0, 2)
    : []
  const excerpt = item.excerpt?.trim()
  const hasExcerpt = Boolean(excerpt && excerpt.toLowerCase() !== item.text.trim().toLowerCase())
  const byline = preview?.byline && preview.byline !== item.source ? preview.byline : ''
  const source = {
    title: item.text,
    url: item.url,
    source: item.source,
    published: item.date,
    excerpt: item.excerpt,
  }
  return (
    <article className="panel story news-card">
      <PublisherPhoto key={photos.join(',')} urls={photos} />
      <div className="news-card-copy">
        <div className="news-card-meta">
          <strong>{item.source}</strong>
          <time dateTime={item.date}>{shortDay(item.date)}</time>
        </div>
        <h3>{item.text}</h3>
        {hasExcerpt && <p className="news-deck">{excerpt}</p>}
        {cited && (
          <small className="news-used">
            <Check size={13} /> Used in scores
          </small>
        )}
        <footer>
          <SourceLink url={item.url}>
            {preview?.format === 'video' ? 'Watch at source' : 'Read article'}
          </SourceLink>
          <div className="news-card-actions">
            {hasExcerpt && (
              <button
                className="news-preview-trigger"
                onClick={() => open(true)}
                aria-label={'Preview ' + item.text}
              >
                <BookOpen size={14} />
                Preview
              </button>
            )}
            <ArticleBookmark article={source} />
          </div>
        </footer>
      </div>
      {reading && (
        <Modal
          title={preview?.format === 'video' ? 'Video preview' : 'Article preview'}
          close={() => open(false)}
          wide
        >
          <div className="news-reader">
            <PublisherPhoto key={photos.join(',')} urls={photos} reader />
            <div className="news-reader-copy">
              <div className="news-card-meta">
                <strong>{item.source}</strong>
                <time dateTime={item.date}>{shortDay(item.date)}</time>
              </div>
              <h3>{item.text}</h3>
              {byline && <small>{byline}</small>}
              <p>{excerpt}</p>
              {preview?.subscription && (
                <small>The publisher marks this story as subscriber content.</small>
              )}
              <SourceLink url={item.url}>
                {preview?.format === 'video' ? 'Watch on ' : 'Read on '}
                {item.source}
              </SourceLink>
            </div>
          </div>
        </Modal>
      )}
    </article>
  )
}

export function NewsPreviews({
  items,
  citedUrls = [],
  limit = 6,
  compact = false,
}: {
  items: Source[]
  citedUrls?: string[]
  limit?: number
  compact?: boolean
}) {
  const cited = new Set(citedUrls)
  const news = items
    .filter((item) => item.group.endsWith('_news') && item.text && /^https?:\/\//i.test(item.url))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit)
  if (!news.length) return null
  return (
    <div className={'news-grid news-previews' + (compact ? ' compact-news' : '')}>
      {news.map((n) => (
        <ArticleCard key={n.id} item={n} cited={cited.has(n.url)} />
      ))}
    </div>
  )
}
