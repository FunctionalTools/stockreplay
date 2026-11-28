import { expect, test, type Locator } from '@playwright/test'

const question = 'wheres the tab where i can see future stock prediction'
const oldReply = 'Open the Forecast calendar for upcoming prediction-related events.'

async function measure(panel: Locator) {
  return panel.getByRole('log').evaluate((log) => {
    const bubbles = [...log.querySelectorAll<HTMLElement>('article')]
    const failures: string[] = []
    const scrollport = log.getBoundingClientRect()
    const pane = log.closest('section')!.getBoundingClientRect()
    let lastBottom = -Infinity
    let fragments = 0
    for (const bubble of bubbles) {
      const box = bubble.getBoundingClientRect()
      if (box.top < lastBottom + 3) failures.push('Overlapping adjacent message boxes')
      if (box.left < scrollport.left || box.right > scrollport.right)
        failures.push('Message outside transcript')
      lastBottom = box.bottom
      const texts = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT)
      while (texts.nextNode()) {
        const node = texts.currentNode
        if (!node.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        let previousLine: DOMRect | undefined
        for (const r of range.getClientRects()) {
          if (!r.width || !r.height) continue
          fragments++
          if (previousLine && r.top > previousLine.top + 1 && r.top < previousLine.bottom - 1)
            failures.push('Overlapping wrapped lines: ' + node.textContent)
          previousLine = r
          if (
            r.left < box.left - 1 ||
            r.right > box.right + 1 ||
            r.top < box.top - 1 ||
            r.bottom > box.bottom + 1
          )
            failures.push('Text outside its own message: ' + node.textContent)
          if (r.left < pane.left || r.right > pane.right)
            failures.push('Text outside panel: ' + node.textContent)
          const x = (r.left + r.right) / 2,
            y = (r.top + r.bottom) / 2
          if (
            y > scrollport.top + 1 &&
            y < scrollport.bottom - 1 &&
            !bubble.contains(document.elementFromPoint(x, y))
          )
            failures.push('Text obscured by another element: ' + node.textContent)
        }
      }
    }
    return { fragments, failures }
  })
}
async function assertMessagesFit(panel: Locator) {
  const log = panel.getByRole('log')
  for (const at of ['top', 'bottom']) {
    await log.evaluate(async (el, at) => {
      el.scrollTop = at === 'top' ? 0 : el.scrollHeight
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }, at)
    const { fragments, failures } = await measure(panel)
    expect(failures).toEqual([])
    expect(fragments).toBeGreaterThan(6)
  }
}

