import { expect, test, type Locator } from '@playwright/test'

// Measure the browser's laid-out text fragments. An overflow:hidden parent can have a
// perfectly normal bounding box while its words or an entire positioned bubble lie outside.
async function textLeaks(panel: Locator) {
  return panel.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const failures = new Set<string>()
    while (walker.nextNode()) {
      const node = walker.currentNode
      const el = node.parentElement!
      if (!node.textContent?.trim() || el.closest('[aria-hidden="true"],.sr-only')) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const boxes = [...range.getClientRects()].filter((b) => b.height && b.width)
      // Some WebKit versions expose SVG text geometry on the text element only.
      if (!boxes.length && el instanceof SVGTextElement) boxes.push(el.getBoundingClientRect())
      const container = el.closest('[data-speaker]') ?? root
      const limits = [
        container,
        root,
        ...[
          el.closest('.chat-body,.chat-history-body'),
          el.closest('svg'),
          el.closest('.chat-heading,.chat-history-list strong,.chat-scroll-detail'),
        ].filter(Boolean),
      ] as Element[]
      for (const owner of limits) {
        const rect = owner.getBoundingClientRect()
        for (const box of boxes)
          if (box.left < rect.left - 1 || box.right > rect.right + 1)
            failures.add(
              node.textContent.slice(0, 24) +
                ' beyond ' +
                (owner.getAttribute('class') || owner.tagName) +
                ' by ' +
                Math.ceil(Math.max(rect.left - box.left, box.right - rect.right)) +
                'px',
            )
      }
    }
    let previousRight = -Infinity
    for (const label of root.querySelectorAll('.price-plot > svg > text')) {
      const range = document.createRange()
      range.selectNodeContents(label)
      const rangeBox = range.getBoundingClientRect()
      const box = rangeBox.width ? rangeBox : label.getBoundingClientRect()
      if (box.left < previousRight + 1) failures.add('Overlapping dates at ' + label.textContent)
      previousRight = box.right
    }
    return Array.from(failures).slice(0, 14)
  })
}

test('every rendered line stays inside the assistant, including long titles, links and graph labels', async ({
  page,
  request,
}) => {
  const title = 'PortfolioReview'.repeat(7)
  const word = 'MMMM'.repeat(100)
  const url = 'https://example.org/' + word
  const saved = await request.post('/api/assistant/chats', {
    data: {
      title,
      entries: [
        { id: 1, role: 'user', text: 'Portfolio: ' + word },
        {
          id: 2,
          role: 'assistant',
          text: '**Summary**\n`' + word + '`\n' + url,
          links: [{ page: 'Settings', label: url.slice(0, 99) }],
          sources: [{ id: 'S1', url, source: word, date: '2026-01-05', text: word }],
          rows: [{ name: word, currency: 'USD', value: 324234.56 }],
          graph: { symbols: ['BRK.A'], span: '1mo', snapshot: 'layout-check' },
        },
      ],
      context: [],
    },
  })
  expect(saved.ok()).toBe(true)
  const { id } = await saved.json()
  await page.addInitScript((id) => sessionStorage.setItem('stockreplay.selected-chat.v1', id), id)
  await page.route('**/api/assistant/charts/layout-check', (route) =>
    route.fulfill({
      json: {
        errors: [],
        series: [
          {
            symbol: 'BRK.A',
            source: word,
            url,
            currency: 'USD',
            as_of: '2026-01-07',
            bars: [
              { time: 1767571200, date: '2026-01-05', raw_close: 728365.63, close: 728365.63 },
              { time: 1767657600, date: '2026-01-06', raw_close: 735197.48, close: 735197.48 },
              { time: 1767744000, date: '2026-01-07', raw_close: 734981.24, close: 734981.24 },
            ],
          },
        ],
      },
    }),
  )
  const originalMode = (await (await request.get('/api/preferences')).json()).appearance
  try {
    for (const [width, height, mode] of [
      [1240, 846, 'dark'],
      [320, 580, 'light'],
      [568, 320, 'dark'],
    ] as const) {
      await request.patch('/api/preferences', { data: { appearance: mode } })
      await page.setViewportSize({ width, height })
      await page.goto('/?viewport=' + width + '#/settings/NVDA')
      await expect(page.locator('html')).toHaveAttribute('data-mode', mode)
      await page.getByRole('button', { name: 'Open assistant' }).click()
      const panel = page.getByRole('region', { name: 'StockReplay assistant' })
      await expect(panel.locator('.price-plot > svg')).toBeAttached()
      const more = panel.getByRole('button', { name: 'Read more' })
      while (await more.count()) await more.first().click()
      for (const summary of await panel.locator('summary').all()) await summary.click()
      await page.evaluate(() => document.fonts.ready)
      expect.soft(await textLeaks(panel), width + 'px conversation').toEqual([])
      const resize = panel.getByRole('button', { name: 'Resize assistant' })
      await resize.click()
      expect.soft(await textLeaks(panel), width + 'px expanded conversation').toEqual([])
      await resize.press('Home')
      await resize.press('Shift+ArrowRight')
      await resize.press('Shift+ArrowRight')
      for (let i = 0; i < 5; i++) await resize.press('Shift+ArrowDown')
      expect(await panel.locator('.chat-body').evaluate((el) => el.clientHeight)).toBeGreaterThan(
        55,
      )
      expect.soft(await textLeaks(panel), width + 'px minimum-size conversation').toEqual([])
      await resize.press('Home')
      await panel.getByRole('button', { name: 'Chat history' }).click()
      await expect(panel.getByRole('button', { name: new RegExp(title) })).toBeVisible()
      expect.soft(await textLeaks(panel), width + 'px history').toEqual([])
    }
  } finally {
    await request.delete('/api/assistant/chats/' + id)
    await request.patch('/api/preferences', { data: { appearance: originalMode } })
  }
})

