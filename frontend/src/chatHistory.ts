import { useEffect, useRef, useState } from 'react'
import { api, errorText } from './types'
import type { Page, Source } from './workspace'
import type { Action } from './Assistant'

export type ChatLink = { label: string; page: Page; symbol?: string; focus?: string; tab?: string }
export type Row = { name: string; currency: string; value: number | null; quantity?: number | null }
export type Entry = {
  id: number
  role: 'user' | 'assistant'
  text: string
  links?: ChatLink[]
  sources?: Source[]
  graph?: { symbols: string[]; span: string; snapshot?: string }
  rows?: Row[]
  allocation?: boolean
  error?: boolean
  confirmation?: { action: Action; pending: boolean; expired?: boolean }
}
export type Context = { role: 'user' | 'assistant'; text: string }[]
type Summary = { id: string; title: string; created: string; updated: string; revision: number }
type Chat = Summary & { entries: Entry[]; context: Context }
type Changed = Pick<Chat, 'entries' | 'context' | 'title'>
const path = '/assistant/chats'
const selection = 'stockreplay.selected-chat.v1'
const draftPrefix = 'stockreplay.pending-chat.v1.'
const draftPointer = 'stockreplay.active-draft.v1'
function remember(id: string) {
  try {
    sessionStorage.setItem(selection, id)
    localStorage.setItem(selection, id)
  } catch {
    /* Selection is optional. */
  }
}
function lastSelection() {
  try {
    return sessionStorage.getItem(selection) || localStorage.getItem(selection)
  } catch {
    return null
  }
}
function readDraft(key: string | null): Chat | null {
  if (!key?.startsWith(draftPrefix)) return null
  try {
    const data = localStorage.getItem(key)
    if (!data) return null
    const parsed = JSON.parse(data)
    return parsed &&
      typeof parsed.id === 'string' &&
      typeof parsed.title === 'string' &&
      Number.isInteger(parsed.revision) &&
      Array.isArray(parsed.context) &&
      Array.isArray(parsed.entries)
      ? parsed
      : null
  } catch {
    return null
  }
}
function draftIndex(): Summary[] {
  const drafts: Summary[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(draftPrefix)) continue
      const chat = readDraft(key)
      if (chat)
        drafts.push({
          id: key,
          title: chat.title + ' (unsaved)',
          created: chat.created,
          updated: chat.updated,
          revision: chat.revision,
        })
    }
  } catch {
    /* SQLite history is still available if browser storage is disabled. */
  }
  return drafts
}
function previousDraft() {
  try {
    return sessionStorage.getItem(draftPointer)
  } catch {
    return null
  }
}
function restored(chat: Chat): Chat {
  return {
    ...chat,
    entries: chat.entries.map((e) =>
      e.confirmation?.pending
        ? { ...e, confirmation: { ...e.confirmation, pending: false, expired: true } }
        : e,
    ),
  }
}
export function useChatHistory() {
  const [list, setList] = useState<Summary[]>([]),
    [chat, render] = useState<Chat | null>(null)
  const [loading, load] = useState(false),
    [dirty, mark] = useState(false),
    [error, fail] = useState('')
  const current = useRef<Chat | null>(null),
    pending = useRef(false),
    initialized = useRef(false),
    loadingRef = useRef(false)
  const newId = useRef<string | null>(null)
  const journal = useRef<string | null>(null),
    backedUp = useRef(false)
  useEffect(() => {
    function beforeExit(event: BeforeUnloadEvent) {
      if (pending.current && !backedUp.current) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', beforeExit)
    return () => window.removeEventListener('beforeunload', beforeExit)
  }, [])
  function pin(key: string | null) {
    journal.current = key
    try {
      if (key) sessionStorage.setItem(draftPointer, key)
      else sessionStorage.removeItem(draftPointer)
    } catch {
      /* Discoverable in History. */
    }
  }
  function stage(data: string) {
    backedUp.current = false
    try {
      const old = journal.current
      if (old && localStorage.getItem(old) === data) {
        backedUp.current = true
        return
      }
      const key = draftPrefix + crypto.randomUUID()
      localStorage.setItem(key, data)
      pin(key)
      backedUp.current = true
      if (old) localStorage.removeItem(old)
    } catch {
      /* SQLite may still succeed. Hold the visible copy and protect reload on failure. */
    }
  }
  function recover(key: string, value: Chat) {
    pin(key)
    show(restored(value))
    pending.current = true
    backedUp.current = true
    mark(true)
    fail('Recovered an unsaved conversation. Retry saving or keep a separate copy.')
  }
  function show(value: Chat | null) {
    current.current = value
    render(value)
    remember(value?.id || 'new')
  }
  function clean() {
    const key = journal.current
    if (key) {
      try {
        localStorage.removeItem(key)
      } catch {
        /* SQLite has the saved snapshot. */
      }
      setList((all) => all.filter((row) => row.id !== key))
      pin(null)
    }
    pending.current = false
    backedUp.current = false
    mark(false)
    fail('')
  }
  function track({ id, title, updated, created, revision }: Summary) {
    setList((all) => [{ id, title, updated, created, revision }, ...all.filter((v) => v.id !== id)])
  }
  async function refresh() {
    const drafts = draftIndex()
    try {
      const all = await api<Summary[]>(path)
      setList([...drafts, ...all])
      return all
    } catch (e) {
      setList((previous) => [
        ...drafts,
        ...previous.filter((row) => !row.id.startsWith(draftPrefix)),
      ])
      throw e
    }
  }
  async function init() {
    if (initialized.current || loadingRef.current) return
    loadingRef.current = true
    load(true)
    fail('')
    try {
      const key = previousDraft(),
        unfinished = readDraft(key)
      if (key && unfinished) {
        recover(key, unfinished)
        initialized.current = true
        await refresh()
        return
      }
      const all = await refresh(),
        selected = lastSelection()
      const next = selected === 'new' ? undefined : all.find((x) => x.id === selected) || all[0]
      if (next) show(restored(await api<Chat>(path + '/' + next.id)))
      initialized.current = true
    } catch (e) {
      fail(
        pending.current
          ? 'Recovered your unsaved conversation. The local service is unavailable.'
          : errorText(e),
      )
    } finally {
      loadingRef.current = false
      load(false)
    }
  }
  async function open(id: string | null) {
    if (pending.current) throw Error('Save this conversation before switching.')
    if (loadingRef.current) return
    loadingRef.current = true
    load(true)
    try {
      if (id?.startsWith(draftPrefix)) {
        const value = readDraft(id)
        if (!value) throw Error('This draft has already been saved or removed. Reopen History.')
        recover(id, value)
        initialized.current = true
      } else {
        show(id ? restored(await api<Chat>(path + '/' + id)) : null)
        clean()
        initialized.current = true
      }
      newId.current = null
    } finally {
      loadingRef.current = false
      load(false)
    }
  }
  async function ensure(title: string) {
    if (!initialized.current) throw Error('Open chat history again to load your conversations.')
    if (current.current) return current.current
    newId.current ??= crypto.randomUUID()
    const v = await api<Chat>(path, 'POST', {
      id: newId.current,
      title: title.replace(/\s+/g, ' ').trim().slice(0, 70),
    })
    newId.current = null
    show(v)
    track(v)
    return v
  }
  async function write(change: Partial<Changed> = {}) {
    const prev = current.current
    if (!prev) throw Error('Choose a conversation first.')
    const next = { ...prev, ...change }
    const data = JSON.stringify(next)
    if (/\bsk-[\w-]{12,}/i.test(data))
      throw Error('Enter API keys in Settings. This message was not saved.')
    stage(data)
    show(next)
    pending.current = true
    mark(true)
    try {
      const v = await api<Chat>(path + '/' + next.id, 'PUT', {
        title: next.title,
        revision: next.revision,
        entries: next.entries,
        context: next.context,
      })
      show(v)
      track(v)
      clean()
    } catch (e) {
      fail(
        (backedUp.current
          ? 'Conversation has unsaved changes. '
          : 'Keep this tab open until the conversation saves. ') + errorText(e),
      )
      throw e
    }
  }
  async function saveCopy() {
    if (!current.current) return
    const previous = restored(current.current),
      title = previous.title.slice(0, 64) + ' (copy)'
    newId.current ??= crypto.randomUUID()
    const v = await api<Chat>(path, 'POST', { id: newId.current, title })
    newId.current = null
    show({ ...v, entries: previous.entries, context: previous.context })
    await write()
  }
  async function remove() {
    if (!current.current) return
    await api(path + '/' + current.current.id + '?revision=' + current.current.revision, 'DELETE')
    const id = current.current.id
    clean()
    show(null)
    setList((all) => all.filter((x) => x.id !== id))
  }
  async function append(
    e: Omit<Entry, 'role' | 'id'> & { role?: Entry['role'] },
    context?: Context,
  ) {
    const prev = current.current
    if (!prev) throw Error('Choose a conversation first.')
    const id = (prev.entries.at(-1)?.id ?? 0) + 1
    await write({
      entries: [...prev.entries, { role: 'assistant', ...e, id }],
      ...(context ? { context } : {}),
    })
  }
  return {
    list,
    chat,
    current,
    dirty,
    pending,
    loading,
    error,
    init,
    open,
    ensure,
    append,
    write,
    refresh,
    remove,
    saveCopy,
  }
}
