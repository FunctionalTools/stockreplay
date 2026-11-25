import { expect, test } from '@playwright/test'

test('a conflicted transcript survives a reload as a local draft without repeating a command', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await request.put('/api/openai', { data: { key: 'intercepted-browser-test-credential' } })
  const session = await (
    await request.post('/api/assistant/chats', { data: { title: 'Laptop chat' } })
  ).json()
  const apiPath = '/api/assistant/chats/' + session.id
  await page.goto('/#/settings/NVDA')
  await page.evaluate((id) => localStorage.setItem('stockreplay.selected-chat.v1', id), session.id)
  await page.getByRole('button', { name: 'Open assistant' }).click()
  const chat = page.getByRole('region', { name: 'StockReplay assistant' })
  await expect(chat.getByText('Laptop chat', { exact: true })).toBeVisible()
  // Another browser window updates the active conversation before this tab submits a turn.
  await request.patch(apiPath, { data: { revision: 0, title: 'Updated elsewhere' } })
  let plans = 0
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/assistant' && r.method() === 'POST') plans++
  })
  await chat.getByLabel('Message the assistant').fill('Create a watchlist for European energy')
  await chat.getByRole('button', { name: 'Send message' }).click()
  await expect(chat.getByRole('button', { name: 'Save a copy' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Open assistant' }).click()
  await expect(
    chat.getByText('Create a watchlist for European energy', { exact: true }),
  ).toBeVisible()
  await chat.getByRole('button', { name: 'Save a copy' }).click()
  await expect(chat.getByText('Laptop chat (copy)', { exact: true })).toBeVisible()
  await expect(chat.getByRole('button', { name: 'Retry save' })).toHaveCount(0)
  const saved = await (await request.get(apiPath)).json()
  expect(saved.title).toBe('Updated elsewhere')
  expect(saved.entries).toEqual([])
  const all = await (await request.get('/api/assistant/chats')).json()
  const copy = all.find((row: { title: string }) => row.title === 'Laptop chat (copy)')
  expect(
    (await (await request.get('/api/assistant/chats/' + copy.id)).json()).entries,
  ).toMatchObject([{ text: 'Create a watchlist for European energy' }])
  expect(plans).toBe(0)
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('stockreplay.pending-chat.v1.')),
    ),
  ).toEqual([])
})
