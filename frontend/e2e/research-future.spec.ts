import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

async function connect(request: APIRequestContext) {
  expect(
    (
      await request.put('/api/openai', { data: { key: 'intercepted-browser-test-credential' } })
    ).ok(),
  ).toBe(true)
  expect((await request.patch('/api/ai', { data: { provider: 'openai' } })).ok()).toBe(true)
}

async function keyless(page: Page) {
  await page.route('**/api/ai', (route) =>
    route.fulfill({ json: { provider: 'openai', configured: false, model: null } }),
  )
}

test('the homepage automatically applies the active AI prediction and retains its cited outlook', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await connect(request)
  const generations: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/desk/forecast/')) generations.push(r.url())
  })
  await page.goto('/#/research/AAPL/range_6mo')
  const past = page.getByRole('region', { name: 'Price history', exact: true })
  const finished = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/api/desk/forecast/AAPL'),
  )
  await past.getByRole('button', { name: 'Future', exact: true }).click()
  const card = page.getByRole('region', { name: 'Price forecast', exact: true })
  await expect(page).toHaveURL(/#\/research\/AAPL\?view=future$/)
  const response = await finished
  expect(response.ok(), await response.text()).toBe(true)
  const { forecast } = await response.json()
  await expect(card).toContainText(forecast.summary)
  await expect(
    card.locator('[data-forecast-model="ai"] path[data-line="prediction"]'),
  ).toHaveAttribute('d', /^M.+L/)
  await expect(card.locator('.forecast-plot svg path')).toHaveCount(1)
  await expect(card.locator('[data-forecast-end]')).toHaveAttribute(
    'data-price',
    String(forecast.points.at(-1).prediction),
  )
  await expect(card.getByText(/median|percentile|show past prices/i)).toHaveCount(0)
  const method = card
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'How the prediction was calculated' }) })
  await method.locator('summary').click()
  await expect(method).toContainText('Buy score · ' + forecast.scores.buy_score + '/100')
  await expect(method).toContainText('Risk score · ' + forecast.scores.risk_score + '/100')
  await expect(method).toContainText(forecast.scores.buy_reason)
  await expect(method).toContainText(forecast.scores.risk_reason)
  for (const id of [...forecast.scores.buy_source_ids, ...forecast.scores.risk_source_ids]) {
    const source = forecast.sources.find((s: { id: string }) => s.id === id)
    await expect(
      method
        .locator('a')
        .filter({ hasText: source.title || source.source })
        .first(),
    ).toHaveAttribute('href', source.url)
  }
  await method.locator('summary').click()
  expect(generations).toHaveLength(1)
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
  await expect(card.getByRole('button', { name: 'Update AI forecast' })).toBeVisible()
  await expect(card).toContainText(forecast.summary)
  await card.getByRole('button', { name: 'Past', exact: true }).click()
  await expect(past.getByRole('group', { name: 'Chart period' })).toBeVisible()
  await page.goBack()
  await expect(card.getByRole('button', { name: 'Update AI forecast' })).toBeVisible()
})

