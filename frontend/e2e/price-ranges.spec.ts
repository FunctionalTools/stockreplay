import { expect, test } from '@playwright/test'

test('Research shows sourced period returns and inclusive custom dates', async ({ page }) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await page.goto('/#/research/AAPL/range_1d')
  const card = page.getByRole('region', { name: 'Price history', exact: true })
  const period = (name: string) => card.getByRole('button', { name, exact: true })
  const result = card.locator('.range-performance')
  await expect(period('1D')).toHaveAttribute('aria-pressed', 'true')
  await expect(result).toContainText('Previous close')
  await expect(card.getByRole('img', { name: 'AAPL historical intraday prices' })).toBeVisible()
  const plot = card.getByRole('img')
  await plot.focus()
  await plot.press('ArrowLeft')
  await expect(card.locator('figcaption')).toContainText(/\d:\d{2}/)
  await period('5D').click()
  await expect(result).toContainText('5 observed trading sessions')
  await period('YTD').click()
  await expect(result).toContainText('Prior year close')
  await period('Custom').click()
  await card.getByLabel('Start date').fill('2014-11-27')
  await card.getByLabel('End date').fill('2014-12-01')
  await card.getByRole('button', { name: 'Apply dates' }).click()
  await expect(result).toContainText('Nov 28, 2014')
  await expect(result).toContainText('Dec 1, 2014')
  await expect(card.locator('.period-change')).toContainText(/\d[.,]\d+%/)
  await period('Custom').click()
  await card.getByLabel('End date').fill('2014-11-27')
  await card.getByRole('button', { name: 'Apply dates' }).click()
  await expect(card).toContainText(/No observations|No trading observations/)
  await expect(result).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await period('1M').click()
  await expect(plot).toBeVisible()
  expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  await card.screenshot({ path: test.info().outputPath('mobile-range.png') })
})

test('historical range bar exposes every period on a phone and weekly deep links survive reload', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  const symbol = 'AAPL'
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/research/' + symbol + '/range_1w')
  const card = page.getByRole('region', { name: 'Price history', exact: true })
  const periods = card.getByRole('group', { name: 'Chart period' })
  const expected = [
    '1D',
    '5D',
    '1W',
    '1M',
    '3M',
    '6M',
    'YTD',
    '1Y',
    '2Y',
    '5Y',
    '10Y',
    'Max',
    'Custom',
  ]
  await expect(periods.getByRole('button')).toHaveText(expected)
  for (const button of await periods.getByRole('button').all()) {
    const box = await button.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  }
  await expect(periods.getByRole('button', { name: '1W' })).toHaveAttribute('aria-pressed', 'true')
  const data = (await (await request.get('/api/desk/range/' + symbol + '?range=1w')).json()).data
  const { start, end } = data.performance
  const change = 100 * (end.price / start.price - 1)
  expect(data.performance.percent).toBeCloseTo(change, 8)
  await expect(card.locator('.period-change')).toContainText(change.toFixed(2) + '%')
  await expect(card).toContainText('one calendar week')
  await periods.getByRole('button', { name: '10Y', exact: true }).click()
  await expect(page).toHaveURL(/range_10y$/)
  await page.reload()
  await expect(periods.getByRole('button', { name: '10Y', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await periods.getByRole('button', { name: 'Max', exact: true }).click()
  await expect(card.getByRole('img', { name: 'AAPL historical adjusted prices' })).toBeVisible()
  await expect(card.getByRole('link', { name: 'Yahoo Finance' })).toHaveAttribute(
    'href',
    /finance\.yahoo\.com/,
  )
  const saved = await request.post('/api/tabs', {
    data: { title: 'Weekly history link', blocks: [{ view: 'chart', value: symbol, span: '1w' }] },
  })
  expect(saved.ok()).toBeTruthy()
  const tab = await saved.json()
  await page.goto('/#/tabs/' + tab.id)
  await page.locator('a[href="#/research/AAPL/range_1w"]').click()
  await expect(periods.getByRole('button', { name: '1W', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(card.locator('.range-performance')).toContainText('one calendar week')
})

test('legacy chat charts reopen custom dates and intraday spans through the same history backend', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  const title = 'Earlier chart history'
  const resp = await request.post('/api/assistant/chats', {
    data: {
      title,
      context: [],
      entries: [
        {
          id: 1,
          role: 'assistant',
          text: 'Earlier custom range',
          graph: { symbols: ['AAPL'], span: '2014-11-27/2014-12-01' },
        },
        {
          id: 2,
          role: 'assistant',
          text: 'Earlier single day',
          graph: { symbols: ['NVDA'], span: '1d' },
        },
      ],
    },
  })
  expect(resp.ok()).toBeTruthy()
  await page.goto('/#/settings')
  await page.getByRole('button', { name: 'Open assistant' }).click()
  const chat = page.getByRole('region', { name: 'StockReplay assistant' })
  await chat.getByRole('button', { name: 'Chat history' }).click()
  await chat
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click()
  await expect(chat.getByRole('img', { name: 'AAPL historical adjusted prices' })).toBeVisible()
  await expect(chat.getByRole('img', { name: 'NVDA historical intraday prices' })).toBeVisible()
  await expect(chat.locator('.chat-graph').first()).toContainText(/Dec 1, 2014/)
})
