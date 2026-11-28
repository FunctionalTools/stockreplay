import { test, expect, type Page } from '@playwright/test'
const live = process.env.STOCKREPLAY_LIVE_TESTS === '1'
async function connect(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('radio', { name: /^OpenAI API/ }).check()
  await page.getByLabel('API model').selectOption('gpt-4.1-mini')
  await page.getByLabel('OpenAI API key').fill('intercepted-browser-test-credential')
  await page.getByRole('button', { name: 'Connect & test' }).click()
  await expect(page.getByText(/Verified for generation/)).toBeVisible()
}
test.beforeEach(async ({ request }) => {
  await request.patch('/api/preferences', {
    data: { advanced: false, appearance: 'light', accent: 'forest', home_symbol: 'NVDA' },
  })
})
test('key pasted in Settings generates and saves cited independent scores', async ({
  page,
  request,
}) => {
  test.skip(live)
  await request.delete('/api/openai')
  await request.patch('/api/ai', { data: { provider: 'openai' } })
  await page.goto('/')
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  for (const name of ['Research', 'Watchlists', 'Portfolio']) {
    await expect(nav.getByRole('button', { name, exact: true })).toBeVisible()
  }
  await expect(
    page
      .getByRole('region', { name: 'Price forecast' })
      .getByRole('link', { name: 'Forecast calendar' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect OpenAI' })).toBeVisible()
  await connect(page)
  await page.getByRole('button', { name: 'Research', exact: true }).click()
  await page.getByRole('button', { name: /Generate scores|Update scores/ }).click()
  await expect(page.locator('.gauge-value')).toHaveText(['72', '58'])
  await expect(page.getByRole('heading', { name: 'Reasons for caution' })).toBeVisible()
  await expect(page.locator('.opinion a[href="https://example.org/market/company"]')).toBeVisible()
  await expect(page.getByRole('link', { name: 'View the published forecast' })).toHaveAttribute(
    'href',
    /stockanalysis.com/,
  )
  await expect(page.locator('.vote-bar')).toHaveCount(2)
  await page.reload()
  await expect(page.locator('.gauge-value')).toHaveText(['72', '58'])
  await expect(page.getByRole('button', { name: 'Update scores' })).toBeVisible()
})
test('appearance, model dropdown and advanced chart drawings persist', async ({
  page,
  request,
}) => {
  test.skip(live)
  await request.put('/api/openai', { data: { key: 'intercepted-browser-test-credential' } })
  await page.goto('/#/settings/NVDA')
  await page.getByRole('button', { name: 'dark', exact: true }).click()
  await page.getByRole('button', { name: 'violet', exact: true }).click()
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/preferences') &&
      r.request().method() === 'PATCH' &&
      r.request().postDataJSON()?.advanced === true,
  )
  await page.getByRole('switch', { name: /Advanced trader tools/ }).check()
  await saved
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'violet')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark')
  await expect(page.getByRole('switch')).toBeChecked()
  await page.getByRole('button', { name: 'Research', exact: true }).click()
  const chart = page.locator('.primary-chart .desk-chart')
  await expect(chart.locator('canvas').first()).toBeVisible()
  await page.getByRole('button', { name: 'Draw box' }).click()
  await chart.click({ position: { x: 140, y: 100 } })
  await expect(page.getByText('Select the second point on the chart.')).toBeVisible()
  await chart.click({ position: { x: 270, y: 180 } })
  await expect(page.getByRole('button', { name: 'Undo drawing' })).toBeEnabled()
  await page.getByRole('button', { name: 'Open assistant' }).click()
  const chat = page.getByRole('region', { name: 'StockReplay assistant' })
  await chat.getByLabel('Message the assistant').fill('Set a price alert for NVDA above 25')
  await chat.getByRole('button', { name: 'Send message' }).click()
  await expect(chat.getByText('Watching NVDA above 25.')).toBeVisible()
  await chat.getByLabel('Message the assistant').fill('Save my chart layout')
  await chat.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Chart layout saved on this Mac.')).toBeVisible()
  await chat.getByRole('button', { name: 'Minimize assistant' }).click()
  await expect(page.getByRole('button', { name: 'Undo drawing' })).toBeEnabled()
  await page.getByRole('button', { name: 'Save layout' }).click()
  await expect(page.getByText('Chart layout saved on this Mac.')).toBeVisible()
  const layout = await (await request.get('/api/desk/layout/NVDA')).json()
  expect(layout.drawings.at(-1)).toMatchObject({ kind: 'box' })
  await page.getByLabel('RSI 14', { exact: true }).check()
  await expect(page.locator('[data-study="RSI 14"] canvas').first()).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Undo drawing' })).toBeEnabled()
})
test('watchlist file, local Fidelity holdings and imported daily chart', async ({ page }) => {
  test.skip(live)
  await page.goto('/#/watchlists/NVDA')
  await page.getByLabel('New watchlist name').fill('File imports')
  await page.getByRole('button', { name: 'Create list' }).click()
  await expect(page.getByLabel('Watchlist', { exact: true })).toContainText('File imports')
  await page.getByRole('button', { name: 'Import symbols' }).click()
  await page.getByLabel('Watchlist CSV').setInputFiles({
    name: 'mine.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Symbol\nNVDA\nMSFT\n'),
  })
  await expect(page.getByText('2 added, 0 already on this list.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'MSFT', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Portfolio', exact: true }).click()
  await page.getByRole('button', { name: 'Import statement' }).click()
  const modal = page.getByRole('dialog')
  await modal.getByLabel('Positions statement').setInputFiles({
    name: 'positions.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total\nTEST12349870,Retirement,NVDA,NVIDIA,2,100,200,150\n',
    ),
  })
  await modal.getByRole('button', { name: 'Preview statement' }).click()
  await expect(modal.getByText(/Retirement ··9870/)).toBeVisible()
  await modal.getByRole('button', { name: 'Apply reviewed statement' }).click()
  await expect(page.getByText('Holdings updated on this Mac.')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Edit NVDA' })).toBeVisible()
  await page.getByText('Imported price history', { exact: true }).click()
  await page.getByLabel('Price file ticker').fill('MYDATA')
  await page.getByLabel('Daily price CSV').setInputFiles({
    name: 'prices.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Date,Open,High,Low,Close,Adj Close,Volume\n2025-02-03,12,14,10,13,13,122\n2025-02-04,13,16,11,15,15,120\n',
    ),
  })
  await page.getByRole('button', { name: 'Import prices' }).click()
  await expect(page.getByRole('img', { name: 'MYDATA historical adjusted prices' })).toBeVisible()
})
test('assistant creates a watchlist, plots a comparison and minimizes without losing the chart', async ({
  page,
  request,
}) => {
  test.skip(live)
  await page.goto('/')
  await connect(page)
  await page.getByRole('button', { name: 'Open assistant' }).click()
  const chat = page.getByRole('region', { name: 'StockReplay assistant' })
  await chat
    .getByLabel('Message the assistant')
    .fill('Create a watchlist called Chat list and add MSFT')
  await chat.getByRole('button', { name: 'Send message' }).click()
  await expect(chat.getByText('Watching MSFT · Chat list.')).toBeVisible()
  expect(
    (await (await request.get('/api/watchlists')).json()).find(
      (l: { name: string }) => l.name === 'Chat list',
    ).symbols,
  ).toContain('MSFT')
  await chat.getByLabel('Message the assistant').fill('Graph NVDA and MSFT over one year')
  await chat.getByRole('button', { name: 'Send message' }).click()
  await expect(
    chat.getByRole('img', { name: /NVDA and MSFT historical percentage returns/ }),
  ).toBeVisible()
  await chat.getByRole('button', { name: 'Minimize assistant' }).click()
  await page.getByRole('button', { name: 'Portfolio', exact: true }).click()
  await page.getByRole('button', { name: 'Open assistant' }).click()
  await expect(
    chat.getByRole('img', { name: /NVDA and MSFT historical percentage returns/ }),
  ).toBeVisible()
})
test('mobile navigation and research stay within the viewport', async ({ page }) => {
  test.skip(live)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Analyst ratings' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('group', { name: 'AI provider' })).toBeVisible()
})
test('live public research displays dated news, analyst forecasts and market history', async ({
  page,
}) => {
  test.skip(!live)
  await page.goto('/#/research/AAPL/range_6mo')
  await expect(page.getByRole('heading', { name: 'Analyst ratings' })).toBeVisible({
    timeout: 100000,
  })
  await expect(page.getByRole('link', { name: 'View the published forecast' })).toHaveAttribute(
    'href',
    /stockanalysis.com/,
  )
  await expect(page.locator('.story a').first()).toHaveAttribute('href', /^https?:\/\//)
  await expect(page.getByRole('img', { name: /AAPL historical/ })).toBeVisible()
  await expect(page.locator('.quote')).not.toHaveText('—')
  if (process.env.STOCKREPLAY_SCREENSHOTS === '1') {
    await page.screenshot({ path: '../docs/screenshots/research.png' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.screenshot({ path: '../docs/screenshots/settings.png' })
    await page.getByRole('button', { name: 'Research', exact: true }).click()
    await expect(page.locator('.quote')).not.toHaveText('—')
    await expect(page.getByRole('link', { name: 'View the published forecast' })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: '../docs/screenshots/mobile.png' })
  }
})
