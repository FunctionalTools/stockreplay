import { afterEach, expect, it, vi } from 'vitest'
import { executeTabAction, prepareTabDelete, tabHref, type TabAction } from './customTabs'

afterEach(() => vi.unstubAllGlobals())
it('keeps a deletion bound to the tab and revision originally confirmed', async () => {
  const first = 'a'.repeat(32),
    second = 'b'.repeat(32),
    location = { hash: tabHref(first) }
  vi.stubGlobal('location', location)
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json([
        { id: first, title: 'Energy', revision: 7 },
        { id: second, title: 'Portfolio review', revision: 2 },
      ]),
    )
    .mockResolvedValueOnce(Response.json({ removed: true }))
  vi.stubGlobal('fetch', fetch)
  const request: TabAction = { kind: 'tab', operation: 'delete', name: '', value: '', blocks: [] }
  const bound = await prepareTabDelete(request, first)
  expect(bound.name).toBe('Energy')
  location.hash = tabHref(second)
  const open = vi.fn(),
    changed = vi.fn()
  await executeTabAction(bound, open, changed, second)
  expect(fetch.mock.calls[1][0]).toBe('/api/tabs/' + first + '?revision=7')
  expect(open).not.toHaveBeenCalled()
  expect(changed).toHaveBeenCalledTimes(1)
})

it('updates only the specified saved block and leaves neighboring blocks in order', async () => {
  const id = 'c'.repeat(32)
  const blocks = [
    { view: 'note', value: 'Original note', span: '1y' },
    { view: 'chart', value: 'AAPL', span: '1y' },
  ]
  const updated = { view: 'chart', value: 'AAPL', span: '2025-08-04/2025-08-12' } as const
  const tab = { id, title: 'Apple', revision: 13, updated: '', blocks }
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json([tab]))
    .mockResolvedValueOnce(Response.json(tab))
    .mockResolvedValueOnce(Response.json({ ...tab, revision: 14, blocks: [blocks[0], updated] }))
  vi.stubGlobal('location', { hash: tabHref(id) })
  vi.stubGlobal('fetch', fetch)
  await executeTabAction(
    { kind: 'tab', operation: 'edit_block', name: '', value: '2', blocks: [updated] },
    vi.fn(),
    vi.fn(),
    id,
  )
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({
    title: 'Apple',
    revision: 13,
    blocks: [blocks[0], updated],
  })
})
