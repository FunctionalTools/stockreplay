import { useEffect, useRef, useState } from 'react'
import { ArrowUp, MessageCircle, Minus, Sparkles } from 'lucide-react'
import { api, errorText } from './types'
import { Busy, ErrorBox } from './ui'
import { SourceLink } from './deskCommon'
import { ChatGraph } from './PricePlot'
import {
  type Connection,
  type Opinion,
  type Page,
  type Preferences,
  type SavedList,
  type Source,
  amount,
  tickerPattern,
} from './workspace'
type Action = {
  kind: string
  shape?: string
  start_date?: string
  start_price?: number
  end_date?: string
  end_price?: number | null
  command?: string
  page?: Page
  symbol?: string
  symbols?: string[]
  span?: string
  name?: string
  new_name?: string
  question?: string
  tool?: string
  mode?: string
  color?: Preferences['accent']
  enabled?: boolean
  file_type?: string
  institution?: string
  account?: string
  quantity?: number | null
  price?: number | null
  value?: number | null
  basis?: number | null
  currency?: string
  date?: string
  view?: string
  direction?: string
  threshold?: number
  model?: string
  style?: string
  interval?: string
  studies?: string[]
  compare?: string
  panels?: string[]
}
type Position = {
  id: string
  symbol: string
  description: string
  quantity: number | null
  value: number | null
  basis: number | null
  price: number | null
  currency: string
  as_of: string | null
}
type Account = { id: string; name: string; institution: string; positions: Position[] }
type Row = { name: string; currency: string; value: number | null; quantity?: number | null }
type Entry = {
  role: 'user' | 'assistant'
  text: string
  graph?: { symbols: string[]; span: string }
  rows?: Row[]
  allocation?: boolean
  sources?: Source[]
  confirmation?: { action: Action; pending: boolean }
  id: number
}
type Props = {
  page: Page
  symbol: string
  connection: Connection | null
  navigate: (page: Page, symbol?: string, focus?: string) => void
  save: (v: Partial<Preferences>) => Promise<void>
  updated: () => void
  connected: (v: Connection) => void
}
export function Assistant({ page, symbol, connection, navigate, save, updated, connected }: Props) {
  const [open, setOpen] = useState(false),
    [input, type] = useState(''),
    [busy, wait] = useState(false),
    [error, fail] = useState(''),
    [entries, set] = useState<Entry[]>([])
  const seq = useRef(0),
    bottom = useRef<HTMLDivElement>(null),
    field = useRef<HTMLInputElement>(null),
    launcher = useRef<HTMLButtonElement>(null),
    requestLock = useRef(false),
    context = useRef<{ role: 'user' | 'assistant'; text: string }[]>([])
  useEffect(() => {
    if (open) {
      bottom.current?.scrollIntoView({ block: 'nearest' })
      field.current?.focus({ preventScroll: true })
    }
  }, [open, entries, busy])
  function minimize() {
    setOpen(false)
    launcher.current?.focus()
  }
  function append(e: Omit<Entry, 'id' | 'role'> & { role?: Entry['role'] }) {
    const entry = { role: 'assistant' as const, ...e, id: ++seq.current }
    set((v) => [...v, entry])
  }
  function stock(raw?: string) {
    const v = (raw || symbol).trim().toUpperCase()
    if (!tickerPattern.test(v)) throw Error('Please give a valid market symbol.')
    return v
  }
  function named<T extends { name: string }>(rows: T[], name?: string, first = false) {
    const hits = rows.filter((r) => r.name.toLowerCase() === name?.trim().toLowerCase())
    if (!hits.length && !name && first && rows[0]) return rows[0]
    if (hits.length !== 1)
      throw Error(
        (hits.length ? 'More than one match.' : 'No matching name.') +
          ' Available names: ' +
          (rows.map((r) => r.name).join(', ') || 'none') +
          '.',
      )
    return hits[0]
  }
  async function execute(a: Action, confirmed = false): Promise<void> {
    const text = (s: string) => append({ text: s }),
      enc = encodeURIComponent
    if (
      !confirmed &&
      (['delete_list', 'delete_account', 'unwatch'].includes(a.kind) ||
        (a.kind === 'position' && a.mode !== 'add') ||
        (a.kind === 'alert' && a.mode === 'remove'))
    ) {
      append({
        text:
          'Apply this change? ' +
          [
            a.mode || a.kind.replaceAll('_', ' '),
            a.symbol,
            a.name || a.account,
            a.direction,
            a.threshold,
          ]
            .filter(Boolean)
            .join(' · '),
        confirmation: { action: a, pending: true },
      })
      return
    }
    if (a.kind === 'navigate') {
      if (!a.page || !['Research', 'Watchlists', 'Portfolio', 'Settings'].includes(a.page))
        throw Error('Unknown page.')
      navigate(a.page)
      text('Opened ' + a.page + '.')
      return
    }
    if (['open_stock', 'ratings', 'news'].includes(a.kind)) {
      const s = stock(a.symbol)
      navigate('Research', s, a.kind)
      text('Opened ' + (a.kind === 'open_stock' ? 'research' : a.kind) + ' for ' + s + '.')
      return
    }
    if (a.kind === 'chart') {
      const symbols = [...new Set((a.symbols || []).map((s) => stock(s)))].slice(0, 4)
      if (!symbols.length) throw Error('Choose a symbol for the chart.')
      append({ text: 'Price history', graph: { symbols, span: a.span || '1y' } })
      return
    }
    if (a.kind === 'research') {
      const s = stock(a.symbol)
      const result = await api<{ text: string; sources: Source[] }>(
        '/assistant/research/' + enc(s),
        'POST',
        { question: a.question },
      )
      append({ text: result.text, sources: result.sources })
      return
    }
    if (a.kind === 'score') {
      const s = stock(a.symbol),
        result = await api<Opinion>('/desk/recommend/' + enc(s), 'POST')
      updated()
      navigate('Research', s, 'scores')
      append({
        text:
          s +
          ' · Buy ' +
          result.buy_score +
          '/100 · Risk ' +
          result.risk_score +
          '/100. ' +
          result.thesis.text,
        sources: result.sources.filter((e) => result.thesis.citations.includes(e.id)),
      })
      return
    }
    if (a.kind === 'chart_control') {
      const s = stock(a.symbol)
      await save({ advanced: true })
      navigate('Research', s, 'control_' + a.command)
      text('Opened the chart for ' + s + '.')
      return
    }
    if (a.kind === 'drawing') {
      const s = stock(a.symbol),
        path = '/desk/layout/' + enc(s),
        layout = (await api<{ drawings: unknown[]; interval: string } | null>(path)) || {
          interval: '1d',
          span: '2y',
          style: 'Candles',
          studies: ['Volume'],
          compare: '',
          panels: [],
          drawings: [],
          scale: 'Linear',
        }
      const time = (date?: string) => {
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
          throw Error('Specify a trading date in YYYY-MM-DD format.')
        const n = Date.parse(date + 'T00:00:00Z') / 1000
        if (!Number.isFinite(n)) throw Error('Choose a valid trading date.')
        return n
      }
      const first = time(a.start_date),
        last = a.shape === 'horizontal' ? null : time(a.end_date)
      if (
        !Number.isFinite(a.start_price) ||
        a.start_price! <= 0 ||
        (last != null && (!Number.isFinite(a.end_price) || a.end_price! <= 0 || last === first))
      )
        throw Error('Give two different trading dates and positive prices for a box or line.')
      const series = await api<{ data: { bars: { time: number }[] } | null }>(
        '/desk/chart/' + enc(s) + '?interval=1d&span=10y',
      )
      const available = new Set(series.data?.bars.map((b) => b.time) || [])
      if (!available.has(first) || (last != null && !available.has(last)))
        throw Error('Choose dates with reported daily prices in the past ten years.')
      await api(path, 'PUT', {
        ...layout,
        interval: '1d',
        span: '10y',
        drawings: [
          ...layout.drawings,
          {
            kind: a.shape,
            time: first,
            price: a.start_price,
            end_time: last,
            end_price: a.end_price,
          },
        ],
      })
      await save({ advanced: true })
      updated()
      navigate('Research', s, 'layout_saved')
      text('Saved the ' + a.shape + ' drawing on ' + s + '.')
      return
    }
    if (a.kind === 'portfolio_quote') {
      const accounts = await api<Account[]>('/holdings'),
        rows = accounts
          .flatMap((ac) => ac.positions.map((p) => ({ ...p, account: ac.name })))
          .filter(
            (p) =>
              (!a.symbol || p.symbol.toUpperCase() === stock(a.symbol)) &&
              tickerPattern.test(p.symbol) &&
              p.quantity != null,
          )
      const marks = new Map<
        string,
        { data: { price: number; time: number; currency: string } | null; stale: boolean }
      >()
      for (const s of new Set(rows.map((r) => r.symbol)))
        marks.set(s, await api('/desk/quote/' + enc(s)))
      if (!rows.length) {
        text('No matching positions with a quantity were found on this Mac.')
        return
      }
      append({
        text: 'Position values at available quote times. A dash means that a price in the statement currency was unavailable.',
        rows: rows.map((p) => {
          const q = marks.get(p.symbol)
          const usable = q?.data?.currency === p.currency
          return {
            name:
              p.symbol +
              ' · ' +
              p.account +
              (q?.data
                ? ' · ' +
                  new Date(q.data.time * 1000).toLocaleString() +
                  (q.stale ? ' (cached)' : '')
                : ''),
            currency: p.currency,
            value: usable ? p.quantity! * q!.data!.price : null,
          }
        }),
      })
      return
    }
    if (a.kind === 'chart_tools' || a.kind === 'chart_layout') {
      const s = stock(a.symbol)
      if (a.kind === 'chart_layout') {
        const path = '/desk/layout/' + enc(s),
          old = await api<{ drawings: unknown[]; scale: string } | null>(path)
        await api(path, 'PUT', {
          drawings: old?.drawings || [],
          scale: old?.scale || 'Linear',
          interval: a.interval,
          span: a.span,
          style: a.style,
          studies: a.studies,
          compare: a.compare,
          panels: a.panels,
        })
      }
      await save({ advanced: true })
      navigate(
        'Research',
        s,
        a.kind === 'chart_layout'
          ? 'layout_saved'
          : a.tool && a.tool !== 'inspect'
            ? a.tool
            : 'tools',
      )
      text(
        a.tool && ['trend', 'box'].includes(a.tool)
          ? 'Select two points on the advanced chart.'
          : a.tool === 'horizontal'
            ? 'Select a price level on the chart.'
            : 'Opened the advanced chart for ' + s + '.',
      )
      return
    }
    if (a.kind === 'import') {
      navigate(a.file_type === 'watchlist' ? 'Watchlists' : 'Portfolio', undefined, a.file_type)
      text('Opened the local ' + a.file_type + ' import. Choose the file on your Mac.')
      return
    }
    if (
      a.kind === 'appearance' ||
      a.kind === 'accent' ||
      a.kind === 'advanced' ||
      a.kind === 'home_stock'
    ) {
      await save(
        a.kind === 'appearance'
          ? { appearance: a.mode as Preferences['appearance'] }
          : a.kind === 'accent'
            ? { accent: a.color }
            : a.kind === 'advanced'
              ? { advanced: a.enabled }
              : { home_symbol: stock(a.symbol) },
      )
      text('Saved your ' + a.kind.replace('_', ' ') + ' preference.')
      return
    }
    if (a.kind === 'model') {
      const v = await api<Connection>('/openai', 'PUT', {
        model: a.model,
        remember: connection?.storage === 'macOS Keychain',
      })
      connected(v)
      text('Verified generation with ' + v.model + '.')
      return
    }
    if (
      ['watchlists', 'create_list', 'rename_list', 'delete_list', 'watch', 'unwatch'].includes(
        a.kind,
      )
    ) {
      const lists = await api<SavedList[]>('/watchlists')
      if (a.kind === 'watchlists') {
        text(
          lists.map((l) => l.name + ' — ' + (l.symbols.join(', ') || 'empty')).join('\n') ||
            'No saved lists.',
        )
        return
      }
      if (a.kind === 'create_list') {
        await api('/watchlists', 'POST', { name: a.name })
        text('Created ' + a.name + '.')
      } else {
        const l = named(lists, a.name, true),
          path = '/watchlists/' + enc(l.id)
        if (a.kind === 'rename_list') {
          await api(path, 'PATCH', { name: a.new_name })
          text('Renamed ' + l.name + ' to ' + a.new_name + '.')
        } else if (a.kind === 'delete_list') {
          await api(path, 'DELETE')
          text('Removed ' + l.name + '.')
        } else {
          const s = stock(a.symbol)
          await api(
            path + '/symbols' + (a.kind === 'unwatch' ? '/' + enc(s) : ''),
            a.kind === 'watch' ? 'POST' : 'DELETE',
            a.kind === 'watch' ? { symbol: s } : undefined,
          )
          text((a.kind === 'watch' ? 'Watching ' : 'Removed ') + s + ' · ' + l.name + '.')
        }
      }
      updated()
      return
    }
    if (a.kind === 'alerts' || a.kind === 'alert') {
      type Alert = {
        id: string
        symbol: string
        direction: string
        threshold: number
        triggered: string | null
      }
      const all = await api<Alert[]>(
        a.kind === 'alerts' && a.mode === 'check' ? '/alerts/check' : '/alerts',
        a.kind === 'alerts' && a.mode === 'check' ? 'POST' : 'GET',
      )
      if (a.kind === 'alerts') {
        text(
          all
            .map(
              (v) =>
                v.symbol +
                ' ' +
                v.direction +
                ' ' +
                v.threshold +
                ' · ' +
                (v.triggered ? 'triggered' : 'watching'),
            )
            .join('\n') || 'No price alerts.',
        )
        return
      }
      const s = stock(a.symbol)
      if (a.mode === 'remove') {
        const matches = all.filter(
          (v) => v.symbol === s && v.direction === a.direction && v.threshold === a.threshold,
        )
        if (matches.length !== 1) throw Error('Select the matching alert under Watchlists.')
        await api('/alerts/' + enc(matches[0].id), 'DELETE')
        text('Removed the alert.')
      } else {
        await api('/alerts', 'POST', { symbol: s, direction: a.direction, threshold: a.threshold })
        text('Watching ' + s + ' ' + a.direction + ' ' + a.threshold + '.')
      }
      updated()
      return
    }
    if (['portfolio', 'add_account', 'delete_account', 'position'].includes(a.kind)) {
      const accounts = await api<Account[]>('/holdings')
      if (a.kind === 'portfolio') {
        const rows = accounts.flatMap((ac) =>
          ac.positions.map((p) => ({
            name: (p.symbol || p.description) + ' · ' + ac.name,
            currency: p.currency,
            value: p.value,
            quantity: p.quantity,
          })),
        )
        append({
          text: rows.length
            ? 'Statement values on this Mac'
            : 'Your portfolio has no saved positions.',
          rows,
          allocation: a.view === 'allocation',
        })
        return
      }
      if (a.kind === 'add_account') {
        await api('/holdings/accounts', 'POST', { name: a.name, institution: a.institution })
        text('Saved account ' + a.name + '.')
      } else {
        const ac = named(accounts, a.account || a.name),
          path = '/holdings/accounts/' + enc(ac.id)
        if (a.kind === 'delete_account') {
          await api(path, 'DELETE')
          text('Removed account ' + ac.name + '.')
        } else {
          const s = stock(a.symbol)
          const match = ac.positions.filter((p) => p.symbol.toUpperCase() === s)
          if (a.mode !== 'add' && match.length !== 1)
            throw Error(
              'Select the position in Portfolio. There must be one matching position to change it by ticker.',
            )
          const pp = path + '/positions' + (a.mode === 'add' ? '' : '/' + enc(match[0].id))
          if (a.mode === 'remove') await api(pp, 'DELETE')
          else {
            const old = a.mode === 'edit' ? match[0] : null
            await api(pp, old ? 'PUT' : 'POST', {
              symbol: s,
              description: old?.description || '',
              quantity: a.quantity ?? old?.quantity,
              price: a.price ?? old?.price,
              value: a.value ?? (a.quantity != null || a.price != null ? null : old?.value),
              basis: a.basis ?? old?.basis,
              currency: a.currency || old?.currency || 'USD',
              as_of: a.date || old?.as_of || null,
            })
          }
          text('Updated ' + s + ' in ' + ac.name + '.')
        }
      }
      updated()
      return
    }
    throw Error('This action is unavailable. Try a more specific request.')
  }
  async function send(message = input) {
    const value = message.trim()
    if (!value || requestLock.current) return
    if (/\bsk-[\w-]{12,}/i.test(value)) {
      type('')
      fail('Enter keys in Settings. This message was kept on your Mac.')
      return
    }
    requestLock.current = true
    wait(true)
    fail('')
    type('')
    append({ role: 'user', text: value })
    try {
      const msgs = [...context.current, { role: 'user' as const, text: value }].slice(-15)
      const result = await api<{ reply: string; actions: Action[] }>('/assistant', 'POST', {
        page,
        symbol,
        messages: msgs,
      })
      context.current = [
        ...msgs,
        { role: 'assistant', text: result.reply || 'Requested actions.' },
      ].slice(-15) as typeof msgs
      if (result.reply) append({ text: result.reply })
      for (const action of result.actions) await execute(action)
    } catch (e) {
      fail(errorText(e))
    } finally {
      requestLock.current = false
      wait(false)
    }
  }
  async function decide(e: Entry, allow: boolean) {
    if (requestLock.current || !e.confirmation?.pending) return
    set((all) =>
      all.map((x) =>
        x.id === e.id ? { ...x, confirmation: { ...e.confirmation!, pending: false } } : x,
      ),
    )
    if (!allow) {
      append({ text: 'Cancelled.' })
      return
    }
    requestLock.current = true
    wait(true)
    try {
      await execute(e.confirmation.action, true)
    } catch (ex) {
      fail(errorText(ex))
    } finally {
      requestLock.current = false
      wait(false)
    }
  }
  return (
    <aside className="assistant">
      {open && (
        <section
          className="chat-panel"
          aria-label="StockReplay assistant"
          onKeyDown={(e) => {
            if (e.key === 'Escape') minimize()
          }}
        >
          <header>
            <span className="chat-icon">
              <Sparkles size={18} />
            </span>
            <div>
              <strong>StockReplay assistant</strong>
              <small>{connection?.configured ? connection.model : 'Connect OpenAI to chat'}</small>
            </div>
            <button className="icon-btn" aria-label="Minimize assistant" onClick={minimize}>
              <Minus size={19} />
            </button>
          </header>
          <div className="chat-body" aria-live="polite">
            {!entries.length && (
              <>
                <h3>What would you like to do?</h3>
                <p>Research a stock, build a graph, or make a change to your workspace.</p>
                {connection?.configured ? (
                  <div className="suggestions">
                    {[
                      'Chart ' + symbol + ' over one year',
                      'What risks does ' + symbol + ' face?',
                      'Show my portfolio allocation',
                    ].map((t) => (
                      <button className="btn" key={t} onClick={() => void send(t)}>
                        {t}
                      </button>
                    ))}
                  </div>
                ) : (
                  <button
                    className="btn primary"
                    onClick={() => {
                      navigate('Settings')
                      minimize()
                    }}
                  >
                    Open API settings
                  </button>
                )}
              </>
            )}
            {entries.map((e) => (
              <article className={'bubble ' + e.role} key={e.id}>
                <p>{e.text}</p>
                {e.graph && <ChatGraph {...e.graph} />}{' '}
                {e.sources?.map((s) => (
                  <div key={s.id}>
                    <SourceLink url={s.url}>
                      {s.source} · {s.text}
                    </SourceLink>
                  </div>
                ))}
                {e.rows && <LocalRows rows={e.rows} allocation={!!e.allocation} />}
                {e.confirmation?.pending && (
                  <div className="inline">
                    <button
                      className="btn small"
                      disabled={busy}
                      onClick={() => void decide(e, false)}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn small primary"
                      disabled={busy}
                      onClick={() => void decide(e, true)}
                    >
                      Apply change
                    </button>
                  </div>
                )}
              </article>
            ))}
            {busy && <Busy text="Working" />}
            <ErrorBox text={error} />
            <div ref={bottom} />
          </div>
          <form
            className="compose"
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
          >
            <input
              ref={field}
              aria-label="Message the assistant"
              maxLength={3000}
              value={input}
              disabled={!connection?.configured}
              placeholder="Ask StockReplay…"
              onChange={(e) => type(e.target.value)}
            />
            <button
              aria-label="Send message"
              disabled={busy || !connection?.configured || !input.trim()}
            >
              <ArrowUp size={18} />
            </button>
          </form>
          <small className="chat-privacy">
            Messages go to OpenAI. Saved holdings are read on this Mac.
          </small>
        </section>
      )}
      <button
        ref={launcher}
        className="chat-launch"
        aria-label={open ? 'Close assistant' : 'Open assistant'}
        aria-expanded={open}
        onClick={() => (open ? minimize() : setOpen(true))}
      >
        {open ? <Minus size={20} /> : <MessageCircle size={20} />}
        <span>Assistant</span>
      </button>
    </aside>
  )
}
function LocalRows({ rows, allocation }: { rows: Row[]; allocation: boolean }) {
  const groups = [...new Set(rows.map((r) => r.currency))]
  return (
    <>
      {groups.map((c) => {
        const selected = rows.filter((r) => r.currency === c),
          total = selected.reduce((v, r) => v + Math.abs(r.value || 0), 0)
        return (
          <div className="local-values" key={c}>
            <strong>
              {c} ·{' '}
              {amount(
                selected.reduce((v, r) => v + (r.value || 0), 0),
                c,
              )}{' '}
              net
            </strong>
            {selected.map((r, i) => (
              <div key={i}>
                <span>{r.name}</span>
                <b>{amount(r.value, c)}</b>
                {allocation && r.value != null && total > 0 && (
                  <meter
                    aria-label={r.name + ' share of gross exposure'}
                    min={0}
                    max={total}
                    value={Math.abs(r.value)}
                  />
                )}
              </div>
            ))}
            {allocation && <small>Bars show share of gross value in {c}.</small>}
          </div>
        )
      })}
    </>
  )
}
