import { useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, List } from 'lucide-react'
import { shortDay } from './workspace'
import { SourceLink } from './deskCommon'
import { dayTime, type MarketEvent } from './forecastCalendar'

export function EventCard({ event, compact = false }: { event: MarketEvent; compact?: boolean }) {
  return (
    <article
      className={'forecast-event-card' + (compact ? ' compact' : '')}
      aria-label="Event preview"
    >
      <small>
        {shortDay(event.date)}
        {event.end_date && event.end_date !== event.date
          ? ' – ' + shortDay(event.end_date)
          : ''} · {event.status}
      </small>
      <h3>{event.title}</h3>
      <small>
        {event.symbols.length ? event.symbols.join(', ') : 'Market-wide'} · {event.kind}
      </small>
      {event.excerpt && <p>{event.excerpt}</p>}
      {event.relevance && (
        <p>
          <strong>Why it matters</strong> {event.relevance}
        </p>
      )}
      <SourceLink url={event.url}>{event.source}</SourceLink>
      {!compact && event.checked_at && <small> · Checked {shortDay(event.checked_at)}</small>}
    </article>
  )
}
const monthText = (d: string) =>
  new Date(dayTime(d + '-01')).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
const dayText = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function addMonth(month: string, step: number) {
  const d = new Date(dayTime(month + '-01'))
  d.setUTCMonth(d.getUTCMonth() + step)
  return d.toISOString().slice(0, 7)
}
export function ForecastEvents({
  events,
  start,
  end,
  highlight,
  inspect,
  date,
  selectDate,
  loading,
}: {
  events: MarketEvent[]
  start: string
  end: string
  highlight: MarketEvent | null
  inspect: (event: MarketEvent) => void
  date: string
  selectDate: (d: string) => void
  loading: boolean
}) {
  const [view, setView] = useState<'agenda' | 'month'>('agenda'),
    [page, setPage] = useState(0)
  const [manualMonth, setMonth] = useState<string | null>(null)
  const firstMonth = start.slice(0, 7),
    lastMonth = end.slice(0, 7)
  const current =
    manualMonth || (date < start ? firstMonth : date > end ? lastMonth : date.slice(0, 7))
  const month = current < firstMonth ? firstMonth : current > lastMonth ? lastMonth : current
  const startDay = new Date(dayTime(month + '-01')),
    offset = startDay.getUTCDay()
  const daysInMonth = new Date(
    Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth() + 1, 0),
  ).getUTCDate()
  const monthCells = Array.from({ length: Math.ceil((offset + daysInMonth) / 7) * 7 }, (_, i) => {
    const n = i - offset + 1
    return n >= 1 && n <= daysInMonth ? month + '-' + String(n).padStart(2, '0') : null
  })
  // Ranges only occupy the dates reported by the source.
  const forDay = (d: string) => events.filter((e) => e.date <= d && (e.end_date || e.date) >= d)
  const ordered = [...events].sort(
    (a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title),
  )
  const pageCount = Math.max(1, Math.ceil(ordered.length / 8)),
    pageIndex = Math.min(page, pageCount - 1)
  const visibleEvents =
    view === 'month'
      ? date.startsWith(month)
        ? forDay(date)
        : []
      : ordered.slice(pageIndex * 8, pageIndex * 8 + 8)
  const activeEvent =
    (view === 'agenda' || (highlight && visibleEvents.some((e) => e.id === highlight.id))
      ? highlight
      : null) ||
    visibleEvents[0] ||
    null
  const chooseEvent = (event: MarketEvent) => {
    selectDate(event.date)
    inspect(event)
    setMonth(event.date.slice(0, 7))
  }
  return (
    <section className="panel forecast-events" aria-label="Market event calendar">
      <div className="fc-section-title">
        <div>
          <h2>Market events</h2>
          <small>
            {shortDay(start)} – {shortDay(end)}
          </small>
        </div>
        <div className="range">
          <button
            aria-pressed={view === 'agenda'}
            className={view === 'agenda' ? 'selected' : ''}
            onClick={() => setView('agenda')}
          >
            <List size={14} /> Agenda
          </button>
          <button
            aria-pressed={view === 'month'}
            className={view === 'month' ? 'selected' : ''}
            onClick={() => setView('month')}
          >
            <CalendarDays size={14} /> Month grid
          </button>
        </div>
      </div>
      {loading && <p role="status">Checking event sources…</p>}
      <div className="fc-events-body">
        <div>
          {view === 'month' && (
            <>
              <div className="fc-month-title">
                <button
                  className="icon-btn"
                  aria-label="Previous calendar month"
                  disabled={month <= firstMonth}
                  onClick={() => setMonth(addMonth(month, -1))}
                >
                  <ChevronLeft size={16} />
                </button>
                <h3>{monthText(month)}</h3>
                <button
                  className="icon-btn"
                  aria-label="Next calendar month"
                  disabled={month >= lastMonth}
                  onClick={() => setMonth(addMonth(month, 1))}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
              <table className="fc-month" aria-label={monthText(month) + ' calendar'}>
                <thead>
                  <tr>
                    {dayText.map((d) => (
                      <th key={d} scope="col">
                        {d}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: monthCells.length / 7 }, (_, week) => (
                    <tr key={week}>
                      {monthCells.slice(week * 7, week * 7 + 7).map((d, i) => {
                        const hits = d ? forDay(d) : []
                        return (
                          <td key={d || i}>
                            {d && (
                              <button
                                aria-label={shortDay(d) + ' · ' + hits.length + ' events'}
                                aria-pressed={date === d}
                                disabled={d < start || d > end}
                                onClick={() => {
                                  selectDate(d)
                                  if (hits[0]) inspect(hits[0])
                                }}
                              >
                                {Number(d.slice(-2))}
                                {hits.length > 0 && <i aria-hidden="true" />}
                              </button>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 className="fc-agenda-label">
                {date.startsWith(month) ? shortDay(date) : 'Select a date'}
              </h3>
            </>
          )}
          {!loading && !visibleEvents.length && (view === 'agenda' || date.startsWith(month)) && (
            <p className="muted">
              {view === 'month'
                ? 'No published event for this date.'
                : 'No published event found in this forecast period.'}
            </p>
          )}
          <ul className="fc-agenda">
            {visibleEvents.map((e) => (
              <li key={e.id}>
                <button
                  aria-pressed={activeEvent?.id === e.id}
                  onMouseEnter={() => inspect(e)}
                  onFocus={() => inspect(e)}
                  onClick={() => chooseEvent(e)}
                >
                  <time dateTime={e.date}>{shortDay(e.date)}</time>
                  <span>
                    <strong>{e.title}</strong>
                    <small>
                      {e.symbols.join(', ') || 'Market-wide'} · {e.status}
                    </small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              </li>
            ))}
          </ul>
          {view === 'agenda' && pageCount > 1 && (
            <div className="fc-pager">
              <button
                className="btn small"
                disabled={!pageIndex}
                onClick={() => setPage(pageIndex - 1)}
              >
                Previous events
              </button>
              <small>
                {pageIndex + 1} of {pageCount}
              </small>
              <button
                className="btn small"
                disabled={pageIndex + 1 === pageCount}
                onClick={() => setPage(pageIndex + 1)}
              >
                Next events
              </button>
            </div>
          )}
        </div>
        {activeEvent && <EventCard event={activeEvent} />}
      </div>
    </section>
  )
}
