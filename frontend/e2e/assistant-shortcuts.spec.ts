import { expect, test } from '@playwright/test'

test('shows the turn immediately and applies compound local settings in one update', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  let submitted: () => void, release: () => void
  const started = new Promise<void>((r) => (submitted = r))
  const hold = new Promise<void>((r) => (release = r))
  let prefs = 0,
    plans = 0
  await page.goto('/#/settings/NVDA')
  await page.getByRole('button', { name: 'Open assistant' }).click()
  const chat = page.getByRole('region', { name: 'StockReplay assistant' })
  await chat.getByRole('button', { name: 'Chat history' }).click()
  await chat.getByRole('button', { name: 'New conversation' }).click()
  await page.route('**/api/assistant/chats', async (r) => {
    if (r.request().method() === 'POST') {
      submitted()
      await hold
    }
    return r.continue()
  })
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/preferences' && r.method() === 'PATCH') prefs++
    if (new URL(r.url()).pathname === '/api/assistant' && r.method() === 'POST') plans++
  })
  const prompt = 'enable dark mode and ocean accent and disable advanced tools'
  await chat.getByLabel('Message the assistant').fill(prompt)
  await chat.getByRole('button', { name: 'Send message' }).click()
  await started
  await expect(chat.getByRole('article', { name: 'Your message' })).toContainText(prompt)
  await expect(chat.getByRole('status')).toContainText('Saving message')
  expect(plans).toBe(0)
  release!()
  await expect(chat.getByText('Saved dark mode, ocean accent, advanced tools off.')).toBeVisible()
  expect(prefs).toBe(1)
  const saved = await (await request.get('/api/preferences')).json()
  expect(saved).toMatchObject({
    appearance: 'dark',
    accent: 'ocean',
    advanced: false,
  })
  await chat.getByLabel('Message the assistant').fill('show Apple for the past three months')
  await chat.getByRole('button', { name: 'Send message' }).click()
  await expect(page).toHaveURL(/#\/research\/AAPL\/range_3mo$/)
  await expect(chat.getByRole('link', { name: 'View performance' })).toHaveAttribute(
    'href',
    '#/research/AAPL/range_3mo',
  )
})
