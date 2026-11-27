import { expect, test } from '@playwright/test'

test('institution guides link to official instructions and preview files locally', async ({
  page,
  request,
}) => {
  await page.goto('/#/portfolio/NVDA')
  await page.getByRole('button', { name: 'Import guide', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Portfolio import guide' })
  const picker = dialog.getByRole('combobox', { name: 'Choose your institution' })
  for (const [institution, source] of [
    ['Fidelity', 'https://www.fidelity.com/'],
    ['Charles Schwab', 'https://www.schwab.com/'],
    ['Interactive Brokers', 'https://www.ibkrguides.com/'],
    ['Chase', 'https://www.chase.com/'],
    ['Bank of America', 'https://info.bankofamerica.com/'],
    ['Capital One', 'https://www.capitalone.com/'],
    ['Wells Fargo', 'https://www.wellsfargo.com/'],
  ]) {
    await picker.selectOption(institution)
    const links = dialog.locator('.guide-links a')
    expect(await links.count()).toBeGreaterThan(0)
    for (const link of await links.all()) expect(await link.getAttribute('href')).toContain(source)
    await expect(dialog.getByRole('button', { name: 'Import a local file' })).toBeVisible()
  }
  await dialog.getByText('CSV template and future updates').click()
  const template = dialog.getByRole('link', { name: 'Download blank bank balance CSV' })
  const response = await request.get((await template.getAttribute('href'))!)
  expect(response.ok()).toBeTruthy()
  const header = (await response.text()).trim()
  expect(header).toBe('Account Name,Description,Balance,Currency,Statement Date')
  await dialog.getByRole('button', { name: 'Import a local file' }).click()

  dialog = page.getByRole('dialog', { name: 'Import a holdings statement' })
  await expect(dialog.getByLabel('Institution', { exact: true })).toHaveValue('Wells Fargo')
  await dialog.getByLabel('Positions statement').setInputFiles({
    name: 'account.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(header + '\nGuide savings,Closing balance,1200,USD,2026-05-20\n'),
  })
  await dialog.getByText('How to import your portfolio', { exact: true }).click()
  await expect(dialog.getByRole('link', { name: 'Wells Fargo’s download help' })).toBeVisible()
  await dialog.getByLabel('Choose your institution').selectOption('Another bank')
  await dialog.getByRole('button', { name: 'Import a local file' }).click()
  await expect(dialog.getByLabel('Institution', { exact: true })).toHaveValue('')
  await dialog.getByLabel('Institution', { exact: true }).fill('Wells Fargo')
  await dialog.getByRole('button', { name: 'Preview statement' }).click()
  await expect(dialog.getByText('Wells Fargo · Guide savings')).toBeVisible()
  await dialog.getByText('Review all positions').click()
  await expect(dialog.getByRole('cell', { name: '2026-05-20' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByRole('heading', { name: 'Guide savings' })).toHaveCount(0)
})

test('a bank balance can be reviewed, changed, and saved without a file or an external request', async ({
  page,
  request,
}) => {
  const external: string[] = []
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).hostname !== '127.0.0.1') {
      external.push(route.request().url())
      return route.abort()
    }
    return route.continue()
  })
  await page.addInitScript(() =>
    window.addEventListener('stockreplay:holdings-changed', () => {
      sessionStorage.setItem(
        'holdings-refreshes',
        String(1 + Number(sessionStorage.getItem('holdings-refreshes'))),
      )
    }),
  )
  await page.goto('/#/portfolio/NVDA/import-guide')
  let dialog = page.getByRole('dialog', { name: 'Portfolio import guide' })
  await dialog.getByLabel('Choose your institution').selectOption('Chase')
  await dialog.getByRole('button', { name: 'Enter statement balance' }).click()
  dialog = page.getByRole('dialog', { name: 'Import a holdings statement' })
  const nickname = 'Guide bank balance'
  await expect(dialog.getByLabel('Institution', { exact: true })).toHaveValue('Chase')
  await expect(dialog.getByLabel('Positions statement')).toBeHidden()
  await dialog.getByLabel('Account nickname').fill(nickname)
  await dialog.getByLabel('Closing balance').fill('-4.53')
  await dialog.getByLabel('Balance currency').fill('CAD')
  await dialog.getByLabel('Statement as of').fill('2026-11-24')
  await dialog.getByRole('button', { name: 'Preview statement' }).click()
  await expect(dialog.getByRole('heading', { name: 'Review statement balance' })).toBeVisible()
  await dialog.getByText('Review all positions').click()
  await expect(dialog.getByRole('cell', { name: '-4.53' })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('holdings-refreshes'))).toBeNull()
  const before = await (await request.get('/api/holdings')).json()
  expect(before.some((account: { name: string }) => account.name === nickname)).toBe(false)
  await dialog.getByLabel('Closing balance').fill('0')
  await expect(dialog.getByRole('button', { name: 'Apply reviewed statement' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Preview statement' }).click()
  await dialog.getByRole('button', { name: 'Apply reviewed statement' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name: nickname, exact: true })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('holdings-refreshes'))).toBe('1')
  const after = await (await request.get('/api/holdings')).json()
  const saved = after.find((account: { name: string }) => account.name === nickname)
  expect(saved.positions).toMatchObject([{ value: 0, currency: 'CAD', as_of: '2026-11-24' }])
  await page.reload()
  await expect(page.getByRole('heading', { name: nickname, exact: true })).toBeAttached()
  expect(external).toEqual([])
})

test('the assistant’s guide link survives a reload', async ({ page }) => {
  await page.goto('/#/portfolio/NVDA/import-guide')
  await expect(page.getByRole('dialog', { name: 'Portfolio import guide' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('dialog', { name: 'Portfolio import guide' })).toBeVisible()
})