test.use({ deviceScaleFactor: 2 })
test('the reported Future question wraps within separate messages and opens its saved homepage link', async ({
  page,
  request,
}) => {
  const oldMode = (await (await request.get('/api/preferences')).json()).appearance
  const seeded = await request.post('/api/assistant/chats', {
    data: {
      title: question,
      entries: [
        { id: 1, role: 'assistant', text: 'Hello.' },
        { id: 2, role: 'assistant', text: 'How can I help?' },
        { id: 3, role: 'user', text: question },
        { id: 4, role: 'assistant', text: oldReply },
      ],
      context: [],
    },
  })
  expect(seeded.ok()).toBe(true)
  const { id } = await seeded.json()
  try {
    await request.patch('/api/preferences', { data: { appearance: 'dark' } })
    await page.addInitScript((id) => sessionStorage.setItem('stockreplay.selected-chat.v1', id), id)
    await page.goto('/#/research/NVDA')
    const open = page.getByRole('button', { name: 'Open assistant' })
    await open.click()
    const panel = page.getByRole('region', { name: 'StockReplay assistant' })
    const field = panel.getByLabel('Message the assistant')
    await expect(panel.getByText(oldReply, { exact: true })).toBeVisible()
    await field.fill(question)
    await field.press('Enter')
    const future = panel.getByRole('link', { name: 'Open Future' })
    await expect(future).toHaveAttribute('href', '#/research/NVDA?view=future')
    const resize = panel.getByRole('button', { name: 'Resize assistant' })
    for (const [width, height] of [
      [1200, 820],
      [457, 554],
      [320, 568],
    ]) {
      await page.setViewportSize({ width, height })
      await assertMessagesFit(panel)
      await resize.press('Shift+ArrowRight')
      await assertMessagesFit(panel)
      await resize.press('Home')
      await panel.getByRole('button', { name: 'Minimize assistant' }).click()
      await open.click()
      await assertMessagesFit(panel)
    }
    await page.reload()
    await open.click()
    await expect(future).toHaveAttribute('href', '#/research/NVDA?view=future')
    await assertMessagesFit(panel)
    await future.click()
    await expect(page).toHaveURL(/#\/research\/NVDA\?view=future$/)
    await expect(page.getByRole('region', { name: 'Price forecast' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open assistant' })).toBeVisible()
  } finally {
    await request.delete('/api/assistant/chats/' + id)
    await request.patch('/api/preferences', { data: { appearance: oldMode } })
  }
})

test('a direct forecast command generates once, opens the requested period and keeps a read-only receipt', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1', 'Uses intercepted model generation')
  expect(
    (
      await request.put('/api/openai', { data: { key: 'intercepted-browser-test-credential' } })
    ).ok(),
  ).toBe(true)
  expect((await request.patch('/api/ai', { data: { provider: 'openai' } })).ok()).toBe(true)
  const generations: string[] = []
  page.on('request', (req) => {
    const url = new URL(req.url())
    if (req.method() === 'POST' && url.pathname.startsWith('/api/desk/forecast/'))
      generations.push(url.pathname + url.search)
  })
  // Render the previous answer before its SQLite write is acknowledged, as can happen in Safari.
  let acknowledge!: () => void
  const held = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  let waitingForReceipt = false
  const plans: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/assistant')
      plans.push(req.postDataJSON().messages.at(-1).text)
  })
  await page.route('**/api/assistant/chats/*', async (route) => {
    const req = route.request()
    if (
      req.method() === 'PUT' &&
      !waitingForReceipt &&
      req
        .postDataJSON()
        .entries?.at(-1)
        ?.links?.some((l: { focus?: string }) => l.focus === 'future')
    ) {
      waitingForReceipt = true
      await held
    }
    return route.continue()
  })
  await page.goto('/#/settings/MSFT')
  const open = page.getByRole('button', { name: 'Open assistant' })
  await open.click()
  const chat = page.getByRole('region', { name: 'StockReplay assistant' })
  await chat.getByRole('button', { name: 'Chat history' }).click()
  await chat.getByRole('button', { name: 'New conversation' }).click()
  const input = chat.getByLabel('Message the assistant')
  await input.fill('Can you generate a forecast for AAPL?')
  await input.press('Enter')
  await expect(chat.getByRole('link', { name: 'Open Future' })).toHaveAttribute(
    'href',
    '#/research/AAPL?view=future',
  )
  expect(generations).toEqual([])
  await input.fill('Open the saved 1M forecast for AAPL')
  await input.press('Enter')
  try {
    await expect(
      chat.getByText('Message queued. It will send after this reply is saved.'),
    ).toBeVisible()
    await input.press('Enter')
    expect(plans).toEqual(['Can you generate a forecast for AAPL?'])
  } finally {
    acknowledge()
  }
  await expect(page).toHaveURL(/#\/research\/AAPL\?view=future&range=1mo$/)
  await expect(chat.getByText('Opened Future on the price chart.')).toBeVisible()
  expect(generations).toEqual([])
  // The already-open chart must adopt the explicitly generated result on receipt.
  await input.fill('Generate a 1M forecast for AAPL')
  const finished = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/api/desk/forecast/AAPL'),
  )
  await input.press('Enter')
  await input.press('Enter')
  const response = await finished
  expect(response.ok(), await response.text()).toBe(true)
  const { forecast } = await response.json()
  const receipt = chat.getByRole('link', { name: 'Open saved forecast' })
  await expect(receipt).toHaveAttribute('href', '#/research/AAPL?view=future&range=1mo')
  await expect(page.getByRole('region', { name: 'Price forecast' })).toContainText(forecast.summary)
  await page.goto('/#/settings/MSFT')
  await page.reload()
  await open.click()
  await receipt.click()
  await expect(page).toHaveURL(/#\/research\/AAPL\?view=future&range=1mo$/)
  await expect(page.getByRole('region', { name: 'Price forecast' })).toContainText(forecast.summary)
  expect(generations).toEqual(['/api/desk/forecast/AAPL?range=1mo'])
  expect(plans).toEqual([
    'Can you generate a forecast for AAPL?',
    'Open the saved 1M forecast for AAPL',
    'Generate a 1M forecast for AAPL',
  ])
})

test('forecast questions preserve the requested horizon and a delayed AI reply leaves Future usable', async ({
  page,
}) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let generations = 0
  await page.route('**/api/desk/forecast/*?*', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    generations++
    await pending
    return route.fulfill({ status: 503, json: { detail: 'AI connection interrupted.' } })
  })
  await page.goto('/#/settings/MSFT')
  await page.getByRole('button', { name: 'Open assistant' }).click()
  const chat = page.getByRole('region', { name: 'StockReplay assistant' })
  await chat.getByRole('button', { name: 'Chat history' }).click()
  await chat.getByRole('button', { name: 'New conversation' }).click()
  const input = chat.getByLabel('Message the assistant')
  await input.fill('Can I see the 5-day forecast for Apple?')
  await input.press('Enter')
  const link = chat.getByRole('link', { name: 'Open Future' })
  await expect(link).toHaveAttribute('href', '#/research/AAPL?view=future&range=5d')
  await link.click()
  await expect(page).toHaveURL(/#\/research\/AAPL\?view=future&range=5d$/)
  expect(generations).toBe(0)

  await page.getByRole('button', { name: 'Open assistant' }).click()
  await input.fill('Generate a 1W forecast for MSFT')
  await input.press('Enter')
  try {
    await expect.poll(() => generations).toBe(1)
    await expect(page).toHaveURL(/#\/research\/MSFT\?view=future&range=1w$/)
    await expect(
      page
        .getByRole('group', { name: 'Forecast period' })
        .getByRole('button', { name: '1W', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    const path = page
      .getByRole('region', { name: 'Price forecast' })
      .locator('[data-symbol="MSFT"][data-forecast-model="statistical"]')
    await expect(path.locator('[data-line="median"]')).toHaveAttribute('d', /^M.+L/)
    await expect(path.locator('[data-forecast-end]')).toHaveAttribute(
      'data-forecast-end',
      /^\d{4}-\d{2}-\d{2}$/,
    )
  } finally {
    release()
  }
  await expect(chat.getByText('AI connection interrupted.')).toBeVisible()
  expect(generations).toBe(1)
})
