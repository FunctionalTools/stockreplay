import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  MessageCircle,
  Minus,
  History,
  SquarePen,
  ChevronLeft,
  Pencil,
  Trash2,
} from 'lucide-react'
import { api, errorText } from './types'
import { Busy, ErrorBox } from './ui'
import { useChatHistory, type ChatLink, type Entry, type Context } from './chatHistory'
import { ChatMessage, ChatAnchor, linkUrl } from './ChatMessage'
import { ChatResize, setAssistantSize } from './ChatResize'
import { executeTabAction, isTabAction, prepareTabDelete } from './customTabs'
import { validRangeFocus } from './ResearchRange'
import './assistant.css'
import {
  type Connection,
  type Opinion,
  type Page,
  type Preferences,
  type SavedList,
  type Source,
  tickerPattern,
} from './workspace'
export type Action = {
  kind: string
  size?: 'compact' | 'large'
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
  value?: number | string | null
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
type SettingsChange = Partial<Preferences> & { chat_size?: 'compact' | 'large' }
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
type Account = {
  id: string
  name: string
  institution: string
  positions: Position[]
}
type Props = {
  page: Page
  symbol: string
  openTab: (id: string) => void
  currentTab?: string
  portfolioContext?: boolean
  connection: Connection | null
  navigate: (page: Page, symbol?: string, focus?: string) => void
  save: (v: Partial<Preferences>) => Promise<void>
  updated: () => void
  connected: (v: Connection) => void
}
export function Assistant({
  page,
  symbol,
  connection,
  navigate,
  save,
  updated,
  connected,
  openTab,
  currentTab,
  portfolioContext = false,
}: Props) {
  const [open, setOpen] = useState(false),
    [input, type] = useState(''),
    [busy, wait] = useState(false),
    [phase, setPhase] = useState('Working'),
    [error, fail] = useState(''),
    [menu, setMenu] = useState(false),
    [rename, setRename] = useState<string | null>(null),
    [deleting, setDeleting] = useState(false),
    [limit, setLimit] = useState(20)
  const history = useChatHistory(),
    entries = history.chat?.entries || [],
    locked = busy || history.loading
  const body = useRef<HTMLDivElement>(null),
    field = useRef<HTMLInputElement>(null),
    launcher = useRef<HTMLButtonElement>(null),
    requestLock = useRef(false)
  useEffect(() => {
    if (open && !menu) {
      body.current?.scrollTo({ top: body.current.scrollHeight })
      field.current?.focus({ preventScroll: true })
    }
  }, [open, menu, history.chat?.id, entries.length, busy])
  function minimize() {
    setOpen(false)
    launcher.current?.focus()
  }
  function follow(link: ChatLink) {
    if (!linkUrl(link, symbol)) return
    if (link.tab) openTab(link.tab)
    else navigate(link.page, link.symbol || symbol, link.focus)
    minimize()
  }
  useEffect(() => {
    const reveal = () => {
      setOpen(true)
      if (!requestLock.current) {
        setMenu(true)
        setRename(null)
        setDeleting(false)
        void history.init()
        void history.refresh().catch((e) => fail(errorText(e)))
      }
    }
    window.addEventListener('stockreplay:chat-history', reveal)
    return () => window.removeEventListener('stockreplay:chat-history', reveal)
  }, [history.init, history.refresh])
  const { append } = history
  const portfolioGuide: ChatLink = {
    label: 'Portfolio import guide',
    page: 'Portfolio',
    focus: 'import-guide',
    symbol,
  }
  const settingsLink: ChatLink = {
    label: 'Open API settings',
    page: 'Settings',
    symbol,
  }
  function target(a: Action): ChatLink | undefined {
    const ticker = a.symbol || symbol
    if (a.kind === 'navigate' && a.page) return { label: 'Open ' + a.page, page: a.page, symbol }
    if (a.kind === 'import') {
      const watch = a.file_type === 'watchlist'
      return {
        label: 'Open import',
        page: watch ? 'Watchlists' : 'Portfolio',
        focus: a.file_type,
        symbol,
      }
    }
    if (
      ['portfolio', 'portfolio_quote', 'add_account', 'delete_account', 'position'].includes(a.kind)
    )
      return { page: 'Portfolio', label: 'View portfolio', symbol }
    if (
      [
        'alerts',
        'alert',
        'watchlists',
        'create_list',
        'rename_list',
        'delete_list',
        'watch',
        'unwatch',
      ].includes(a.kind)
    )
      return { page: 'Watchlists', label: 'View watchlists', symbol }
    if (a.kind === 'range') {
      const focus = rangeFocus(a.span)
      return {
        label: 'View performance',
        page: 'Research',
        symbol: ticker,
        focus,
      }
    }
    if (
      ['appearance', 'accent', 'advanced', 'home_stock', 'home_portfolio', 'model'].includes(a.kind)
    )
      return settingsLink
    if (
      [
        'research',
        'open_stock',
        'news',
        'ratings',
        'drawing',
        'chart_tools',
        'chart_layout',
        'chart_control',
        'chart',
        'score',
      ].includes(a.kind)
    ) {
      const section = ['news', 'ratings'].includes(a.kind)
        ? a.kind
        : a.kind === 'score'
          ? 'scores'
          : a.kind.startsWith('chart_') || a.kind === 'drawing'
            ? 'tools'
            : ''
      return {
        page: 'Research',
        label:
          section === 'tools'
            ? 'Open chart tools'
            : section
              ? 'View ' + section
              : 'Research ' + (a.symbols?.[0] || ticker),
        symbol: a.symbols?.[0] || ticker,
        focus: section,
      }
    }
  }
  async function navigateHistory(id: string | null) {
    if (requestLock.current || history.loading) return
    requestLock.current = true
    try {
      await history.open(id)
      setMenu(false)
      setLimit(20)
      setRename(null)
      setDeleting(false)
      type('')
      fail('')
    } catch (e) {
      fail(errorText(e))
    } finally {
      requestLock.current = false
    }
  }
  async function manage(task: () => Promise<unknown>) {
    if (requestLock.current || history.loading) return
    requestLock.current = true
    wait(true)
    fail('')
    try {
      await task()
    } catch (e) {
      fail(errorText(e))
    } finally {
      requestLock.current = false
      wait(false)
      setPhase('Working')
    }
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
  function rangeFocus(span?: string) {
    const focus = span?.includes('/') ? 'range_custom_' + span.replace('/', '_') : 'range_' + span
    if (!validRangeFocus(focus))
      throw Error('Choose a chart range or two dates in YYYY-MM-DD format.')
    return focus
  }
  function preference(a: Action): SettingsChange | null {
    switch (a.kind) {
      case 'appearance':
        return { appearance: a.mode as Preferences['appearance'] }
      case 'accent':
        return { accent: a.color }
      case 'advanced':
        return { advanced: a.enabled }
      case 'chat_size':
        return { chat_size: a.size }
      case 'home_portfolio':
        return { home_mode: 'portfolio' }
      case 'home_stock':
        return { home_mode: 'ticker', home_symbol: stock(a.symbol) }
      default:
        return null
    }
  }
  async function savePreferences({ chat_size, ...p }: SettingsChange, context: Context) {
    if (Object.keys(p).length) await save(p)
    if (chat_size) setAssistantSize(chat_size)
    if (p.home_mode) navigate('Research')
    const details = [
      chat_size && chat_size + ' chat window',
      p.appearance && (p.appearance === 'system' ? 'system appearance' : p.appearance + ' mode'),
      p.accent && p.accent + ' accent',
      p.advanced !== undefined && 'advanced tools ' + (p.advanced ? 'on' : 'off'),
      p.home_mode &&
        'home set to ' + (p.home_mode === 'portfolio' ? 'your portfolio' : p.home_symbol),
    ].filter(Boolean)
    await append(
      {
        text: 'Saved ' + details.join(', ') + '.',
        links: [{ page: 'Settings', label: 'View settings' }],
      },
      context,
    )
  }
  async function execute(
    a: Action,
    confirmed = false,
    suggested: ChatLink[] = [],
    context?: Context,
  ): Promise<void> {
    const append = (entry: Parameters<typeof history.append>[0]) => history.append(entry, context)
    const link = target(a),
      links = [...(link ? [link] : []), ...suggested]
    const text = (s: string) => append({ text: s, links }),
      enc = encodeURIComponent
    if (
      !confirmed &&
      ((isTabAction(a) && a.operation === 'delete') ||
        ['delete_list', 'delete_account', 'unwatch'].includes(a.kind) ||
        (a.kind === 'position' && a.mode !== 'add') ||
        (a.kind === 'alert' && a.mode === 'remove'))
    ) {
      if (isTabAction(a) && a.operation === 'delete') {
        const bound = await prepareTabDelete(a, currentTab)
        await append({
          text: 'Delete “' + bound.name + '” from this Mac?',
          confirmation: { action: bound, pending: true },
        })
        return
      }
      await append({
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
    if (isTabAction(a)) {
      const result = await executeTabAction(a, openTab, updated, currentTab)
      await append({
        text: result.text,
        links: result.tab
          ? [{ page: 'Research', tab: result.tab.id, label: result.tab.title }]
          : [],
      })
      return
    }
    if (a.kind === 'navigate') {
      if (!a.page || !['Research', 'Watchlists', 'Portfolio', 'Settings'].includes(a.page))
        throw Error('Unknown page.')
      navigate(a.page)
      await text('Opened ' + a.page + '.')
      return
    }
    if (['open_stock', 'ratings', 'news'].includes(a.kind)) {
      const s = stock(a.symbol)
      navigate('Research', s, a.kind)
      await text('Opened ' + (a.kind === 'open_stock' ? 'research' : a.kind) + ' for ' + s + '.')
      return
    }
    if (a.kind === 'range') {
      const s = stock(a.symbol)
      navigate('Research', s, rangeFocus(a.span))
      await text('Showing ' + s + ' · ' + a.span + '.')
      return
    }
    if (a.kind === 'chart') {
      const symbols = [...new Set((a.symbols || []).map((s) => stock(s)))].slice(0, 4)
      if (!symbols.length) throw Error('Choose a symbol for the chart.')
      const span = a.span || '1y'
      const saved = await api<{ id: string }>('/assistant/charts', 'POST', {
        symbols,
        span,
      })
      await append({
        text: 'Price history',
        links,
        graph: { symbols, span, snapshot: saved.id },
      })
      return
    }
    if (a.kind === 'research') {
      const s = stock(a.symbol)
      const result = await api<{ text: string; sources: Source[] }>(
        '/assistant/research/' + enc(s),
        'POST',
        { question: a.question },
      )
      await append({ text: result.text, sources: result.sources, links })
      return
    }
    if (a.kind === 'score') {
      const s = stock(a.symbol),
        result = await api<Opinion>('/desk/recommend/' + enc(s), 'POST')
      updated()
      navigate('Research', s, 'scores')
      await append({
        text:
          s +
          ' · Buy ' +
          result.buy_score +
          '/100 · Risk ' +
          result.risk_score +
          '/100. ' +
          result.thesis.text,
        links,
        sources: result.sources.filter((e) => result.thesis.citations.includes(e.id)),
      })
      return
    }
    if (a.kind === 'chart_control') {
      const s = stock(a.symbol)
      await save({ advanced: true })
      navigate('Research', s, 'control_' + a.command)
      await text('Opened the chart for ' + s + '.')
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
      await text('Saved the ' + a.shape + ' drawing on ' + s + '.')
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
        {
          data: { price: number; time: number; currency: string } | null
          stale: boolean
        }
      >()
      for (const s of new Set(rows.map((r) => r.symbol)))
        marks.set(s, await api('/desk/quote/' + enc(s)))
      if (!rows.length) {
        await text('No matching positions with a quantity were found on this Mac.')
        return
      }
      await append({
        text: 'Latest position values by currency.',
        links,
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
      await text(
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
      await append({
        text: 'Choose a file on your Mac.',
        links: a.file_type === 'holdings' ? [...links, portfolioGuide] : links,
      })
      return
    }
    if (a.kind === 'model') {
      const v = await api<Connection>('/openai', 'PUT', {
        model: a.model,
        remember: connection?.storage === 'macOS Keychain',
      })
      connected(v)
      await text('Verified generation with ' + v.model + '.')
      return
    }
    if (
      ['watchlists', 'create_list', 'rename_list', 'delete_list', 'watch', 'unwatch'].includes(
        a.kind,
      )
    ) {
      if (a.kind === 'create_list') {
        await api('/watchlists', 'POST', { name: a.name })
        updated()
        await text('Created ' + a.name + '.')
        return
      }
      const lists = await api<SavedList[]>('/watchlists')
      if (a.kind === 'watchlists') {
        await text(
          lists.map((l) => l.name + ' — ' + (l.symbols.join(', ') || 'empty')).join('\n') ||
            'No saved lists.',
        )
        return
      }
      {
        const l = named(lists, a.name, true),
          path = '/watchlists/' + enc(l.id)
        if (a.kind === 'rename_list') {
          await api(path, 'PATCH', { name: a.new_name })
          await text('Renamed ' + l.name + ' to ' + a.new_name + '.')
        } else if (a.kind === 'delete_list') {
          await api(path, 'DELETE')
          await text('Removed ' + l.name + '.')
        } else {
          const s = stock(a.symbol)
          await api(
            path + '/symbols' + (a.kind === 'unwatch' ? '/' + enc(s) : ''),
            a.kind === 'watch' ? 'POST' : 'DELETE',
            a.kind === 'watch' ? { symbol: s } : undefined,
          )
          await text((a.kind === 'watch' ? 'Watching ' : 'Removed ') + s + ' · ' + l.name + '.')
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
      if (a.kind === 'alert' && a.mode === 'create') {
        const s = stock(a.symbol)
        await api('/alerts', 'POST', {
          symbol: s,
          direction: a.direction,
          threshold: a.threshold,
        })
        updated()
        await text('Watching ' + s + ' ' + a.direction + ' ' + a.threshold + '.')
        return
      }
      const all = await api<Alert[]>(
        a.kind === 'alerts' && a.mode === 'check' ? '/alerts/check' : '/alerts',
        a.kind === 'alerts' && a.mode === 'check' ? 'POST' : 'GET',
      )
      if (a.kind === 'alerts') {
        await text(
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
        await text('Removed the alert.')
      } else throw Error('Choose a supported alert action.')
      updated()
      return
    }
    if (['portfolio', 'add_account', 'delete_account', 'position'].includes(a.kind)) {
      if (a.kind === 'add_account') {
        await api('/holdings/accounts', 'POST', {
          name: a.name,
          institution: a.institution,
        })
        updated()
        await text('Saved account ' + a.name + '.')
        return
      }
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
        await append({
          text: rows.length
            ? 'Statement values on this Mac'
            : 'Your portfolio has no saved positions.',
          rows,
          allocation: a.view === 'allocation',
          links,
        })
        return
      }
      {
        const ac = named(accounts, a.account || a.name),
          path = '/holdings/accounts/' + enc(ac.id)
        if (a.kind === 'delete_account') {
          await api(path, 'DELETE')
          await text('Removed account ' + ac.name + '.')
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
              value:
                typeof a.value === 'number'
                  ? a.value
                  : a.quantity != null || a.price != null
                    ? null
                    : old?.value,
              basis: a.basis ?? old?.basis,
              currency: a.currency || old?.currency || 'USD',
              as_of: a.date || old?.as_of || null,
            })
          }
          await text('Updated ' + s + ' in ' + ac.name + '.')
        }
      }
      updated()
      return
    }
    throw Error('This action is unavailable. Try a more specific request.')
  }
  async function send(message = input) {
    const value = message.trim()
    if (!value || requestLock.current || history.loading || history.dirty) return
    if (/\bsk-[\w-]{12,}/i.test(value)) {
      type('')
      fail('Enter API keys in Settings.')
      return
    }
    requestLock.current = true
    wait(true)
    fail('')
    try {
      type('')
      setPhase('Saving message…')
      const msgs = await history.startTurn(value)
      setPhase('Choosing an action…')
      const result = await api<{
        reply: string
        actions: Action[]
        links?: ChatLink[]
        local?: boolean
      }>('/assistant', 'POST', {
        page,
        symbol,
        messages: msgs,
        custom_tab_open: Boolean(currentTab),
        portfolio_context: portfolioContext,
      })
      const links = (result.links || [])
        .map((l) => ({ ...l, symbol: l.symbol || symbol }))
        .filter((l) => !!linkUrl(l, symbol))
        .slice(0, 2)
      // Follow-up turns include user text and planner intent. Account values and local receipts stay on-device.
      const plan = result.actions
        .map((a) =>
          [a.kind, ...(portfolioContext ? [] : [a.symbol, a.symbols?.join(', ')]), a.span]
            .filter(Boolean)
            .join(' '),
        )
        .join(', ')
      const next: Context = [
        ...(result.local ? msgs.slice(0, -1) : msgs),
        {
          role: 'assistant' as const,
          text: [result.reply, plan].filter(Boolean).join(' ').slice(0, 2900) || 'Ready.',
        },
      ].slice(-15)
      if (result.actions.length) {
        if (result.reply.includes('?')) await append({ text: result.reply, links }, next)
        // If another window changed the chat while planning, stop before mutations or paid generation.
        // Read-only actions may save context together with the first result.
        else if (
          result.actions.some(
            (a) =>
              ![
                'navigate',
                'range',
                'open_stock',
                'ratings',
                'news',
                'portfolio',
                'watchlists',
                'chart',
              ].includes(a.kind),
          )
        )
          await history.write({ context: next })
        for (let i = 0; i < result.actions.length; i++) {
          const action = result.actions[i]
          const p = preference(action)
          if (p) {
            while (i + 1 < result.actions.length) {
              const more = preference(result.actions[i + 1])
              if (!more) break
              Object.assign(p, more)
              i++
            }
            setPhase('Applying settings…')
            await savePreferences(p, next)
          } else {
            setPhase(
              action.kind === 'research'
                ? 'Reading sources…'
                : action.kind === 'score'
                  ? 'Generating scores…'
                  : action.kind === 'chart'
                    ? 'Loading prices…'
                    : 'Applying your request…',
            )
            await execute(action, false, i === 0 ? links : [], next)
          }
        }
      } else await append({ text: result.reply || 'Choose a destination.', links }, next)
    } catch (e) {
      if (history.current.current && !history.pending.current) {
        try {
          await append({
            text: errorText(e),
            error: true,
            links: !connection?.configured ? [settingsLink] : undefined,
          })
        } catch (saveError) {
          fail(errorText(saveError))
        }
      } else {
        if (!history.current.current) type(value)
        fail(errorText(e))
      }
    } finally {
      requestLock.current = false
      wait(false)
      setPhase('Working')
    }
  }
  async function decide(e: Entry, allow: boolean) {
    if (
      requestLock.current ||
      !e.confirmation?.pending ||
      history.dirty ||
      !history.current.current
    )
      return
    requestLock.current = true
    wait(true)
    fail('')
    try {
      await history.write({
        entries: history.current.current.entries.map((row) =>
          row.id === e.id ? { ...row, confirmation: { ...e.confirmation!, pending: false } } : row,
        ),
      })
      if (allow) await execute(e.confirmation.action, true)
      else await append({ text: 'Cancelled.' })
    } catch (ex) {
      fail(errorText(ex))
    } finally {
      requestLock.current = false
      wait(false)
      setPhase('Working')
    }
  }
  const navProps = { symbol, follow }
  const historyError = history.error || error
  return (
    <aside className="assistant sr-assistant">
      {open && (
        <section
          className="chat-panel"
          aria-label="StockReplay assistant"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (menu) setMenu(false)
              else minimize()
            }
          }}
        >
          <header>
            <ChatResize />
            <div className="chat-heading">
              <strong>StockReplay assistant</strong>
              <small title={history.chat?.title}>
                {menu ? 'Conversation history' : history.chat?.title || 'New conversation'}
              </small>
            </div>
            <button
              className="icon-btn"
              aria-label={menu ? 'Back to chat' : 'Chat history'}
              title={menu ? 'Back to chat' : 'Chat history'}
              aria-expanded={menu}
              disabled={locked}
              onClick={() => {
                setMenu(!menu)
                setRename(null)
                setDeleting(false)
                if (!menu) void history.refresh().catch((e) => fail(errorText(e)))
              }}
            >
              {menu ? <ChevronLeft size={16} /> : <History size={16} />}
            </button>
            <button
              className="icon-btn"
              aria-label="Minimize assistant"
              title="Minimize"
              onClick={minimize}
            >
              <Minus size={17} />
            </button>
          </header>
          {menu ? (
            <div className="chat-history-body">
              <button
                className="btn chat-new"
                onClick={() => void navigateHistory(null)}
                disabled={locked || history.dirty}
              >
                <SquarePen size={14} /> New conversation
              </button>
              {history.list.length === 0 ? (
                <p className="chat-muted">Your conversations will appear here.</p>
              ) : (
                <ul className="chat-history-list">
                  {history.list.map((c) => (
                    <li key={c.id}>
                      <button
                        aria-current={history.chat?.id === c.id ? 'true' : undefined}
                        disabled={locked || history.dirty}
                        onClick={() => void navigateHistory(c.id)}
                      >
                        <strong>{c.title}</strong>
                        <time dateTime={c.updated}>
                          {new Date(c.updated).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </time>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {history.chat && (
                <div className="chat-manage">
                  {rename !== null ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault()
                        if (rename.trim())
                          void manage(async () => {
                            await history.write({ title: rename.trim() })
                            setRename(null)
                          })
                      }}
                    >
                      <input
                        aria-label="Conversation title"
                        required
                        maxLength={100}
                        value={rename}
                        autoFocus
                        onChange={(e) => setRename(e.target.value)}
                      />
                      <button className="btn small" disabled={locked}>
                        Save
                      </button>
                      <button
                        className="chat-readmore"
                        type="button"
                        onClick={() => setRename(null)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : deleting ? (
                    <>
                      <p>Delete “{history.chat.title}” from this Mac?</p>
                      <div className="inline">
                        <button className="btn small" onClick={() => setDeleting(false)}>
                          Cancel
                        </button>
                        <button
                          className="btn small"
                          onClick={() =>
                            void manage(async () => {
                              await history.remove()
                              setDeleting(false)
                            })
                          }
                        >
                          Delete conversation
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <small>Current conversation</small>
                      <div className="inline">
                        <button
                          className="chat-readmore"
                          onClick={() => setRename(history.chat!.title)}
                        >
                          <Pencil size={12} />
                          Rename
                        </button>
                        <button className="chat-readmore" onClick={() => setDeleting(true)}>
                          <Trash2 size={12} />
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
              {historyError && <ErrorBox text={historyError} />}
            </div>
          ) : (
            <>
              <div
                className="chat-body"
                role="log"
                aria-label="Conversation"
                aria-live="polite"
                ref={body}
              >
                {history.loading ? (
                  <Busy text="Opening chat" />
                ) : (
                  !entries.length && (
                    <div className="chat-welcome">
                      <h3>How can I help?</h3>
                      <div className="chat-links">
                        <ChatAnchor {...navProps} link={portfolioGuide} />
                        <ChatAnchor
                          {...navProps}
                          link={{
                            label: 'View watchlists',
                            page: 'Watchlists',
                            symbol,
                          }}
                        />
                      </div>
                      {connection?.configured ? (
                        <div className="chat-quick">
                          {['Chart ' + symbol, 'Create a research tab'].map((t) => (
                            <button
                              className="btn small"
                              key={t}
                              disabled={locked}
                              onClick={() => void send(t)}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <ChatAnchor {...navProps} link={settingsLink} />
                      )}
                    </div>
                  )
                )}
                {entries.length > limit && (
                  <button className="chat-readmore earlier" onClick={() => setLimit((n) => n + 20)}>
                    Show earlier messages
                  </button>
                )}
                {entries.slice(-limit).map((e) => (
                  <ChatMessage
                    key={e.id}
                    entry={e}
                    {...navProps}
                    busy={locked || history.dirty}
                    decide={(row, allow) => void decide(row, allow)}
                  />
                ))}
                {busy && (
                  <span role="status">
                    <Busy text={phase} />
                  </span>
                )}
                {historyError && (
                  <div className="chat-notice">
                    <ErrorBox text={historyError} />
                    {history.dirty && !busy && (
                      <div className="inline">
                        <button
                          className="btn small"
                          onClick={() => void manage(() => history.write())}
                        >
                          Retry save
                        </button>
                        <button
                          className="btn small"
                          onClick={() => void manage(() => history.saveCopy())}
                        >
                          Save a copy
                        </button>
                      </div>
                    )}
                    {history.error && !history.dirty && (
                      <button className="chat-readmore" onClick={() => void history.init()}>
                        Retry
                      </button>
                    )}
                  </div>
                )}
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
                  disabled={history.dirty && !busy}
                  placeholder="Ask StockReplay…"
                  onChange={(e) => type(e.target.value)}
                />
                <button
                  aria-label="Send message"
                  disabled={locked || history.dirty || !input.trim()}
                >
                  <ArrowUp size={17} />
                </button>
              </form>
              <small className="chat-privacy">Saved on this Mac · AI requests use OpenAI</small>
            </>
          )}
        </section>
      )}
      <button
        ref={launcher}
        className="chat-launch"
        aria-label={open ? 'Close assistant' : 'Open assistant'}
        aria-expanded={open}
        onClick={() => {
          if (open) minimize()
          else {
            setOpen(true)
            void history.init()
          }
        }}
      >
        {open ? <Minus size={18} /> : <MessageCircle size={18} />}
        <span>Assistant</span>
      </button>
    </aside>
  )
}
