import { test, expect } from '@playwright/test'

test('article previews use decoded photos and keep unavailable media out of the layout', async ({
  page,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  const portrait = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAIAAAARP+ljAAAA1ElEQVR4nO3RAQkAIBDAwE9rBbPY1hQijIMLMNisswmb7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEX4+QQSHVBIWMAAAAASUVORK5CYII=',
    'base64',
  )
  await page.route('**/api/news/images/**', async (route) => {
    if (route.request().url().endsWith('b'.repeat(64)))
      await route.fulfill({ contentType: 'image/png', body: portrait })
    else
      await route.fulfill({
        status: 403,
        contentType: 'text/html',
        body: 'Publisher blocked this image',
      })
  })
  const failed = '/api/news/images/' + 'a'.repeat(64)
  const hero = '/api/news/images/' + 'b'.repeat(64)
  const article = {
    group: 'company_news',
    source: 'Test publisher',
    date: '2026-11-24',
    excerpt: 'The publisher supplied this summary for its readers.',
  }
  await page.route('**/api/desk/brief/NVDA', async (route) => {
    const response = await route.fetch(),
      brief = await response.json()
    brief.evidence = [
      {
        ...article,
        id: 'photograph',
        text: 'Healthy image fallback',
        url: 'https://example.org/news/a',
        preview: { images: [failed, hero], byline: 'Test reporter', subscription: true },
      },
      {
        ...article,
        id: 'unavailable',
        text: 'Publisher image unavailable',
        url: 'https://example.org/news/b',
        preview: { images: [failed] },
      },
      {
        ...article,
        id: 'archive',
        text: 'Older headline only',
        url: 'https://example.org/news/c',
        excerpt: null,
      },
    ]
    await route.fulfill({ response, json: brief })
  })
  await page.goto('/')
  const news = page.locator('#news')
  await news.scrollIntoViewIfNeeded()
  const good = news
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Healthy image fallback' }) })
  const missing = news
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Publisher image unavailable' }) })
  await expect(good.locator('img.publisher-photo:not(.pending-photo)')).toBeVisible()
  await expect(missing.locator('img')).toHaveCount(0)
  await expect(missing.getByRole('link', { name: 'Read article' })).toHaveAttribute(
    'href',
    'https://example.org/news/b',
  )
  await expect(
    news.getByRole('button', { name: 'Preview Older headline only', exact: true }),
  ).toHaveCount(0)
  await good.getByRole('button', { name: 'Preview Healthy image fallback' }).click()
  const reader = page.getByRole('dialog', { name: 'Article preview' })
  await expect(reader).toBeVisible()
  await expect(reader.getByText(article.excerpt)).toBeVisible()
  await expect(reader.getByText('Test reporter')).toBeVisible()
  await expect(reader.getByRole('link', { name: 'Read on Test publisher' })).toHaveAttribute(
    'href',
    'https://example.org/news/a',
  )
  await expect(reader.locator('iframe')).toHaveCount(0)
  await reader.getByRole('button', { name: 'Close dialog' }).click()
  await expect(reader).toHaveCount(0)
})
