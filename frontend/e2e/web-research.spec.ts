import { expect, test } from '@playwright/test'

test('searches articles and filings without an AI account and labels coverage and excerpts', async ({
  page,
}) => {
  test.skip(process.env.STOCKREPLAY_LIVE_TESTS === '1')
  const checked = new Date().toISOString()
  const url = 'https://www.sec.gov/Archives/edgar/data/789019/000119312526436133/msft-20260930.htm'
  await page.route('**/api/desk/web-research/MSFT', (route) => {
    expect(route.request().postDataJSON()).toEqual({ question: 'cloud earnings' })
    return route.fulfill({
      json: {
        symbol: 'MSFT',
        query: 'Microsoft earnings cloud',
        checked,
        evidence: [
          {
            id: 'filing-1',
            group: 'company_filings',
            text: 'Microsoft · quarterly filing',
            scope: 'Filing passage',
            source: 'SEC EDGAR',
            date: checked,
            url,
            discovered_via: 'SEC EDGAR full-text search',
            date_origin: 'SEC filing date',
            excerpt: 'The issuer describes changes in spending on cloud services.',
          },
        ],
        coverage: [
          { provider: 'SEC EDGAR', status: 'Checked', count: 1, checked, note: '' },
          {
            provider: 'GDELT news search',
            status: 'Unavailable',
            count: 0,
            checked,
            note: 'Index unavailable.',
          },
        ],
      },
    })
  })
  await page.goto('/#/research/MSFT')
  const section = page.locator('#web-research')
  await section.locator(':scope > summary').click()
  await section.getByLabel('Research topic for MSFT').fill('cloud earnings')
  await section.getByRole('button', { name: 'Search sources' }).click()
  await expect(section.getByRole('status')).toContainText('Microsoft earnings cloud')
  await expect(section.getByText('Filing passage · SEC EDGAR')).toBeVisible()
  await expect(section.locator('blockquote')).toHaveText(
    'The issuer describes changes in spending on cloud services.',
  )
  await expect(section.getByRole('link', { name: 'Original source' })).toHaveAttribute('href', url)
  await section.getByText('Search coverage', { exact: true }).click()
  await expect(section.getByText(/GDELT news search.*Unavailable/)).toBeVisible()
})
