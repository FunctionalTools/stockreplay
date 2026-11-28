import { expect, test } from '@playwright/test'
import type { ForecastSnapshot } from '../src/forecastSnapshot'

test('looking up a stock automatically draws and saves a real local model prediction', async ({
  page,
}) => {
  test.skip(
    process.env.STOCKREPLAY_LIVE_OLLAMA !== '1' || process.env.STOCKREPLAY_LIVE_TESTS !== '1',
    'Uses an installed Ollama model and published prices',
  )
  test.setTimeout(12 * 60_000)
  await page.goto('/#/settings')
  await page
    .getByLabel('Installed local model')
    .selectOption(process.env.STOCKREPLAY_TEST_OLLAMA_MODEL || 'qwen2.5:3b')
  const verified = page.waitForResponse(
    (r) => r.url().endsWith('/api/ai/ollama') && r.request().method() === 'PUT',
  )
  await page.getByRole('button', { name: 'Connect & test' }).click()
  expect((await (await verified).json()).verified).toBe(true)

  const generated = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === '/api/desk/forecast/SNDK' &&
      new URL(r.url()).searchParams.get('auto') === 'true',
    { timeout: 600_000 },
  )
  const search = page.getByRole('textbox', { name: 'Search stocks' })
  await search.fill('SNDK')
  await search.press('Enter')
  const response = await generated
  expect(response.ok(), await response.text()).toBe(true)
  const row: ForecastSnapshot = (await response.json()).forecast
  expect(row.provider).toBe('ollama')
  expect(row.symbol).toBe('SNDK')
  expect(row.scores?.model).toBeTruthy()
  const sourceIds = new Set(row.sources.filter((s) => s.url && s.date).map((s) => s.id))
  for (const ids of [row.scores!.buy_source_ids, row.scores!.risk_source_ids]) {
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((id) => sourceIds.has(id))).toBe(true)
  }
  const chart = page.getByRole('region', { name: 'Price forecast', exact: true })
  await expect(chart.locator('path[data-line]')).toHaveCount(1)
  await expect(chart.locator('path[data-line="prediction"]')).toHaveAttribute('d', /^M.+L/)
  const dials = page.locator('#scores .gauge-value')
  const scores = row.scores!
  const displayedScores = [
    scores.buy_status === 'unresolved' ? '—' : String(scores.buy_score),
    scores.risk_status === 'unresolved' ? '—' : String(scores.risk_score),
  ]
  await expect(dials).toHaveText(displayedScores)
  const start = row.points[0],
    end = row.points.at(-1)!
  expect(end.date > start.date).toBe(true)
  expect(start.prediction).toBeGreaterThan(0)
  expect(end.prediction).toBeGreaterThan(0)
  const visiblePercent = await chart.locator('.period-change .delta').innerText()
  const change = (end.prediction! / start.prediction! - 1) * 100
  expect(Number.parseFloat(visiblePercent)).toBeCloseTo(change, 2)
  await page.reload()
  await expect(chart.locator('path[data-line="prediction"]')).toBeVisible()
  await expect(dials).toHaveText(displayedScores)
  const saved = await page.request.get('/api/desk/forecast/SNDK?range=' + row.range)
  expect((await saved.json()).forecast.id).toBe(row.id)
})
