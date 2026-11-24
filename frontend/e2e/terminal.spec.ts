import { expect, test, type Page } from '@playwright/test'

const live = process.env.STOCKREPLAY_LIVE_TESTS === '1'
const date = '2025-11-28'
const evidence = ['price', 'market', 'sector', 'sector_news', 'company_news', 'macro_news'].map(
  (group) => ({
    id: group,
    text: group + ' integration-test evidence',
    group,
    source: 'Test publisher',
    url: 'https://example.org/' + group,
    date,
  }),
)
const pack = (data: unknown) => ({
  data,
  error: null,
  fetched: date + 'T18:00:00Z',
  stale: false,
})
const chartBars = Array.from({ length: 215 }, (_, i) => ({
  date: new Date((1735689600 + i * 86400) * 1000).toISOString().slice(0, 10),
  time: 1735689600 + i * 86400,
  open: 98 + i / 10,
  high: 100 + i / 10,
  low: 97 + i / 10,
  close: 99 + i / 10,
  raw_close: 99 + i / 10,
  volume: 1000 + i,
  dividend: 0,
  split: 0,
}))
const rating = {
  score: 60,
  label: 'Constructive',
  current: true,
  formula: 'Technical rating v1',
  as_of: date,
  factors: [
    {
      label: 'Integration factor',
      value: 0,
      points: 10,
      weight: 20,
      floor: -10,
      ceiling: 10,
    },
  ],
}
async function publicSources(page: Page) {
  if (live) return
  await page.route('**/api/desk/chart/**', (r) =>
    r.fulfill({
      json: pack({
        symbol: 'NVDA',
        currency: 'USD',
        timezone: 'America/New_York',
        as_of: date,
        bars: chartBars,
        url: 'https://example.org/history',
        source: 'Test fixture',
        latest_completed_session: date,
      }),
    }),
  )
  await page.route('**/api/desk/brief/**', (r) =>
    r.fulfill({
      json: {
        symbol: 'NVDA',
        name: 'NVIDIA',
        as_of: date,
        sector: 'Technology',
        sector_etf: 'XLK',
        current_prices: true,
        current_context: true,
        fundamentals: {},
        profile_fetched: date,
        rating,
        evidence,
        issues: [],
      },
    }),
  )
  await page.route('**/api/desk/ratings/**', async (r) => {
    if (r.request().method() !== 'GET') return r.continue()
    return r.fulfill({
      json: {
        symbol: 'NVDA',
        actions: pack([
          {
            firm: 'Coverage firm',
            grade: 'Hold',
            date,
            action: 'Maintains',
            source: 'Test fixture',
            url: 'https://example.org/rating',
          },
        ]),
        stockanalysis: pack([]),
        consensus: pack([{ period: '0m', buy: 1, hold: 2 }]),
        profile: pack({ longName: 'NVIDIA' }),
        nasdaq: pack({
          grade: 'Hold',
          url: 'https://example.org/consensus',
          summary: 'Test coverage',
          contributors: [],
        }),
        price_issues: [],
        stockreplay: rating,
        disclosures: [],
      },
    })
  })
  await page.route('**/api/desk/quote/**', (r) =>
    r.fulfill({
      json: pack({
        symbol: 'NVDA',
        price: 120,
        previous: 119,
        currency: 'USD',
        time: 1735689600,
        url: 'https://example.org/quote',
      }),
    }),
  )
  await page.route('**/api/desk/screener**', (r) =>
    r.fulfill({
      json: pack([
        {
          symbol: 'NVDA',
          shortName: 'NVIDIA',
          regularMarketPrice: 120,
          currency: 'USD',
          regularMarketTime: 1735689600,
          marketCap: 100000000000,
          regularMarketChangePercent: 2.1,
          regularMarketVolume: 1200000,
        },
      ]),
    }),
  )
}
async function nav(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true })
    .click()
}
async function open(page: Page, name: string) {
  await publicSources(page)
  await page.goto('/')
  await nav(page, name)
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
}

