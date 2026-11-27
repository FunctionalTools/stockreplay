import { expect, test } from '@playwright/test'

test('saved score citations and original-source previews retain a search index date offline', async ({
  page,
  request,
}) => {
  const source = {
    id: 'e_web',
    group: 'web_news',
    text: 'A sourced company development',
    source: 'Example Finance',
    excerpt: 'The publisher provided this passage on the project.',
    url: 'https://example.org/offline-indexed-item',
    date: '2026-11-25',
    date_kind: 'indexed',
    stale: true,
  }
  const point = { text: 'The company faces uncertainty.', citations: [source.id] }
  await page.route('**/api/desk/brief/**', (route) => route.abort())
  await page.route('**/api/desk/recommend/MSFT', (route) =>
    route.fulfill({
      json: [
        {
          id: 'stored-offline-test',
          symbol: 'MSFT',
          buy_score: 52,
          risk_score: 60,
          confidence: 'Low',
          horizon: '6–12 months',
          created: '2026-11-26T00:00:00Z',
          model: 'qwen2.5:3b',
          thesis: point,
          catalysts: [],
          risks: [],
          reconsider: point,
          sources: [source],
        },
      ],
    }),
  )
  await page.goto('/#/research/MSFT')
  await expect(page.locator('.opinion .cue').first()).toContainText(
    'Indexed Nov 25, 2026 · Cached after a source error',
  )
  await expect(
    page.getByText('Showing articles saved with the Nov 26, 2026 assessment.'),
  ).toBeVisible()
  const news = page.locator('#news')
  await news.getByRole('button', { name: 'Company', exact: true }).click()
  await news.getByRole('button', { name: 'Preview ' + source.text }).click()
  const preview = page.getByRole('dialog', { name: 'Article preview' })
  await expect(preview.getByText('Indexed Nov 25, 2026')).toBeVisible()
  await expect(preview.getByText(source.excerpt)).toBeVisible()
  await expect(preview.getByRole('link', { name: 'Read on Example Finance' })).toHaveAttribute(
    'href',
    source.url,
  )
  await preview.getByRole('button', { name: 'Close dialog' }).click()
  await news.getByRole('button', { name: 'Used in scores' }).click()
  await news.getByRole('button', { name: 'Save ' + source.text, exact: true }).click()
  await expect(news.getByRole('button', { name: 'Unsave ' + source.text })).toBeVisible()
  await page.reload()
  await news.getByRole('button', { name: /Saved articles/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Saved articles' })
  const item = dialog
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: source.text }) })
  await expect(item.getByText('Example Finance · Indexed Nov 25, 2026')).toBeVisible()
  const rows = await (await request.get('/api/reading-list')).json()
  expect(rows.find((row: { url: string }) => row.url === source.url)).toMatchObject({
    published: null,
    indexed_at: '2026-11-25',
  })
  await item.getByRole('button', { name: 'Remove ' + source.text + ' from saved articles' }).click()
  await expect(item).toHaveCount(0)
})