test('drag, keyboard, and compact size controls persist and stay on screen', async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 850 })
  await page.goto('/#/settings/NVDA')
  const open = page.getByRole('button', { name: 'Open assistant' })
  await open.click()
  const panel = page.getByRole('region', { name: 'StockReplay assistant' })
  const handle = panel.getByRole('button', { name: 'Resize assistant' })
  const initial = (await panel.boundingBox())!
  const grip = (await handle.boundingBox())!
  const x = grip.x + grip.width / 2,
    y = grip.y + grip.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 155, y - 107, { steps: 8 })
  await page.mouse.up()
  const expanded = (await panel.boundingBox())!
  expect(expanded.width).toBeCloseTo(initial.width + 155, 0)
  expect(expanded.height).toBeCloseTo(initial.height + 107, 0)
  expect(expanded.x + expanded.width).toBeCloseTo(initial.x + initial.width, 0)
  expect(expanded.y + expanded.height).toBeCloseTo(initial.y + initial.height, 0)
  await handle.press('ArrowLeft')
  await handle.press('Shift+ArrowUp')
  const preferred = (await panel.boundingBox())!
  expect(preferred.width).toBeCloseTo(expanded.width + 16, 0)
  expect(preferred.height).toBeCloseTo(expanded.height + 64, 0)
  await page.reload()
  await open.click()
  await expect(panel).toHaveCSS('width', preferred.width + 'px')
  await expect(panel).toHaveCSS('height', preferred.height + 'px')
  await page.setViewportSize({ width: 320, height: 320 })
  const mobile = (await panel.boundingBox())!
  expect(mobile.x).toBeGreaterThanOrEqual(0)
  expect(mobile.y).toBeGreaterThanOrEqual(0)
  expect(mobile.x + mobile.width).toBeLessThanOrEqual(320)
  expect(mobile.y + mobile.height).toBeLessThanOrEqual(320)
  await page.setViewportSize({ width: 1240, height: 850 })
  await expect(panel).toHaveCSS('width', preferred.width + 'px')
  await handle.press('Home')
  await expect(panel).toHaveCSS('width', initial.width + 'px')
  await handle.press('Enter')
  await expect(panel).toHaveCSS('width', '660px')
  await handle.click()
  await expect(panel).toHaveCSS('width', initial.width + 'px')
  await page.reload()
  await open.click()
  await expect(panel).toHaveCSS('height', initial.height + 'px')
})
