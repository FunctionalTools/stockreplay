import { expect, test, type Page } from '@playwright/test'

async function ticker(page: Page, symbol: string) {
  await expect(page).toHaveTitle(symbol + ' · StockReplay')
  await expect(page.locator('.research .kicker')).toContainText(symbol)
}

test('Research opens from this Mac, remembers a selected ticker and respects shared links', async ({
  page,
  request,
}) => {
  await request.patch('/api/preferences', { data: { home_mode: 'portfolio' } })
  const before = await (await request.get('/api/home')).json()
  const lookup: string[] = []
  const pinned: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/desk/')) lookup.push(r.url())
    if (r.url().endsWith('/api/preferences') && r.method() === 'PATCH')
      pinned.push(r.postDataJSON().home_symbol)
  })
  await page.goto('/')
  await ticker(page, before.portfolio_symbol || 'SPY')
  if (!before.portfolio_symbol) {
    await expect(page.getByText('S&P 500 benchmark', { exact: false })).toBeVisible()
    expect(lookup.some((url) => url.includes('/NVDA'))).toBe(false)
  }
  const field = page.getByRole('textbox', { name: 'Search stocks' })
  await field.fill('Apple')
  await field.press('Enter')
  await ticker(page, 'AAPL')
  await field.fill('Microsoft')
  await page.getByRole('button', { name: 'Search for “Microsoft”' }).click()
  await ticker(page, 'MSFT')
  await expect
    .poll(async () => (await (await request.get('/api/preferences')).json()).home_symbol)
    .toBe('MSFT')
  expect(pinned).toEqual(['AAPL', 'MSFT'])
  await page.goto('/')
  await ticker(page, 'MSFT')
  await page.goto('/#/research/AMD/news')
  await ticker(page, 'AMD')
  await expect(page.locator('.home-picker')).toContainText('Viewing AMD · Home starts with MSFT')
  await page.reload()
  await ticker(page, 'AMD')
  await page.getByRole('button', { name: 'StockReplay home' }).click()
  await ticker(page, 'MSFT')
  await page.goBack()
  await ticker(page, 'AMD')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Open Research with').selectOption('portfolio')
  await page.getByRole('button', { name: 'Research', exact: true }).click()
  await ticker(page, before.portfolio_symbol || 'SPY')
})

test('a portfolio import, edit and removal update the Research homepage without restarting', async ({
  page,
  request,
}) => {
  await request.patch('/api/preferences', { data: { home_mode: 'portfolio' } })
  await page.goto('/#/portfolio')
  await page.getByRole('button', { name: 'Import statement', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Import a holdings statement' })
  await modal.getByLabel('Institution', { exact: true }).fill('Home test')
  await modal.getByLabel('Account nickname').fill('Opening research')
  await modal.getByLabel('Positions statement').setInputFiles({
    name: 'investment.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Symbol,Description,Quantity,Market Value,Currency,Statement Date\nAAPL,Apple,10,9000000,USD,2026-04-16\nSPAXX,Government money market,5,9100000,USD,2026-04-16\n',
    ),
  })
  await modal.getByRole('button', { name: 'Preview statement' }).click()
  await modal.getByRole('button', { name: 'Apply reviewed statement' }).click()
  await expect(modal).toHaveCount(0)
  const research = page.getByRole('button', { name: 'Research', exact: true })
  await research.click()
  await ticker(page, 'AAPL')
  const holding = page.getByRole('button', { name: 'Research holding AAPL in USD' })
  await expect(holding).toContainText('10 units')
  await expect(holding).toContainText('Apr 16, 2026')
  await expect(page.getByRole('button', { name: 'Research holding SPAXX in USD' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Portfolio', exact: true }).click()
  const account = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Opening research' }) })
    .last()
  await account.getByRole('button', { name: 'Edit AAPL' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit position' })
  await edit.getByLabel('Investment symbol', { exact: true }).fill('META')
  await edit.getByRole('button', { name: 'Save position' }).click()
  await expect(edit).toHaveCount(0)
  await research.click()
  await ticker(page, 'META')
  await page.getByRole('button', { name: 'Portfolio', exact: true }).click()
  await account.getByRole('button', { name: 'Delete account Opening research' }).click()
  await page.getByRole('button', { name: 'Remove local record' }).click()
  await expect(account).toHaveCount(0)
  const result = await (await request.get('/api/home')).json()
  await research.click()
  await ticker(page, result.portfolio_symbol || 'SPY')
  await expect(page.getByRole('button', { name: 'Research holding META in USD' })).toHaveCount(0)
})

test('ticker suggestions support pointer selection, keyboard selection and outside dismissal', async ({
  page,
}) => {
  await page.route('**/api/symbols?*online=true', (route) =>
    route.fulfill({ json: [{ symbol: 'AAPL', name: 'Apple Inc.' }] }),
  )
  await page.goto('/#/research/SPY')
  const field = page.getByRole('textbox', { name: 'Search stocks' })
  const result = page.getByRole('button', { name: 'AAPL Apple Inc.' })
  await field.fill('App')
  await expect(result).toBeVisible()
  await result.hover()
  await page.mouse.down()
  await expect(field).toBeFocused()
  await page.mouse.up()
  await ticker(page, 'AAPL')
  await field.fill('App')
  await expect(result).toBeVisible()
  await page.getByRole('heading', { name: 'Research a ticker' }).click()
  await expect(result).toHaveCount(0)
  await field.focus()
  await expect(result).toBeVisible()
  await result.focus()
  await page.keyboard.press('Escape')
  await expect(result).toHaveCount(0)
  await field.focus()
  await expect(result).toBeVisible()
  await result.focus()
  await page.keyboard.press('Enter')
  await expect(field).toHaveValue('')
  await expect(result).toHaveCount(0)
})
