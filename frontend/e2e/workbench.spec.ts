import { test, expect, type Page } from '@playwright/test'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Research results' })).toBeVisible()
  await page.locator('.candle-host canvas').first().waitFor()
}
async function screen(page: Page, name: string) {
  if (process.env.STOCKREPLAY_SCREENSHOTS === '1') {
    await mkdir('../docs/screenshots', { recursive: true })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({
      path: path.join('../docs/screenshots', name + '.png'),
      animations: 'disabled',
    })
  }
}
async function save(page: Page, name: string) {
  await page
    .getByRole('button', {
      name: /^(Save experiment|Update saved experiment)$/,
    })
    .click()
  await page.getByLabel('Experiment name', { exact: true }).fill(name)
  await page.getByLabel('Research notes').fill('Documented browser verification.')
  const copy = page.getByRole('button', { name: 'Save as new' })
  if (await copy.count()) await copy.click()
  else await page.getByRole('button', { name: 'Save research' }).click()
  await expect(page.getByText('Research saved to your library.')).toBeVisible()
}
async function nav(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: false })
    .click()
}
async function download(page: Page, act: () => Promise<unknown>) {
  const pending = page.waitForEvent('download')
  await act()
  const f = await pending
  const file = await f.path()
  return { name: f.suggestedFilename(), data: await readFile(file!) }
}

