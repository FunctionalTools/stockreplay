import { expect, test } from '@playwright/test'

test('saved scores explain both judgments with evidence and preserve older assessments', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await request.put('/api/openai', { data: { key: 'intercepted-browser-test-credential' } })
  const generated = await request.post('/api/desk/recommend/MSFT')
  expect(generated.ok()).toBeTruthy()
  const opinion = await generated.json()
  await page.goto('/#/research/MSFT/scores')
  const breakdown = page.locator('.score-breakdown')
  await breakdown.locator(':scope > summary').click()
  await expect(breakdown.locator('.missing-factors')).toContainText('Cash generation')
  const valuation = breakdown
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'Valuation' }) })
  await valuation.locator('summary').click()
  await expect(valuation.locator('dd')).toHaveText([
    opinion.factors.find((f: { id: string }) => f.id === 'valuation').buy.text,
    opinion.factors.find((f: { id: string }) => f.id === 'valuation').risk.text,
  ])
  await expect(valuation.getByRole('link')).toHaveAttribute(
    'href',
    /finance.yahoo.com\/quote\/MSFT\/key-statistics/,
  )
  await expect(valuation.locator('.factor-attribution')).toContainText('Checked')
  const old = { ...opinion }
  delete old.factors
  await page.route('**/api/desk/recommend/MSFT', (route) => route.fulfill({ json: [old] }))
  await page.reload()
  await expect(page.getByText(/predates the factor breakdown/)).toBeVisible()
  await expect(page.locator('.gauge-value')).toHaveText(['72', '58'])
  await expect(page.getByRole('heading', { name: 'Reasons for caution' })).toBeVisible()
})
