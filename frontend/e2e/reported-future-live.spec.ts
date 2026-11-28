import { expect, test } from '@playwright/test'

test('live public research draws the SNDK Future horizons from the recording', async ({ page }) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS !== '1', 'Reads published daily prices')
  const generated: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/desk/forecast/')) generated.push(r.url())
  })
  await page.goto('/#/research/SNDK/range_1mo')
  const past = page.getByRole('region', { name: 'Price history' })
  await past.getByRole('button', { name: '1M', exact: true }).click()
  await past.getByRole('button', { name: 'Future', exact: true }).click()
  const card = page.getByRole('region', { name: 'Price forecast', exact: true })
  const dates = new Map<string, string>()
  for (const label of ['1M', '1D', '5D', '1W', '2Y']) {
    await card.getByRole('button', { name: label, exact: true }).click()
    await expect(card.getByText(label + ' · Price model prediction')).toBeVisible()
    const times = card.locator('.future-estimate time')
    await expect(times).toHaveCount(2, { timeout: 90000 })
    const end = (await times.first().getAttribute('datetime'))!
    const observed = (await times.last().getAttribute('datetime'))!.slice(0, 10)
    expect(end).toBeTruthy()
    expect(end > observed || (end === observed && label === '1D')).toBe(true)
    await expect(card.locator('path[data-line="prediction"]')).toHaveAttribute('d', /^M.+L/)
    await expect(card.locator('[aria-label="Predicted price"]')).toContainText('$')
    dates.set(label, end)
  }
  expect(dates.get('1D')! < dates.get('5D')!).toBe(true)
  expect(dates.get('1W')! < dates.get('1M')! && dates.get('1M')! < dates.get('2Y')!).toBe(true)
  expect(generated).toEqual([])
})