test('opening history, all chart views, counterexamples and chart export', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await ready(page)
  await screen(page, 'workbench')
  await expect(page.getByLabel('Experiment data source')).toHaveValue(
    process.env.STOCKREPLAY_LIVE_TESTS === '1' ? 'yahoo' : 'csv',
  )
  await page.getByRole('button', { name: '1Y', exact: true }).click()
  await page.getByRole('button', { name: 'Signals off' }).click()
  expect(
    (await download(page, () => page.getByRole('button', { name: 'Download chart' }).click())).data
      .subarray(0, 4)
      .toString('hex'),
  ).toBe('89504e47')
  await page.getByRole('button', { name: 'Event path', exact: true }).click()
  await expect(page.locator('.plot-host .main-svg').first()).toBeVisible()
  await page.getByRole('button', { name: 'Distribution', exact: true }).click()
  await expect(page.locator('.barlayer .point').first()).toBeVisible()
  const svg = await download(page, () =>
    page.getByRole('button', { name: 'Download chart' }).click(),
  )
  expect(svg.data.toString()).toContain('<svg')
  await page.getByRole('button', { name: /Counterexamples \d+/ }).click()
  await page
    .getByRole('button', { name: /^Inspect NVDA/ })
    .first()
    .click()
  await expect(page.getByRole('dialog').getByText('Counterexample', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Signal conditions at close' })).toBeVisible()
  await screen(page, 'counterexample')
  await page.keyboard.press('Escape')
  const rows = page.locator('.events tbody tr')
  for (const row of await rows.all()) await expect(row).toContainText('Counterexample')
  await page.getByRole('button', { name: /Met objective \d+/ }).click()
  for (const row of await rows.all()) await expect(row).toContainText('Met objective')
  await page.getByRole('button', { name: /All events \d+/ }).click()
  await expect(page.getByRole('button', { name: /All events \d+/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(errors).toEqual([])
})

test('builder portfolio, persistence, comparison and portable exports', async ({ page }) => {
  await page.route('**/api/ai', (route) =>
    route.fulfill({
      json: { model: 'offline', online: false, ready: false, models: [] },
    }),
  )
  await ready(page)
  await save(page, 'Baseline events')
  await page.getByRole('button', { name: 'Builder', exact: true }).click()
  await page.getByLabel('Research name').fill('Portfolio variant')
  await page.getByLabel('Experiment type').selectOption('portfolio')
  await page.getByRole('dialog').getByRole('button', { name: 'Run experiment' }).click()
  await expect(page.getByText('Executed trades', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Equity curve' }).click()
  await expect(page.locator('.plot-host .main-svg').first()).toBeVisible()
  await save(page, 'Allocated portfolio')
  await nav(page, 'Compare')
  await page.getByLabel('First experiment').selectOption({ label: 'Baseline events' })
  await page.getByLabel('Second experiment').selectOption({ label: 'Allocated portfolio' })
  await page.getByRole('button', { name: 'Save comparison' }).click()
  await expect(page.getByRole('table')).toContainText('Portfolio return')
  await nav(page, 'Research library')
  await page.getByRole('button', { name: 'Duplicate Allocated portfolio' }).click()
  await page
    .getByRole('button', {
      name: 'Edit Allocated portfolio (copy)',
      exact: true,
    })
    .click()
  await page.getByLabel('Experiment name').fill('Reviewed copy')
  await page.getByRole('button', { name: 'Save research' }).click()
  await page.getByRole('button', { name: 'Delete Reviewed copy', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete experiment', exact: true })
    .click()
  await expect(page.getByText('Reviewed copy', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /^Allocated portfolio Documented/ }).click()
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const json = await download(page, () =>
    page.getByRole('link', { name: /Reproducible experiment/ }).click(),
  )
  expect(JSON.parse(json.data.toString()).snapshots).toHaveLength(2)
  await page.keyboard.press('Escape')
  await nav(page, 'Research library')
  await page.getByLabel('Import experiment file').setInputFiles({
    name: 'research.stockreplay.json',
    mimeType: 'application/json',
    buffer: json.data,
  })
  await expect(page.getByText('Experiment reproduced from embedded snapshots.')).toBeVisible()
})

test('CSV import, cache export, AI failure and model settings', async ({ page }) => {
  await ready(page)
  await nav(page, 'Market data')
  await page.getByLabel('CSV ticker').fill('LAB')
  const csv = 'Date,Open,High,Low,Close,Adj Close,Volume\n2023-01-03,10,13,9,11,11,200\n'
  await page.getByLabel('Daily price file').setInputFiles({
    name: 'lab.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  })
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click()
  await expect(page.getByText('CSV validated and cached.')).toBeVisible()
  await page.getByLabel('Filter data source').selectOption('csv')
  expect(
    (
      await download(page, () => page.getByRole('link', { name: 'Export LAB CSV' }).click())
    ).data.toString(),
  ).toContain('Dividends')
  await nav(page, 'Workbench')
  await page.route('**/api/interpret', (route) =>
    route.fulfill({
      status: 503,
      json: { detail: 'Local Ollama is offline. Use the visual builder.' },
    }),
  )
  await page.getByRole('button', { name: 'Interpret', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('offline')
  await page.getByRole('button', { name: 'Builder', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Check connection' }).click()
  await expect(page.getByText('Connection checked.')).toBeVisible()
})

test('responsive workbench and reachable navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await ready(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await screen(page, 'mobile')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await nav(page, 'Robustness lab')
  await expect(page.getByRole('heading', { name: 'Sensitivity experiment' })).toBeVisible()
})

test('live Ollama and Yahoo through interpretation, holdout, save and HTML report', async ({
  page,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS !== '1', 'Enable real provider and installed model.')
  test.setTimeout(360000)
  await ready(page)
  await page.getByRole('button', { name: 'New experiment' }).click()
  await page
    .getByLabel('Investment hypothesis')
    .fill('Does NVIDIA have a positive five-session return after a daily loss greater than 3%?')
  await page.getByRole('button', { name: 'Interpret', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 150000 })
  await expect(dialog.getByRole('combobox', { name: 'Data source', exact: true })).toHaveValue(
    'yahoo',
  )
  await expect(dialog.getByLabel('Threshold', { exact: true })).toHaveValue('-3')
  await expect(dialog.getByLabel('Holding period (sessions)')).toHaveValue('5')
  await dialog.getByRole('button', { name: 'Run experiment', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Research results' })).toBeVisible({
    timeout: 120000,
  })
  await expect(page.locator('.result-context')).toContainText('Yahoo Finance')
  await expect(page.locator('.assistant-body')).toContainText('engine-grounded evidence', {
    timeout: 120000,
  })
  await expect(page.locator('.assistant-body small')).toContainText(
    process.env.STOCKREPLAY_MODEL || 'qwen2.5:7b',
  )
  await page.getByRole('button', { name: /Counterexamples \d+/ }).click()
  await page
    .getByRole('button', { name: /^Inspect NVDA/ })
    .first()
    .click()
  await expect(page.getByRole('dialog')).toContainText('Counterexample')
  await page.keyboard.press('Escape')
  await nav(page, 'Robustness lab')
  await page.getByRole('button', { name: 'Run robustness' }).click()
  await expect(page.getByRole('heading', { name: 'Parameter sensitivity' })).toBeVisible({
    timeout: 60000,
  })
  await expect(
    page.getByRole('heading', { name: 'Expanding walk-forward evaluation' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'In-sample', exact: true }).click()
  await page.getByRole('button', { name: 'Holdout', exact: true }).click()
  await nav(page, 'Workbench')
  await save(page, 'Live NVIDIA research')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const html = await download(page, () =>
    page.getByRole('link', { name: /HTML research report/ }).click(),
  )
  const report = html.data.toString()
  expect(report).toContain('Live NVIDIA research')
  expect(report).toContain('yahoo')
  expect(report).toContain('Documented browser verification.')
  expect(report).toContain('train_end')
  expect(report).toContain('<svg')
})

test('threshold, universe and regime controls produce a chronological sensitivity report', async ({
  page,
}) => {
  await ready(page)
  await nav(page, 'Robustness lab')
  await page.getByText('Universe, dates and walk-forward settings').click()
  await page.getByRole('combobox', { name: 'Search tickers' }).fill('Apple')
  await page.getByRole('option', { name: /AAPL/ }).waitFor()
  await page.getByRole('combobox', { name: 'Search tickers' }).press('ArrowDown')
  await page.getByRole('combobox', { name: 'Search tickers' }).press('Enter')
  await expect(page.getByRole('button', { name: 'Remove AAPL' })).toBeVisible()
  await page.getByLabel('Regime', { exact: false }).selectOption('bull')
  await page.getByText('Universe, dates and walk-forward settings').click()
  await page.getByRole('button', { name: 'Run robustness' }).click()
  await expect(page.getByRole('heading', { name: 'Parameter sensitivity' })).toBeVisible()
  await expect(page.locator('.heatmap tbody td')).toHaveCount(9)
  await screen(page, 'robustness')
})