test('Fidelity and other local positions can be reviewed, imported, edited and reopened', async ({
  page,
}) => {
  await open(page, 'Holdings')
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
  await expect(modal).not.toContainText('TEST12349870')
  await modal.getByRole('button', { name: 'Apply reviewed statement' }).click()
  await expect(page.getByText('Holdings updated on this Mac.')).toBeVisible()
  await page.getByRole('button', { name: 'Edit NVDA', exact: true }).click()
  await modal.getByLabel('Statement value').fill('245')
  await modal.getByRole('button', { name: 'Save position' }).click()
  await page.reload()
  await nav(page, 'Holdings')
  await expect(page.getByRole('table')).toContainText('245')
  await page.getByRole('button', { name: /Delete account Retirement/ }).click()
  await modal.getByRole('button', { name: 'Remove local record' }).click()
  await expect(page.getByRole('heading', { name: 'Add your first account' })).toBeVisible()
})
test('watchlists, screener shortcuts and alerts persist', async ({ page }) => {
  await open(page, 'Watchlists')
  await page.getByLabel('New watchlist name').fill('Browser research list')
  await page.getByRole('button', { name: 'Create list' }).click()
  await expect(page.getByRole('combobox', { name: 'Watchlist', exact: true })).toContainText(
    'Browser research list',
  )
  await page.getByLabel('Add watchlist symbol').fill('NVDA')
  await page.getByRole('button', { name: 'Add symbol' }).click()
  await expect(page.getByRole('button', { name: 'Ratings', exact: true })).toBeVisible()
  await page.getByLabel('Threshold price').fill('150')
  await page.getByRole('button', { name: 'Create alert' }).click()
  await expect(page.getByText('Watching', { exact: true })).toBeVisible()
  await nav(page, 'Market screener')
  await expect(page.getByRole('table')).toBeVisible({ timeout: 60000 })
  const watch = page.getByRole('button', { name: /^Watch [A-Z]/ }).first()
  await watch.click()
  await expect(page.getByRole('status').filter({ hasText: 'saved to the watchlist' })).toBeVisible()
  await nav(page, 'Watchlists')
  await page.getByRole('button', { name: 'Delete alert for NVDA' }).click()
  await page
    .getByRole('combobox', { name: 'Watchlist', exact: true })
    .selectOption({ label: 'Browser research list' })
  await page.getByText('Manage this watchlist').click()
  await page.getByRole('button', { name: 'Delete list', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete watchlist' }).click()
  await expect(page.getByRole('combobox', { name: 'Watchlist', exact: true })).not.toContainText(
    'Browser research list',
  )
})
test('public research, issuer ratings and explicit in-site API-key controls', async ({ page }) => {
  await open(page, 'Market research')
  await expect(page.getByRole('heading', { name: 'Research evidence' })).toBeVisible({
    timeout: 90000,
  })
  await page.getByLabel('Evidence category').selectOption('company_news')
  await expect(page.locator('.news-feed article').first()).toBeVisible()
  await page.getByRole('button', { name: 'Connect an OpenAI API key' }).click()
  await page.getByLabel('OpenAI API key', { exact: true }).fill('integration-test-session-key-only')
  await page.getByRole('button', { name: 'Save API key', exact: true }).click()
  await expect(page.getByText('Key configured', { exact: true })).toBeVisible()
  // Browser integration exercises the local key lifecycle. Real API payload/response contracts are verified with the backend transport tests.
  await nav(page, 'Market research')
  await expect(page.getByRole('button', { name: 'Generate recommendation' })).toBeEnabled({
    timeout: 90000,
  })
  await page.route('**/api/desk/recommend/NVDA', (r) =>
    r.fulfill({
      status: 429,
      json: {
        detail: 'OpenAI reported a rate limit or insufficient API credits.',
      },
    }),
  )
  await page.getByRole('button', { name: 'Generate recommendation' }).click()
  await expect(page.getByRole('alert')).toContainText('API credits')
  if (!live) {
    const point = { text: 'A cited integration-test observation.', citations: ['company_news'] }
    const sample = {
      id: 'test-view',
      stance: 'Neutral',
      horizon: 'Weeks',
      thesis: point,
      catalysts: [point],
      risks: [point],
      reconsider: point,
      created: date + 'T18:00:00Z',
      as_of: date,
      model: 'integration-model',
      sources: evidence,
    }
    await page.unroute('**/api/desk/recommend/NVDA')
    await page.route('**/api/desk/recommend/NVDA', (route) =>
      route.fulfill({ json: route.request().method() === 'POST' ? sample : [sample] }),
    )
    await page.getByRole('button', { name: 'Generate recommendation' }).click()
    await expect(page.getByLabel('Saved recommendations on this Mac')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'What would change the view' })).toBeVisible()
    await expect(page.locator('.opinion .ref').first()).toHaveAttribute(
      'href',
      'https://example.org/company_news',
    )
  }
  await nav(page, 'Investor ratings')
  await expect(page.getByRole('heading', { name: 'Published analyst actions' })).toBeVisible({
    timeout: 90000,
  })
  const filter = page.getByLabel('Filter analyst actions')
  await filter.fill('no such firm in this test')
  await expect(page.getByText('No matching dated rating is available.')).toBeVisible()
  await filter.fill('')
  await expect(page.locator('table').last().locator('tbody tr').first()).toBeVisible()
  if (live && process.env.STOCKREPLAY_SCREENSHOTS === '1') {
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: '../docs/screenshots/investor-ratings.png' })
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Remove API key', exact: true }).click()
  await expect(page.getByText('No key configured')).toBeVisible()
})
test('native chart studies, replay, saved layouts and isolated TradingView tools', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await open(page, 'Charts')
  await expect(page.locator('.desk-chart canvas').first()).toBeVisible({
    timeout: 60000,
  })
  await page.getByLabel('Additional chart symbols').fill('SPY')
  await page.getByRole('button', { name: 'Apply panels' }).click()
  await expect(
    page.getByRole('region', { name: 'SPY price panel' }).locator('canvas').first(),
  ).toBeVisible({ timeout: 60000 })
  await page.getByLabel('Price scale').selectOption('Logarithmic')
  const bars = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export bars CSV' }).click()
  expect((await bars).suggestedFilename()).toBe('NVDA-1d-bars.csv')
  await page.getByLabel('Chart style').selectOption('OHLC')
  await page.getByLabel('RSI 14', { exact: true }).check()
  await page.getByLabel('MACD', { exact: true }).check()
  await expect(page.locator('[data-study="RSI 14"] canvas').first()).toBeVisible()
  await page.getByRole('button', { name: 'Horizontal level' }).click()
  await page.locator('.primary-chart .desk-chart').click({ position: { x: 160, y: 120 } })
  await expect(page.getByRole('button', { name: 'Undo drawing' })).toBeEnabled()
  await page.getByLabel('Compare ticker').fill('SPY')
  await page.getByRole('button', { name: 'Apply comparison' }).click()
  await page.getByRole('button', { name: 'Play replay' }).click()
  await expect(page.getByText(/Replay bar ·/)).toBeVisible()
  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  await page.getByRole('button', { name: 'Save layout' }).click()
  await expect(page.getByText('Chart layout saved on this Mac.')).toBeVisible()
  await nav(page, 'Market screener')
  await nav(page, 'Charts')
  await expect(page.getByLabel('Chart style')).toHaveValue('OHLC')
  await expect(page.getByLabel('RSI 14', { exact: true })).toBeChecked()
  if (live && process.env.STOCKREPLAY_SCREENSHOTS === '1')
    await page.screenshot({ path: '../docs/screenshots/charts.png' })
  await nav(page, 'TradingView tools')
  await expect(page.locator('iframe')).toHaveCount(0)
  if (!live)
    await page.route('https://www.tradingview-widget.com/**', (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: '<title>Integration widget</title>',
      }),
    )
  await page.getByRole('button', { name: 'Load TradingView tool' }).click()
  await expect(page.locator('iframe')).toHaveAttribute(
    'src',
    /^https:\/\/www\.tradingview-widget\.com\/embed-widget\/advanced-chart\//,
  )
  if (live)
    await expect(page.frameLocator('iframe').locator('canvas').first()).toBeVisible({
      timeout: 90000,
    })
  await page.getByRole('button', { name: 'Close connection' }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  expect(errors).toEqual([])
})
