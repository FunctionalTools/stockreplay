import { expect, test, type Page } from '@playwright/test'

// Isolate the event UI from changing publication schedules. Price projections run through the API.
async function events(page: Page) {
  await page.route('**/api/desk/events?*', (route) => {
    const q = new URL(route.request().url()).searchParams,
      start = q.get('start')!,
      end = q.get('end')!
    return route.fulfill({
      json: {
        start,
        end,
        checked_at: start + 'T15:00:00Z',
        gaps: [],
        events: [
          {
            id: 'calendar-source-example',
            date: end,
            title: 'Scheduled policy decision',
            kind: 'macro',
            status: 'scheduled',
            symbols: [],
            source: 'Event publisher',
            url: 'https://example.org/test/policy-decision',
            excerpt: 'The publisher scheduled a policy decision for this date.',
            relevance: 'Policy rates may affect financing costs.',
            checked_at: start + 'T15:00:00Z',
          },
        ],
      },
    })
  })
}
test('Research opens a dated forecast, compares tickers, and preserves horizon on reload', async ({
  page,
}) => {
  await events(page)
  await page.goto('/#/research/AAPL')
  await page.getByRole('link', { name: 'Forecast calendar' }).click()
  await expect(page).toHaveURL(/#\/calendar\/AAPL$/)
  await expect(page.getByRole('heading', { name: 'Price projection' })).toBeVisible()
  await expect(page.locator('[data-symbol="AAPL"] path[data-line="actual"]')).toHaveAttribute(
    'd',
    /^M.+L/,
  )
  await page.getByLabel('Ticker to compare').fill('msft')
  await page.getByRole('button', { name: 'Add ticker' }).click()
  await expect(page.getByRole('heading', { name: 'Projected returns' })).toBeVisible()
  await expect(page.getByText('Return from the shared close on', { exact: false })).toBeVisible()
  const presets = page.getByRole('region', { name: 'Forecast settings' })
  for (const [label, code] of [
    ['Day', '1d'],
    ['Week', '1w'],
    ['Month', '1mo'],
    ['6 months', '6mo'],
    ['1 year', '1y'],
    ['5 years', '5y'],
  ]) {
    const response = page.waitForResponse(
      (r) =>
        r.url().includes('/api/desk/projections?') &&
        new URL(r.url()).searchParams.get('horizon') === code,
    )
    await presets.getByRole('button', { name: label, exact: true }).click()
    expect((await response).ok()).toBe(true)
    await expect(page.locator('path[data-line="median"]')).toHaveCount(2)
    await expect(page.locator('path[data-line="upper"]')).toHaveCount(2)
    await expect(page.locator('path[data-line="lower"]')).toHaveCount(2)
  }
  const link = page.url()
  await page.reload()
  await expect(page).toHaveURL(link)
  await expect(presets.getByRole('button', { name: '5 years' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: 'Remove AAPL from forecast' }).click()
  await expect(page).toHaveURL(/calendar\/MSFT\?horizon=5y$/)
  await expect(page.locator('[data-symbol="MSFT"] path[data-line="median"]')).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Projected returns' })).toBeVisible()
})

test('timeline plays, scrubs with keys and exposes a linked event from both calendar views', async ({
  page,
}) => {
  await events(page)
  await page.goto('/#/calendar/MSFT?horizon=6mo')
  const slider = page.getByRole('slider', { name: 'Inspect timeline date' })
  await expect(slider).toBeVisible()
  const initial = await slider.inputValue()
  await slider.focus()
  await slider.press('ArrowRight')
  await expect(slider).not.toHaveValue(initial)
  const second = await slider.inputValue()
  await page.getByRole('button', { name: 'Play timeline' }).click()
  await expect(slider).not.toHaveValue(second)
  await page.getByRole('button', { name: 'Pause timeline' }).click()
  await slider.focus()
  await slider.press('End')
  await expect(
    page.getByRole('table', { name: 'Prices on inspected date' }).locator('tbody td').nth(1),
  ).not.toHaveText('—')
  const marker = page.locator('.forecast-marker')
  await marker.hover()
  const preview = page.getByRole('region', { name: 'Timeline event preview' })
  await expect(preview.getByRole('link', { name: 'Event publisher' })).toHaveAttribute(
    'href',
    'https://example.org/test/policy-decision',
  )
  await preview.getByRole('button', { name: 'Close event preview' }).click()
  await marker.focus()
  await expect(preview).toBeVisible()
  await marker.press('Escape')
  await expect(preview).toHaveCount(0)
  const section = page.getByRole('region', { name: 'Market event calendar' })
  await section.getByRole('button', { name: /Scheduled policy decision/ }).click()
  await expect(
    section.getByText('Policy rates may affect financing costs.', { exact: false }),
  ).toBeVisible()
  await section.getByRole('button', { name: 'Month grid' }).click()
  await expect(section.getByRole('table')).toBeVisible()
  await expect(section.getByRole('button', { name: /1 events/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await section.getByRole('button', { name: 'Previous calendar month' }).click()
  await expect(section.getByText('Select a date')).toBeVisible()
  await section.getByRole('button', { name: 'Agenda' }).click()
  await expect(section.getByRole('link', { name: 'Event publisher' })).toBeVisible()
  await page.getByText('How the forecast is calculated').click()
  await expect(page.getByText('Historical returns', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Yahoo Finance' })).toBeVisible()
})
