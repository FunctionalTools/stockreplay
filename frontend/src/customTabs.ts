import { api } from './types'

export const tabViews = ['chart', 'news', 'ratings', 'watchlist', 'portfolio', 'note'] as const
export const tabSpans = ['1mo', '6mo', '1y', '2y', '5y', '10y'] as const
export type TabBlock = {
  view: (typeof tabViews)[number]
  value: string
  span: (typeof tabSpans)[number]
}
export type TabSummary = { id: string; title: string; revision: number; updated: string }
export type CustomTab = TabSummary & { blocks: TabBlock[] }
export type TabAction = {
  kind: 'tab'
  operation: 'create' | 'open' | 'rename' | 'delete' | 'append'
  name: string
  value: string
  blocks: TabBlock[]
  targetId?: string
  revision?: number
}
export const tabHref = (id: string) => '#/tabs/' + encodeURIComponent(id)
export function isTabAction(a: { kind: string }): a is TabAction {
  return a.kind === 'tab'
}

async function resolveTab(a: TabAction, currentTab?: string) {
  const title = a.name.trim().toLowerCase()
  const lists = await api<TabSummary[]>('/tabs')
  const currentId = location.hash.match(/^#\/tabs\/([0-9a-f]{32})$/)?.[1] || currentTab
  const matches = title
    ? lists.filter((t) => t.title.toLowerCase() === title)
    : lists.filter((t) => t.id === currentId)
  const match =
    matches.find((t) => t.title === a.name) || (matches.length === 1 ? matches[0] : undefined)
  if (!match) throw Error('Choose an existing tab in My tabs.')
  return match
}
export async function prepareTabDelete(a: TabAction, currentTab?: string): Promise<TabAction> {
  const target = await resolveTab(a, currentTab)
  return { ...a, name: target.title, targetId: target.id, revision: target.revision }
}
export async function executeTabAction(
  a: TabAction,
  openTab: (id: string) => void,
  changed: () => void,
  currentTab?: string,
): Promise<{ text: string; tab?: { id: string; title: string } }> {
  if (a.operation === 'delete') {
    if (!a.targetId || !/^[0-9a-f]{32}$/.test(a.targetId) || !a.revision)
      throw Error('Request deletion again to confirm the saved tab.')
    await api('/tabs/' + a.targetId + '?revision=' + a.revision, 'DELETE')
    changed()
    if (location.hash === tabHref(a.targetId)) openTab('')
    return { text: 'Deleted ' + a.name + '.' }
  }
  let saved: CustomTab
  if (a.operation === 'create') {
    saved = await api<CustomTab>('/tabs', 'POST', { title: a.name, blocks: a.blocks })
  } else {
    const found = await resolveTab(a, currentTab)
    const path = '/tabs/' + found.id
    saved = await api<CustomTab>(path)
    if (a.operation === 'rename' || a.operation === 'append') {
      if (a.operation === 'append' && !a.blocks.length) throw Error('Choose a block to add.')
      saved = await api<CustomTab>(path, 'PUT', {
        title: a.operation === 'rename' ? a.value : saved.title,
        blocks: a.operation === 'append' ? [...saved.blocks, ...a.blocks] : saved.blocks,
        revision: saved.revision,
      })
    } else if (a.operation !== 'open') throw Error('Choose a supported tab action.')
  }
  if (a.operation !== 'open') changed()
  openTab(saved.id)
  const verb = { create: 'Created', open: 'Opened', append: 'Updated', rename: 'Renamed' }[
    a.operation
  ]
  return { text: verb + ' ' + saved.title + '.', tab: { id: saved.id, title: saved.title } }
}
