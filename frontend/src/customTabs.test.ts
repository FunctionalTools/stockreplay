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
