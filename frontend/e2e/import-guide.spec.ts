import { expect, test } from '@playwright/test'

test('portfolio guide opens a matching import and preserves a selected statement while reading help', async ({
  page,
  request,
}) => {
  await page.goto('/#/portfolio/NVDA')
  await page.getByRole('button', { name: 'Import guide', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Portfolio import guide' })
  await expect(dialog.getByRole('link', { name: 'Fidelity’s positions help' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Other brokerage' }).click()
  await expect(dialog.getByRole('link', { name: 'Schwab’s positions guide' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Bank', exact: true }).click()
  await expect(dialog.getByRole('link', { name: 'Wells Fargo’s download help' })).toBeVisible()
  await dialog.getByText('CSV template and future updates').click()
  const templatePath = await dialog
    .getByRole('link', { name: 'Download blank holdings CSV' })
    .getAttribute('href')
  const response = await request.get(templatePath!)
  expect(response.ok()).toBeTruthy()
  const header = (await response.text()).trim()
  expect(header.split(',')).toContain('Market Value')
  await dialog.getByRole('button', { name: 'Choose a statement' }).click()

  dialog = page.getByRole('dialog', { name: 'Import a holdings statement' })
  await expect(dialog.getByLabel('Institution', { exact: true })).toHaveValue('')
  await dialog.getByLabel('Institution', { exact: true }).fill('Guide test bank')
  await dialog.getByLabel('Positions statement').setInputFiles({
    name: 'account.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(header + '\nGuide savings,,Savings balance,,,1200,,USD,2026-05-20\n'),
  })
  await dialog.getByText('How to import your portfolio', { exact: true }).click()
  await expect(dialog.getByRole('link', { name: 'Fidelity’s positions help' })).toBeVisible()
  await dialog.getByText('How to import your portfolio', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Preview statement' }).click()
  await expect(dialog.getByText('Guide test bank · Guide savings')).toBeVisible()
  await dialog.getByText('Review all positions').click()
  await expect(dialog.getByRole('cell', { name: '2026-05-20' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByRole('heading', { name: 'Guide savings' })).toHaveCount(0)
})

test('the assistant’s guide link survives a reload', async ({ page }) => {
  await page.goto('/#/portfolio/NVDA/import-guide')
  await expect(page.getByRole('dialog', { name: 'Portfolio import guide' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('dialog', { name: 'Portfolio import guide' })).toBeVisible()
})
