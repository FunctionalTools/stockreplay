import { test, expect } from '@playwright/test'

test('assistant builds a saved tab that can be edited and reopened from My tabs', async ({
  page,
  request,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  await request.put('/api/openai', { data: { key: 'intercepted-browser-test-credential' } })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open assistant' }).click()
  const chat = page.getByRole('region', { name: 'StockReplay assistant' })
  await chat.getByLabel('Message the assistant').fill('Make a Chip stocks tab')
  await chat.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Chip stocks' })).toBeVisible()
  await chat.getByRole('button', { name: 'Minimize assistant' }).click()
  await expect(
    page.getByRole('img', { name: 'NVDA and AMD historical percentage returns' }),
  ).toBeVisible()
  const url = page.url()
  await page.getByRole('button', { name: 'Edit tab' }).click()
  const modal = page.getByRole('dialog')
  await modal.getByLabel('Block type').selectOption('note')
  await modal.getByRole('button', { name: 'Add block' }).click()
  await modal.getByLabel('Note text').fill('Review current valuations.')
  await modal.getByRole('button', { name: 'Move block 2 up' }).click()
  await modal.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.locator('.tab-widget').first()).toContainText('Review current valuations.')
  await page.reload()
  await expect(page.getByText('Review current valuations.')).toBeVisible()
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Portfolio' })
    .click()
  await page.getByRole('button', { name: 'My tabs' }).click()
  await page.getByRole('link', { name: 'Chip stocks' }).click()
  await expect(page).toHaveURL(url)
  await page.goBack()
  await expect(
    page.getByRole('heading', { level: 1, name: 'Portfolio', exact: true }),
  ).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL(url)
  await expect(page.getByText('Review current valuations.')).toBeVisible()
  await page.getByRole('button', { name: 'Delete tab Chip stocks' }).click()
  await page.getByRole('button', { name: 'Delete saved tab' }).click()
  await expect(page).not.toHaveURL(url)
})
