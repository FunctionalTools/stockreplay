import { expect, test } from '@playwright/test'

test('bookmarks survive reload and open from a deep link while market sources are unavailable', async ({
  page,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await page.goto('/#/research/NVDA')
  await page.getByRole('button', { name: 'Save Published company report', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Unsave Published company report' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: /^Saved articles/ }).click()
  let dialog = page.getByRole('dialog', { name: 'Saved articles' })
  await expect(dialog.getByRole('link', { name: 'Published company report' })).toHaveAttribute(
    'href',
    'https://example.org/market/company',
  )
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await page.route('**/api/desk/brief/**', (route) => route.abort())
  await page.goto('/#/research/NVDA/saved-articles')
  await page.reload()
  dialog = page.getByRole('dialog', { name: 'Saved articles' })
  await expect(dialog.getByRole('link', { name: 'Published company report' })).toBeVisible()
  await dialog
    .getByRole('button', { name: 'Remove Published company report from saved articles' })
    .click()
  await expect(dialog.getByText('Tap the bookmark on a news story to save it here.')).toBeVisible()
})
