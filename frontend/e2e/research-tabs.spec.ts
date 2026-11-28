import { test, expect } from '@playwright/test'

test('assistant creates and updates a saved tab with scores and a working range chart', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await request.put('/api/openai', { data: { key: 'intercepted-browser-test-credential' } })
  await page.goto('/#/research/AAPL')
  await page.getByRole('button', { name: 'Open assistant' }).click()
  const chat = page.getByRole('region', { name: 'StockReplay assistant' })
  async function send(message: string) {
    await chat.getByLabel('Message the assistant').fill(message)
    await chat.getByRole('button', { name: 'Send message' }).click()
  }
  await send(
    'Create a Monthly review tab with Apple buy and risk scores and a one-month price chart.',
  )
  await expect(page.getByRole('heading', { name: 'Monthly review' })).toBeVisible()
  const score = page.locator('.tab-widget-scores')
  await expect(
    score.getByRole('link', { name: /assessment|factors and sources/i }),
  ).toHaveAttribute('href', '#/research/AAPL/scores')
  const widget = page.locator('.tab-widget-chart')
  await expect(widget.getByRole('link', { name: /^AAPL\s*[+−-]?\d/ })).toHaveAttribute(
    'href',
    '#/research/AAPL/range_1mo',
  )
  await expect(widget.getByRole('link', { name: 'Open AAPL Future chart' })).toHaveAttribute(
    'href',
    '#/research/AAPL?view=future&range=1mo',
  )
  await send('Change block 2 to a five-day Apple chart on this tab.')
  await expect(widget.getByRole('link', { name: /^AAPL\s*[+−-]?\d/ })).toHaveAttribute(
    'href',
    '#/research/AAPL/range_5d',
  )
  await page.reload()
  const link = widget.getByRole('link', { name: /^AAPL\s*[+−-]?\d/ })
  await expect(link).toHaveText(/AAPL\s*[+−-]?\d+[.,]\d+%/)
  await link.click()
  await expect(page).toHaveURL(/research\/AAPL\/range_5d$/)
  await expect(page.getByRole('button', { name: '5D', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})