test('future horizons and custom future dates remain accessible in the main card on mobile', async ({
  page,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await keyless(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/research/MSFT?view=future')
  const card = page.getByRole('region', { name: 'Price forecast', exact: true }),
    choices = card.getByRole('group', { name: 'Forecast period' })
  const autoRequests: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/desk/forecast/')) autoRequests.push(r.url())
  })
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
    const code =
      name === 'Year-end'
        ? 'ytd'
        : name === 'Max (10Y)'
          ? 'max'
          : name.toLowerCase().replace(/m$/, 'mo')
    const arriving = page.waitForResponse(
      (r) =>
        r.url().includes('/api/desk/projections?') &&
        new URL(r.url()).searchParams.get('horizon') === code,
    )
    await choices.getByRole('button', { name, exact: true }).click()
    await expect(choices.getByRole('button', { name, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const packet = await (await arriving).json()
    const baseline = packet.series[0]
    expect(baseline, JSON.stringify(packet.errors)).toBeTruthy()
    expect(baseline.points.at(-1).date > baseline.as_of).toBe(true)
    await expect(
      card.locator('[data-forecast-model="statistical"] [data-forecast-end]'),
    ).toHaveAttribute('data-forecast-end', baseline.points.at(-1).date)
    await expect(card.locator('path[data-line="prediction"]')).toHaveAttribute('d', /^M.+L/)
    await expect(card.getByLabel('Projection values')).toContainText('Predicted for')
  }
  expect(autoRequests).toHaveLength(0)
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
  let customRequests = 0
  let allowCustom!: () => void
  const gate = new Promise<void>((resolve) => {
    allowCustom = resolve
  })
  const customRequest = (url: string) => {
    const { pathname, searchParams } = new URL(url)
    return (
      pathname === '/api/desk/projections' &&
      searchParams.get('symbols') === 'MSFT' &&
      searchParams.get('horizon') === 'custom' &&
      searchParams.get('start') === a &&
      searchParams.get('end') === b
    )
  }
  await page.route('**/api/desk/projections?*', async (route) => {
    if (customRequest(route.request().url())) {
      customRequests++
      await gate
    }
    await route.continue()
  })
  const arriving = page.waitForResponse(
    (r) => r.request().method() === 'GET' && customRequest(r.url()),
  )
  await card.getByRole('button', { name: 'Apply dates' }).click()
  await expect(page).toHaveURL(new RegExp('range=custom&start=' + a + '&end=' + b + '$'))
  const endpoint = card.locator('[data-forecast-model="statistical"] [data-forecast-end]')
  try {
    await expect(choices.getByRole('button', { name: 'Custom' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(endpoint).toHaveCount(0)
  } finally {
    allowCustom()
  }
  const response = await arriving
  expect(response.ok(), await response.text()).toBe(true)
  const packet = await response.json()
  const projected = packet.series.find((s: { symbol: string }) => s.symbol === 'MSFT')
  expect(projected, JSON.stringify(packet.errors)).toBeTruthy()
  expect([projected.requested_start, projected.requested_end]).toEqual([a, b])
  const projectedEnd = projected.points.at(-1).date
  expect(projectedEnd >= a && projectedEnd <= b).toBe(true)
  await expect(endpoint).toHaveAttribute('data-forecast-end', projectedEnd)
  expect(customRequests).toBe(1)
  await expect(card.locator('.forecast-plot svg path')).toHaveCount(1)
  await expect(card.locator('.forecast-marker').filter({ hasText: 'Q2' })).toBeVisible()
  expect(autoRequests).toHaveLength(0)
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
  await expect(endpoint).toHaveAttribute('data-forecast-end', projectedEnd)
})

test('homepage forecast comparisons use one path per ticker and stay in the shared link', async ({
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
  const comparisonUrl = page.url()
  await card.getByRole('button', { name: '5D', exact: true }).click()
  await expect(page).toHaveURL(/range=5d&compare=TSLA$/)
  await expect(card.locator('.forecast-plot svg path')).toHaveCount(2)
  await page.goBack()
  await expect(page).toHaveURL(comparisonUrl)
  await expect(card.getByRole('button', { name: '1M', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(card.locator('.forecast-plot svg path')).toHaveCount(2)
  expect(generated.filter((p) => p.endsWith('/TSLA'))).toHaveLength(0)
  await expect(card.getByRole('heading', { name: 'AMD forecast outlook' })).toBeVisible()
  await extra.getByRole('button', { name: 'Generate TSLA forecast' }).click()
  await expect(card.getByRole('heading', { name: 'Projected returns' })).toBeVisible()
  await expect(card.locator('path[data-line="prediction"]')).toHaveCount(2)
  await expect(card.locator('[data-forecast-model="ai"] path')).toHaveCount(2)
  expect(generated.filter((p) => p.endsWith('/TSLA'))).toHaveLength(1)
  await page.reload()
  await expect(card.getByText('Return from the shared close on', { exact: false })).toBeVisible()
  expect(generated.filter((p) => p.endsWith('/TSLA'))).toHaveLength(1)
  await extra.getByRole('button', { name: 'Remove TSLA from comparison' }).click()
  await expect(card.locator('path[data-line="prediction"]')).toHaveCount(1)
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

test('rapid horizon changes discard late prices and a failed AI request preserves the statistical projection', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await connect(request)
  const response = await request.get('/api/desk/projections?symbols=TSLA&horizon=1d')
  const daily = await response.json()
  expect(daily.series.length, JSON.stringify(daily.errors)).toBe(1)
  await page.route('**/api/desk/forecast/TSLA?*', async (route) => {
    if (route.request().method() === 'POST')
      return route.fulfill({
        status: 502,
        json: { detail: 'The selected AI provider is unavailable.' },
      })
    return route.fulfill({ json: { forecast: null } })
  })
  let release!: () => void
  const pending = new Promise<void>((r) => {
    release = r
  })
  await page.route('**/api/desk/projections?*', async (route) => {
    const range = new URL(route.request().url()).searchParams.get('horizon')
    if (range !== '1d') return route.continue()
    await pending
    await route.fulfill({ json: daily }).catch(() => {})
  })
  await page.goto('/#/research/TSLA?view=future&range=1mo')
  const card = page.getByRole('region', { name: 'Price forecast', exact: true })
  const choice = card.getByRole('group', { name: 'Forecast period' })
  const monthly = card.locator('[data-forecast-end]')
  await expect(monthly).toBeVisible()
  const monthEnd = await monthly.getAttribute('data-forecast-end')
  const slow = page.waitForRequest(
    (r) =>
      r.url().includes('/desk/projections?') &&
      new URL(r.url()).searchParams.get('horizon') === '1d',
  )
  await choice.getByRole('button', { name: '1D', exact: true }).click()
  await slow
  await expect(card.locator('path[data-line="prediction"]')).toHaveCount(0)
  await expect(card.getByRole('status').filter({ hasText: 'Calculating the 1D' })).toBeVisible()
  await choice.getByRole('button', { name: '1M', exact: true }).click()
  await expect(monthly).toHaveAttribute('data-forecast-end', monthEnd!)
  release()
  await card.getByRole('button', { name: 'Generate AI forecast', exact: true }).click()
  await expect(card).toContainText('The selected AI provider is unavailable.')
  await expect(monthly).toHaveAttribute('data-forecast-end', monthEnd!)
  await expect(card.locator('[data-forecast-model="statistical"] path')).toHaveCount(1)
})

test('a failed projection can be retried and an expired AI snapshot stays separate from the forward path', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await keyless(page)
  const daily = await (await request.get('/api/desk/projections?symbols=MSFT&horizon=1d')).json()
  const current = daily.series[0]
  expect(current, JSON.stringify(daily.errors)).toBeTruthy()
  current.stale = true
  current.data_note = 'Using the last independently verified price observation.'
  current.price_sources = [
    { source: 'Daily price publisher', url: 'https://example.org/test/daily-prices' },
    { source: 'Closing price publisher', url: 'https://example.org/test/completed-close' },
  ]
  const before = current.history.at(-3),
    through = current.history.at(-2)
  const older = {
    ...current,
    id: 'archived-forecast',
    created: before.date + 'T22:00:00Z',
    model: 'test model',
    provider: 'openai',
    range: '1d',
    requested_end: through.date,
    as_of: before.date,
    history: current.history.slice(0, -2),
    points: [before, through].map((p) => ({
      date: p.date,
      low: p.price,
      median: p.price,
      high: p.price,
    })),
    summary: 'This saved thesis used the previous price observations.',
    summary_source_ids: [],
    drivers: [],
    quarters: [],
    sources: [],
  }
  await page.route('**/api/desk/forecast/MSFT?*', (r) => r.fulfill({ json: { forecast: older } }))
  await page.route('**/api/desk/projections?*', (r) =>
    r.fulfill({
      json: new URL(r.request().url()).searchParams.has('refresh')
        ? daily
        : {
            ...daily,
            series: [],
            errors: [{ symbol: 'MSFT', error: 'The source returned no usable prices.' }],
          },
    }),
  )
  await page.goto('/#/research/MSFT?view=future&range=1d')
  const card = page.getByRole('region', { name: 'Price forecast', exact: true })
  await expect(card).toContainText('The source returned no usable prices.')
  await expect(card.locator('path[data-line="prediction"]')).toHaveCount(0)
  await card.getByRole('button', { name: 'Retry price projection' }).click()
  await expect(
    card.locator('[data-forecast-model="statistical"] [data-forecast-end]'),
  ).toHaveAttribute('data-forecast-end', current.points.at(-1).date)
  await expect(card).toContainText(current.data_note)
  for (const s of current.price_sources)
    await expect(card.getByRole('link', { name: s.source })).toHaveAttribute('href', s.url)
  await expect(card.locator('[data-forecast-model="ai"]')).toHaveCount(0)
  await card.locator('summary').filter({ hasText: 'Saved AI forecast' }).click()
  const archive = card.locator('.future-archive')
  await expect(archive).toContainText(older.summary)
  await expect(archive.locator('.forecast-plot svg path')).toHaveCount(1)
  await expect(archive.locator('[data-forecast-end]')).toHaveAttribute(
    'data-price',
    String(through.price),
  )
  await expect(archive.getByText(/median|percentile|show past prices/i)).toHaveCount(0)
  await expect(archive.locator('[data-forecast-end]')).toHaveAttribute(
    'data-forecast-end',
    through.date,
  )
})

test('one-session forecasts fill the plot between the observed anchor and the estimated ending price', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  const packet = await (await request.get('/api/desk/projections?symbols=SNDK&horizon=1d')).json()
  const s = packet.series[0]
  expect(s, JSON.stringify(packet.errors)).toBeTruthy()
  await keyless(page)
  const anchor = 100
  s.history[0].price = anchor * 4
  const endDate = s.points.at(-1).date
  s.points = [
    { ...s.points[0], prediction: anchor, median: anchor },
    { date: endDate, prediction: 103, median: 99, low: 1, high: 900, baseline: 180 },
  ]
  await page.route('**/api/desk/projections?*', (r) => r.fulfill({ json: packet }))
  await page.route('**/api/desk/forecast/SNDK?*', (r) => r.fulfill({ json: { forecast: null } }))
  await page.goto('/#/research/SNDK?view=future&range=1d')
  const card = page.getByRole('region', { name: 'Price forecast', exact: true })
  const plot = card.locator('.forecast-plot')
  await expect(plot.locator('[data-forecast-end]')).toHaveAttribute('data-forecast-end', endDate)
  await expect(plot.locator('[data-observed-anchor]')).toHaveAttribute(
    'data-observed-anchor',
    s.as_of,
  )
  await expect(plot.locator('svg path')).toHaveCount(1)
  await expect(card.getByLabel('Predicted price', { exact: true })).toHaveText('$103.00')
  await expect(card.locator('.period-change')).toContainText('+3.00%')
  await expect(card.locator('.future-inspected')).toContainText('Predicted $103.00 · +3.00%')
  const geometry = await plot.evaluate((el) => {
    const svg = el.querySelector('svg')!
    const path = el.querySelector<SVGPathElement>('path[data-line="prediction"]')!
    const first = path.getPointAtLength(0),
      last = path.getPointAtLength(path.getTotalLength())
    return {
      width: (last.x - first.x) / svg.viewBox.baseVal.width,
      height: (first.y - last.y) / svg.viewBox.baseVal.height,
      lowest: Math.min(
        ...Array.from(el.querySelectorAll('[data-axis-value]'), (v) =>
          Number(v.getAttribute('data-axis-value')),
        ),
      ),
    }
  })
  expect(geometry.width).toBeGreaterThan(0.65)
  expect(geometry.height).toBeGreaterThan(0.4)
  expect(geometry.lowest).toBeGreaterThan(98)
  await expect(card.getByText(/median|percentile|show past prices/i)).toHaveCount(0)
})

for (const width of [390, 1440]) {
  test(
    'Compare forecasts stays under the pointer when prices arrive at ' + width + 'px',
    async ({ page, request }) => {
      test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
      await connect(request)
      let releaseProjection!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseProjection = resolve
      })
      const initialProjection = (url: string) => {
        const { pathname, searchParams } = new URL(url)
        return (
          pathname === '/api/desk/projections' &&
          searchParams.get('symbols') === 'AMD' &&
          searchParams.get('horizon') === '1mo'
        )
      }
      await page.route('**/api/desk/projections?*', async (route) => {
        if (initialProjection(route.request().url())) await gate
        await route.continue()
      })
      await page.setViewportSize({ width, height: 960 })
      await page.goto('/#/research/AMD?view=future&range=1mo')
      const card = page.getByRole('region', { name: 'Price forecast', exact: true })
      const compare = card.getByRole('button', { name: 'Compare forecasts', exact: true })
      await compare.scrollIntoViewIfNeeded()
      const before = (await compare.boundingBox())!
      const x = before.x + before.width / 2,
        y = before.y + before.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      try {
        releaseProjection()
        await expect(card.locator('[data-forecast-end]')).toBeVisible()
        // A pointer release must still land on the same control after the quote arrives.
        const after = (await compare.boundingBox())!
        expect(y, 'Compare forecasts moved below the held pointer').toBeGreaterThanOrEqual(after.y)
        expect(y, 'Compare forecasts moved above the held pointer').toBeLessThanOrEqual(
          after.y + after.height,
        )
        expect(x).toBeGreaterThanOrEqual(after.x)
        expect(x).toBeLessThanOrEqual(after.x + after.width)
      } finally {
        await page.mouse.up()
      }
      await expect(compare).toHaveAttribute('aria-expanded', 'true')
      await expect(card.getByRole('textbox', { name: 'Comparison ticker' })).toBeVisible()
    },
  )
}

test('a last-price reference identifies the price-model fallback without claiming historical accuracy', async ({
  page,
  request,
}) => {
  await keyless(page)
  const packet = await (await request.get('/api/desk/projections?symbols=SNDK&horizon=1d')).json()
  const s = packet.series[0],
    anchor = s.points[0].prediction
  const reason = 'The published series has too few completed sessions for a fitted prediction.'
  s.model_inputs = { kind: 'last_price_reference', reference_reason: reason }
  s.points = s.points.map((p: { date: string }) => ({ ...p, prediction: anchor }))
  await page.route('**/api/desk/projections?*', (r) => r.fulfill({ json: packet }))
  await page.goto('/#/research/SNDK?view=future&range=1d')
  const card = page.getByRole('region', { name: 'Price forecast', exact: true })
  await expect(card.getByText('1D · Last-price reference', { exact: true })).toBeVisible()
  await expect(card.getByText(reason, { exact: false }).first()).toBeVisible()
  await expect(card.locator('.period-change')).toContainText('0.00%')
  await expect(card.locator('.forecast-plot svg path')).toHaveCount(1)
  await card.getByText('Why the last price is used', { exact: true }).click()
  await expect(card.getByText(/average next-session prediction error/)).toHaveCount(0)
  await card.getByRole('button', { name: 'Generate now', exact: true }).click()
  await expect(page).toHaveURL(/#\/settings(?:[/?]|$)/)
})

test('scored IPO research keeps a last-price reference in read-only Research and Calendar', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  const packet = await (await request.get('/api/desk/projections?symbols=SNDK&horizon=1d')).json()
  const series = packet.series[0]
  expect(series, JSON.stringify(packet.errors)).toBeTruthy()
  const price = series.points[0].prediction
  const reason = 'Only a few verified sessions are available after listing.'
  series.method = 'Last-price reference'
  series.model_inputs = { kind: 'last_price_reference', reference_reason: reason }
  series.points = series.points.map((p: { date: string }) => ({
    ...p,
    prediction: price,
    median: price,
  }))
  const model = 'browser-fixture-model',
    provider = 'openai',
    created = series.as_of + 'T22:01:00Z'
  const evidence = {
    id: 'filing',
    source: 'Issuer',
    title: 'Quarterly issuer filing',
    url: 'https://www.sec.gov/edgar/search/',
    kind: 'company_filings',
    date: series.as_of,
  }
  const snapshot = {
    ...series,
    id: 'ipo-reference',
    model,
    provider,
    created,
    range: '1d',
    summary: 'The latest observed close is the reference price.',
    summary_source_ids: ['filing'],
    drivers: [],
    quarters: [],
    sources: [evidence],
    scores: {
      buy_score: 91,
      buy_status: 'unresolved',
      risk_score: 73,
      origin: 'forecast_model',
      as_of: series.as_of,
      created,
      provider,
      model,
      buy_reason: 'The available filing does not resolve the buy judgment.',
      risk_reason: 'Limited operating history increases uncertainty.',
      buy_source_ids: ['filing'],
      risk_source_ids: ['filing'],
    },
  }
  await page.addInitScript(() =>
    history.replaceState({ ...history.state, stockreplayReadOnlyForecast: true }, ''),
  )
  await page.route('**/api/ai', (r) =>
    r.fulfill({ json: { provider, model, configured: true, verified: true } }),
  )
  await page.route('**/api/desk/projections?*', (r) => r.fulfill({ json: packet }))
  const writes: string[] = []
  await page.route('**/api/desk/forecast/SNDK?*', (r) => {
    if (r.request().method() === 'POST') writes.push(r.request().url())
    return r.fulfill({ json: { forecast: snapshot } })
  })
  await page.goto('/#/research/SNDK?view=future&range=1d')
  const card = page.getByRole('region', { name: 'Price forecast', exact: true })
  await expect(card.getByRole('heading', { name: 'SNDK research outlook' })).toBeVisible()
  await expect(card.getByText('1D · Last-price reference', { exact: true })).toBeVisible()
  await expect(card.getByLabel('Reference price', { exact: true })).toBeVisible()
  await expect(card.locator('.period-change')).toContainText('0.00%Reference change')
  await expect(card.getByText(reason, { exact: true })).toBeVisible()
  await expect(card.getByText(/AI research generated/)).toContainText('OpenAI · ' + model)
  for (const view of ['Research', 'Calendar']) {
    if (view === 'Calendar') {
      await card.getByRole('link', { name: 'Forecast calendar', exact: true }).click()
      const table = page.getByRole('table', { name: 'Prices on inspected date' })
      await expect(table.getByRole('columnheader', { name: 'Reference price' })).toBeVisible()
      await expect(table.getByRole('columnheader', { name: 'Reference change' })).toBeVisible()
      await expect(table.getByRole('cell', { name: '0.00%', exact: true })).toBeVisible()
    }
    await expect(
      page.getByRole('img', { name: 'SNDK last-price reference by trading session' }),
    ).toBeVisible()
    await expect(
      page.locator('[data-symbol="SNDK"][data-forecast-model="reference"] path'),
    ).toHaveCount(1)
    await expect(page.locator('[data-forecast-model="ai"]')).toHaveCount(0)
    const detail = page
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: 'Why the last price is used' }) })
    await detail.locator('summary').click()
    await expect(detail.getByRole('heading', { name: 'Buy score · Unresolved' })).toBeVisible()
    await expect(detail.getByRole('heading', { name: 'Risk score · 73/100' })).toBeVisible()
    await expect(detail.getByRole('link', { name: evidence.title }).first()).toHaveAttribute(
      'href',
      evidence.url,
    )
    await expect(detail.getByText(/average next-session prediction error/)).toHaveCount(0)
  }
  expect(writes).toEqual([])
})
