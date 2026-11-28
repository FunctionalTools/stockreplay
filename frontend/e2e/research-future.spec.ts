import { test, expect, type APIRequestContext } from '@playwright/test'

async function connect(request: APIRequestContext) {
  expect(
    (
      await request.put('/api/openai', { data: { key: 'intercepted-browser-test-credential' } })
    ).ok(),
  ).toBe(true)
  expect((await request.patch('/api/ai', { data: { provider: 'openai' } })).ok()).toBe(true)
}

test('the homepage price card generates and reopens a cited future forecast on explicit request', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await connect(request)
  const generations: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/desk/forecast/')) generations.push(r.url())
  })
  await page.goto('/#/research/AAPL')
  const past = page.getByRole('region', { name: 'Price history', exact: true })
  await past.getByRole('button', { name: '5D', exact: true }).click()
  await past.getByRole('button', { name: 'Future', exact: true }).click()
  const card = page.getByRole('region', { name: 'Price forecast', exact: true })
  await expect(
    card
      .getByRole('group', { name: 'Forecast period' })
      .getByRole('button', { name: '5D', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await card.getByRole('button', { name: '6M', exact: true }).click()
  await expect(page).toHaveURL(/#\/research\/AAPL\?view=future$/)
  expect(generations).toHaveLength(0)
  const finished = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/api/desk/forecast/AAPL'),
  )
  await card.getByRole('button', { name: /Generate forecast|Update forecast/ }).click()
  const response = await finished
  expect(response.ok(), await response.text()).toBe(true)
  const { forecast } = await response.json()
  await expect(card).toContainText(forecast.summary)
  await expect(card.locator('path[data-line="actual"]')).toHaveAttribute('d', /^M.+L/)
  await expect(card.locator('path[data-line="median"]')).toHaveAttribute('d', /^M.+L/)
  await expect(card.locator('path[data-line="baseline"]')).toHaveAttribute('d', /^M.+L/)
  await expect(card.locator('path[data-line="upper"]')).toHaveCount(1)
  await expect(card.locator('path[data-line="lower"]')).toHaveCount(1)
  await expect(card.locator('.future-citations a').first()).toHaveAttribute('href', /^https:\/\//)
  const fiscal = card.getByRole('group', { name: 'Fiscal quarters' })
  for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
    await fiscal.getByRole('button', { name: q, exact: true }).click()
    await expect(fiscal.getByRole('button', { name: q, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  }
  const marker = card.locator('.forecast-marker').first()
  await marker.focus()
  const preview = card.getByRole('region', { name: 'Timeline event preview' })
  await expect(preview.getByRole('link').first()).toHaveAttribute('href', /^https:\/\//)
  await marker.press('Escape')
  await page.reload()
  await expect(card.getByRole('button', { name: 'Update forecast' })).toBeVisible()
  await expect(card).toContainText(forecast.summary)
  expect(generations).toHaveLength(1)
  await card.getByRole('button', { name: 'Past', exact: true }).click()
  await expect(past.getByRole('group', { name: 'Chart period' })).toBeVisible()
  await page.goBack()
  await expect(card.getByRole('button', { name: 'Update forecast' })).toBeVisible()
})

test('future horizons and custom future dates remain accessible in the main card on mobile', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await connect(request)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/research/MSFT?view=future')
  const card = page.getByRole('region', { name: 'Price forecast', exact: true }),
    choices = card.getByRole('group', { name: 'Forecast period' })
  for (const name of [
    '1D',
    '5D',
    '1W',
    '1M',
    '3M',
    '6M',
    'Year-end',
    '1Y',
    '2Y',
    '5Y',
    '10Y',
    'Max (10Y)',
  ]) {
    await choices.getByRole('button', { name, exact: true }).click()
    await expect(choices.getByRole('button', { name, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  }
  await choices.getByRole('button', { name: 'Custom' }).click()
  const start = new Date(),
    end = new Date()
  start.setUTCDate(start.getUTCDate() + 8)
  end.setUTCDate(end.getUTCDate() + 18)
  end.setUTCDate(end.getUTCDate() + ((6 - end.getUTCDay() + 7) % 7))
  const a = start.toISOString().slice(0, 10),
    b = end.toISOString().slice(0, 10)
  await page.route('**/api/desk/events?*', async (route) => {
    const params = new URL(route.request().url()).searchParams
    const event = {
      id: 'weekend-quarter',
      date: b,
      title: 'MSFT Q2 fiscal period end',
      kind: 'fiscal',
      status: 'estimated',
      symbols: ['MSFT'],
      source: 'Fiscal calendar publisher',
      url: 'https://example.org/test/fiscal-calendar',
      excerpt: 'The publisher identifies this fiscal period end.',
      relevance: 'Fiscal period boundary.',
      checked_at: b,
    }
    await route.fulfill({
      json: {
        start: params.get('start'),
        end: params.get('end'),
        checked_at: b,
        events: params.get('end') === b ? [event] : [],
        gaps: [],
      },
    })
  })
  await card.getByLabel('Forecast start date').fill(a)
  await card.getByLabel('Forecast end date').fill(b)
  await card.getByRole('button', { name: 'Apply dates' }).click()
  await expect(page).toHaveURL(new RegExp('range=custom&start=' + a + '&end=' + b + '$'))
  await card.getByRole('button', { name: /Generate forecast|Update forecast/ }).click()
  await expect(card.locator('path[data-line="baseline"]')).toBeVisible()
  const events = card.locator('details.future-events')
  await events.locator('summary').first().click()
  await events.getByLabel('Inspect a forecast event').selectOption('weekend-quarter')
  await expect(card.getByText('No trading session on this date')).toBeVisible()
  await expect(events.getByRole('link', { name: 'Fiscal calendar publisher' })).toHaveAttribute(
    'href',
    'https://example.org/test/fiscal-calendar',
  )
  await expect(card.locator('.forecast-marker').filter({ hasText: 'Q2' }).first()).toBeVisible()
  expect(await card.evaluate((c) => c.scrollWidth - c.clientWidth)).toBeLessThanOrEqual(1)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1)
  await page.reload()
  await expect(choices.getByRole('button', { name: 'Custom' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(card.getByRole('button', { name: 'Update forecast' })).toBeVisible()
})

test('homepage forecast comparisons wait for explicit generation and stay in the shared link', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await connect(request)
  const generated: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/desk/forecast/'))
      generated.push(new URL(r.url()).pathname)
  })
  await page.goto('/#/research/AMD?view=future&range=1mo')
  const card = page.getByRole('region', { name: 'Price forecast', exact: true })
  await card.getByRole('button', { name: 'Compare forecasts', exact: true }).click()
  await card.getByRole('textbox', { name: 'Comparison ticker' }).fill('TSLA')
  await card.getByRole('button', { name: 'Add ticker' }).click()
  const extra = card.getByRole('list', { name: 'Comparison forecasts' })
  await expect(extra).toContainText('No saved forecast for this period')
  expect(generated).toHaveLength(0)
  await card.getByRole('button', { name: 'Generate forecast', exact: true }).click()
  await expect(card.getByRole('heading', { name: 'AMD forecast outlook' })).toBeVisible()
  await extra.getByRole('button', { name: 'Generate TSLA forecast' }).click()
  await expect(card.getByRole('heading', { name: 'Projected returns' })).toBeVisible()
  await expect(card.locator('path[data-line="median"]')).toHaveCount(2)
  await expect(card.locator('path[data-line="baseline"]')).toHaveCount(2)
  expect(generated).toEqual(['/api/desk/forecast/AMD', '/api/desk/forecast/TSLA'])
  await page.reload()
  await expect(card.getByText('Return from the shared close on', { exact: false })).toBeVisible()
  expect(generated).toHaveLength(2)
  await extra.getByRole('button', { name: 'Remove TSLA from comparison' }).click()
  await expect(card.locator('path[data-line="median"]')).toHaveCount(1)
  await expect(card.getByRole('link', { name: 'Forecast calendar' })).toHaveAttribute(
    'href',
    /calendar\/AMD/,
  )
})

test('fiscal marker sources stay in view beside the selected date and below a narrow chart', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await connect(request)
  // Keep the real projection shape and cover a quarter with a long estimate and a separate fiscal calendar.
  const result = await request.post('/api/desk/forecast/AAPL?range=1mo')
  expect(result.ok(), await result.text()).toBe(true)
  const { forecast } = await result.json()
  const end = forecast.points.at(-1).date
  const fiscal = {
    id: 'calendar',
    source: 'Issuer calendar',
    kind: 'fiscal',
    date: end,
    date_basis: 'event',
    title: 'Q1 period end',
    url: 'https://example.org/test/issuer-calendar',
  }
  const evidence = {
    id: 'eps',
    source: 'Analyst estimates',
    kind: 'consensus',
    date: forecast.as_of,
    date_basis: 'retrieved',
    title: 'Published EPS consensus',
    url: 'https://example.org/test/earnings-estimates',
  }
  forecast.sources = [evidence, fiscal]
  forecast.quarters = [
    {
      quarter: 'Q1',
      date: end,
      period: 'Q1',
      date_kind: 'period_end',
      timing: 'estimated',
      expectation: 'Published analyst estimate for this fiscal period. '.repeat(25),
      source_ids: [evidence.id, fiscal.id],
      consensus: [
        { metric: 'EPS', value: 2.5, unit: 'USD per share', period: end, source_id: evidence.id },
      ],
    },
  ]
  forecast.drivers = []
  await page.route('**/api/desk/forecast/AAPL?*', (route) => route.fulfill({ json: { forecast } }))
  await page.route('**/api/desk/events?*', (route) =>
    route.fulfill({ json: { events: [], gaps: [] } }),
  )
  await page.goto('/#/research/AAPL?view=future&range=1mo')
  const card = page.getByRole('region', { name: 'Price forecast', exact: true })
  const marker = card.getByRole('button', { name: 'AAPL Q1 fiscal period end' })
  const preview = card.getByRole('region', { name: 'Timeline event preview' })
  const links = preview.getByRole('link')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 })
    await marker.click()
    await expect(preview).toHaveAttribute('data-position', width === 1440 ? 'left' : 'below')
    await expect(
      preview.getByRole('link', { name: 'Fiscal date · Issuer calendar' }),
    ).toHaveAttribute('href', fiscal.url)
    await expect(
      preview.getByRole('link', { name: 'Consensus · Analyst estimates' }),
    ).toHaveAttribute('href', evidence.url)
    await expect(links).toHaveCount(2)
    const box = (await preview.boundingBox())!,
      point = (await marker.boundingBox())!
    if (width === 1440) expect(box.x + box.width).toBeLessThan(point.x)
    else expect(box.y).toBeGreaterThan(point.y + point.height)
    await preview.scrollIntoViewIfNeeded()
    expect(await preview.evaluate((p) => p.scrollHeight - p.clientHeight)).toBeLessThanOrEqual(1)
    // A link can be 'visible' to Playwright while clipped by an overflow container.
    // Hit-test both centers before scrolling inside the preview.
    for (const link of await links.all()) {
      expect(
        await link.evaluate((a) => {
          const b = a.getBoundingClientRect()
          return a.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2))
        }),
      ).toBe(true)
    }
    await expect(preview).not.toContainText('Why it matters')
    await marker.press('Escape')
  }
})
