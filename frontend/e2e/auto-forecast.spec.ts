import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const card = (page: Page) => page.getByRole('region', { name: 'Price forecast', exact: true })
const period = (page: Page, label: string) =>
  card(page)
    .getByRole('group', { name: 'Forecast period' })
    .getByRole('button', { name: label, exact: true })
const automatic = (url: string) => new URL(url).searchParams.get('auto') === 'true'
const path = (url: string) => new URL(url).pathname

async function connect(request: APIRequestContext, model = 'gpt-4.1-mini') {
  const reply = await request.put('/api/openai', {
    data: { key: 'intercepted-browser-test-credential', model },
  })
  expect(reply.ok(), await reply.text()).toBe(true)
  expect((await request.patch('/api/ai', { data: { provider: 'openai' } })).ok()).toBe(true)
}

async function lookup(page: Page, ticker: string) {
  const search = page.getByRole('textbox', { name: 'Search stocks' })
  await search.fill(ticker)
  await search.press('Enter')
}

test('committing a lookup and a stable period generates once and reopens the same saved prediction', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await connect(request)
  const calls: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && path(r.url()).startsWith('/api/desk/forecast/'))
      calls.push(r.url())
  })
  await page.goto('/#/settings')
  const results: string[] = []
  page.on('response', async (r) => {
    if (r.request().method() === 'POST' && path(r.url()) === '/api/desk/forecast/AMD' && r.ok()) {
      results.push((await r.json()).forecast.id)
    }
  })
  await lookup(page, 'AMD')
  await expect(page).toHaveURL(/research\/AMD\?view=future$/)
  await expect(
    card(page).locator(
      '[data-symbol="AMD"][data-forecast-model="ai"] path[data-line="prediction"]',
    ),
  ).toBeVisible()
  await expect.poll(() => results.length).toBe(1)
  expect(calls.every(automatic)).toBe(true)
  // Exercise a real burst of button clicks. WebKit's automation waits for pointer
  // stability between locator.click() calls, sometimes longer than the app's debounce.
  await page.evaluate(async () => {
    for (const label of ['5D', '1Y', '1M']) {
      const buttons = document.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Forecast period"] button',
      )
      const choice = [...buttons].find((button) => button.textContent === label)
      if (!choice) throw Error('Missing forecast period ' + label)
      choice.click()
      await new Promise<void>((done) => setTimeout(done, 0))
    }
  })
  await expect.poll(() => results.length).toBe(2)
  expect(calls.map((s) => new URL(s).searchParams.get('range'))).toEqual(['6mo', '1mo'])
  const selected = page.url()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.goBack()
  await expect(page).toHaveURL(selected)
  await expect(card(page).locator('[data-forecast-model="ai"]')).toBeVisible()
  await page.reload()
  await expect(card(page).locator('[data-forecast-model="ai"]')).toBeVisible()
  await expect.poll(() => results.length).toBe(3)
  expect(results[2]).toBe(results[1])
  expect(calls.filter((s) => !automatic(s))).toEqual([])
  await lookup(page, 'QCOM')
  await expect(page).toHaveURL(/research\/QCOM\?view=future&range=1mo$/)
  await card(page).getByRole('button', { name: 'Past', exact: true }).click()
  const history = page.getByRole('region', { name: 'Price history', exact: true })
  await history.getByRole('button', { name: '1W', exact: true }).click()
  await expect(history).toBeVisible()
  await lookup(page, 'CAT')
  await expect(page).toHaveURL(/research\/CAT\?view=future&range=1w$/)
  await expect(card(page).locator('[data-symbol="CAT"][data-forecast-model="ai"]')).toBeVisible()
  expect(calls.filter((s) => path(s).endsWith('/CAT') && automatic(s))).toHaveLength(1)
  await page.goto('/#/research/CAT/range_custom_2024-02-01_2024-03-01')
  await expect(history).toBeVisible()
  await lookup(page, 'AMD')
  await expect(page).toHaveURL(/research\/AMD\?view=future$/)
})

test('a failed hosted prediction keeps the price model, backs off, and supports a manual retry', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await connect(request)
  let automaticCalls = 0,
    manual = 0
  await page.route('**/api/desk/forecast/INTC?*', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.continue()
    if (automatic(req.url())) {
      automaticCalls++
      return route.fulfill({
        status: 429,
        json: { detail: 'Provider usage limit: insufficient quota.' },
      })
    }
    manual++
    return route.continue()
  })
  await page.goto('/#/research/INTC?view=future&range=3mo')
  const status = card(page).getByText('The AI provider reported a usage limit.', { exact: false })
  await expect(status).toBeVisible()
  await expect(
    card(page).locator(
      '[data-symbol="INTC"][data-forecast-model="statistical"] path[data-line="prediction"]',
    ),
  ).toBeVisible()
  await expect(card(page).getByRole('button', { name: 'AI settings' })).toBeVisible()
  await page.reload()
  await expect(status).toBeVisible()
  expect(automaticCalls).toBe(1)
  await card(page)
    .getByRole('button', { name: /Generate now|Generate AI forecast|Update AI forecast/ })
    .click()
  await expect(card(page).locator('[data-symbol="INTC"][data-forecast-model="ai"]')).toBeVisible()
  await expect(status).toHaveCount(0)
  expect(manual).toBe(1)
})

