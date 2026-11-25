import { expect, test } from '@playwright/test'
test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1', 'Uses controlled assistant replies')
test('long answers stay inside a compact window and the history menu restores links', async ({
  page,
  request,
}) => {
  await request.put('/api/openai', { data: { key: 'intercepted-browser-test-credential' } })
  let calls = 0
  const long =
    'First, export your positions from your broker. ' +
    'Holdings data stays on your Mac. '.repeat(45) +
    'Saved final sentence.'
  await page.route('**/api/assistant', (r) => {
    calls++
    return r.fulfill({
      json: {
        reply: long,
        actions: [],
        links: [{ label: 'Open import guide', page: 'Portfolio', focus: 'import-guide' }],
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open assistant' }).click()
  const chat = page.getByRole('region', { name: 'StockReplay assistant' })
  await chat.getByRole('button', { name: 'Chat history' }).click()
  await chat.getByRole('button', { name: 'New conversation' }).click()
  await chat.getByLabel('Message the assistant').fill('Guide for my brokerage account')
  await chat.getByRole('button', { name: 'Send message' }).click()
  const response = chat.getByRole('article', { name: 'Assistant response' }).last()
  await expect(response.getByRole('link', { name: 'Open import guide' })).toBeVisible()
  await expect(response).not.toContainText('Saved final sentence.')
  expect((await response.locator('.chat-text').innerText()).length).toBeLessThan(170)
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 320, height: 568 },
    { width: 568, height: 320 },
  ]) {
    await page.setViewportSize(viewport)
    const box = await chat.boundingBox()
    expect(box!.width).toBeLessThanOrEqual(Math.min(356, viewport.width - 16))
    expect(box!.height).toBeLessThan(viewport.height * 0.66)
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
  }
  await response.getByRole('button', { name: 'Read more' }).click()
  await expect(response).toContainText('Saved final sentence.')
  expect(await chat.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  expect(await chat.locator('.chat-body').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
    true,
  )
  await response.getByRole('button', { name: 'Show less' }).click()
  await page.setViewportSize({ width: 1000, height: 750 })
  await response.getByRole('link', { name: 'Open import guide' }).click()
  await expect(page).toHaveURL(/#\/portfolio\/[^/]+\/import-guide$/)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open assistant' }).click()
  await chat.getByRole('button', { name: 'Chat history' }).click()
  await chat
    .getByRole('button', { name: /Guide for my brokerage account/ })
    .first()
    .click()
  await expect(chat.getByRole('link', { name: 'Open import guide' })).toBeVisible()
  expect(calls).toBe(1)
})
test('reopening an unconfirmed request preserves the exchange and never executes it', async ({
  page,
  request,
}) => {
  const created = await (
    await request.post('/api/watchlists', { data: { name: 'Keep after reload' } })
  ).json()
  await request.put('/api/openai', { data: { key: 'intercepted-browser-test-credential' } })
  let calls = 0
  await page.route('**/api/assistant', (r) => {
    calls++
    return r.fulfill({
      json: { reply: '', actions: [{ kind: 'delete_list', name: 'Keep after reload' }] },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open assistant' }).click()
  const chat = page.getByRole('region', { name: 'StockReplay assistant' })
  await chat.getByRole('button', { name: 'Chat history' }).click()
  await chat.getByRole('button', { name: 'New conversation' }).click()
  await chat.getByLabel('Message the assistant').fill('Delete my list Keep after reload')
  await chat.getByRole('button', { name: 'Send message' }).click()
  await expect(chat.getByRole('button', { name: 'Apply change' })).toBeEnabled()
  await page.reload()
  await page.getByRole('button', { name: 'Open assistant' }).click()
  await expect(chat.getByText(/Expired\. Ask again/)).toBeVisible()
  await expect(chat.getByRole('button', { name: 'Apply change' })).toHaveCount(0)
  expect(
    (await (await request.get('/api/watchlists')).json()).some(
      (l: { id: string }) => l.id === created.id,
    ),
  ).toBe(true)
  expect(calls).toBe(1)
})