test('only a generation-ready hosted credential or installed local model can automatically use the portfolio ticker', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await request.patch('/api/preferences', { data: { home_mode: 'portfolio' } })
  const saved = await (await request.get('/api/home')).json()
  let resume!: () => void
  const held = new Promise<void>((done) => {
    resume = done
  })
  await page.route('**/api/home', async (route) => {
    await held
    return route.fulfill({ json: { ...saved, portfolio_symbol: 'MSFT' } })
  })
  let connection = {
    provider: 'ollama_cloud',
    configured: true,
    verified: false,
    generation_ready: false,
    revision: 123,
    model: 'hosted-model',
    verified_at: null,
    storage: 'macOS Keychain',
    generation_detail: 'Hosted generation unavailable.',
  }
  await page.route('**/api/ai', (route) => route.fulfill({ json: connection }))
  const calls: string[] = []
  await page.route('**/api/desk/forecast/*?*', (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    calls.push(route.request().url())
    return route.fulfill({ status: 503, json: { detail: 'Test provider is offline.' } })
  })
  await page.goto('/')
  try {
    await expect(
      page.getByRole('status', { name: '' }).filter({ hasText: 'Opening your workspace' }),
    ).toBeVisible()
    expect(calls).toHaveLength(0)
  } finally {
    resume()
  }
  await expect(
    card(page).locator('[data-symbol="MSFT"] path[data-line="prediction"]'),
  ).toBeVisible()
  await period(page, '1W').click()
  await expect(card(page).locator('[data-symbol="MSFT"]')).toBeVisible()
  // Let a mistakenly scheduled generation debounce expire before checking the network.
  await page.waitForTimeout(900)
  expect(calls).toHaveLength(0)
  connection = { ...connection, generation_detail: '', revision: 122 }
  await page.reload()
  await expect(card(page).locator('[data-symbol="MSFT"]')).toBeVisible()
  await page.waitForTimeout(900)
  expect(calls).toHaveLength(0)
  connection = {
    ...connection,
    provider: 'ollama',
    model: 'installed-model',
    generation_detail: '',
    revision: 124,
  }
  await page.reload()
  await expect.poll(() => calls.length).toBe(1)
  expect(
    calls.every(
      (s) =>
        path(s) === '/api/desk/forecast/MSFT' &&
        automatic(s) &&
        new URL(s).searchParams.get('revision') === '124',
    ),
  ).toBe(true)
  connection = {
    ...connection,
    provider: 'openai',
    model: 'hosted-model',
    generation_ready: true,
    revision: 125,
  }
  await page.reload()
  await expect.poll(() => calls.length).toBe(2)
  expect(new URL(calls[1]).searchParams.get('revision')).toBe('125')
})

test('a replacement provider model gets its own prediction when an old reply is still in flight', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await connect(request)
  let release!: () => void
  const held = new Promise<void>((done) => {
    release = done
  })
  const received: { model: string; revision: string | null }[] = []
  let holdFirst = true
  await page.route('**/api/desk/forecast/IBM?*', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.continue()
    const hold = holdFirst
    holdFirst = false
    const response = await route.fetch()
    const body = await response.json()
    expect(response.ok(), body.detail).toBe(true)
    received.push({
      model: body.forecast.model,
      revision: new URL(req.url()).searchParams.get('revision'),
    })
    if (hold) await held
    return route.fulfill({ response, json: body })
  })
  await page.goto('/#/research/IBM')
  try {
    await expect.poll(() => received.length).toBe(1)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByLabel('API model').selectOption('gpt-4.1')
    const tested = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && path(r.url()) === '/api/openai',
    )
    await page.getByRole('button', { name: 'Connect & test' }).click()
    expect((await tested).ok()).toBe(true)
    await lookup(page, 'IBM')
    await expect.poll(() => received.length).toBe(2)
    expect(received.map((r) => r.model)).toEqual(['gpt-4.1-mini', 'gpt-4.1'])
    expect(received[0].revision).not.toBe(received[1].revision)
    await expect(card(page).locator('[data-forecast-model="ai"]')).toBeVisible()
  } finally {
    release()
  }
  await expect(card(page).locator('.future-saved')).toContainText('gpt-4.1')
  await expect(card(page).locator('.future-saved')).not.toContainText('gpt-4.1-mini')
})

test('while a slow generation runs, only the final stable period enters the provider queue', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await connect(request)
  let finish!: () => void
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  const requested: string[] = []
  await page.route('**/api/desk/forecast/CRM?*', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.continue()
    requested.push(new URL(req.url()).searchParams.get('range')!)
    if (requested.length === 1) await held
    return route.fulfill({ status: 503, json: { detail: 'Example data unavailable.' } })
  })
  await page.goto('/#/research/CRM')
  try {
    await expect.poll(() => requested.length).toBe(1)
    for (const label of ['5D', '1W', '1M']) {
      await period(page, label).click()
      await expect(
        card(page).locator('[data-symbol="CRM"] path[data-line="prediction"]'),
      ).toBeVisible()
      await page.waitForTimeout(900)
    }
    expect(requested).toEqual(['6mo'])
  } finally {
    finish()
  }
  await expect.poll(() => requested).toEqual(['6mo', '1mo'])
})
