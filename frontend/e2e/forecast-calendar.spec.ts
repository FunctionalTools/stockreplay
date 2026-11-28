import { expect, test, type Page } from '@playwright/test'
import type { Projections } from '../src/forecastData'
import { shortDay } from '../src/workspace'

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
  await page.locator('.page-head').getByRole('link', { name: 'Forecast calendar' }).click()
  await expect(page).toHaveURL(/#\/calendar\/AAPL$/)
  await expect(page.getByRole('heading', { name: 'Price projection' })).toBeVisible()
  await expect(page.locator('[data-symbol="AAPL"] path[data-line="prediction"]')).toHaveAttribute(
    'd',
    /^M.+L/,
  )
  await page.getByLabel('Ticker to compare').fill('msft')
  await page.getByRole('button', { name: 'Add ticker' }).click()
  await expect(page.getByRole('heading', { name: 'Projected returns' })).toBeVisible()
  await expect(page.getByText(/Return from the shared (close|observation) on/)).toBeVisible()
  const presets = page.getByRole('region', { name: 'Forecast settings' })
  let previousEnd = ''
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
    const packet = await response
    expect(packet.ok()).toBe(true)
    const { series } = (await packet.json()) as Projections
    const end = series[0].points.at(-1)!.date
    expect(end > series[0].as_of && end > previousEnd).toBe(true)
    previousEnd = end
    await expect(page.getByRole('slider', { name: 'Inspect timeline date' })).toHaveAttribute(
      'aria-valuetext',
      shortDay(end),
    )
    const rows = page.getByRole('table', { name: 'Prices on inspected date' }).locator('tbody tr')
    await expect(rows).toHaveCount(2)
    for (let row = 0; row < 2; row++) {
      const cells = rows.nth(row).locator('td')
      await expect(cells.nth(0)).toHaveText('—')
      await expect(cells.nth(1)).toHaveText(/\d/)
      await expect(cells.nth(2)).toHaveText(/\d%$/)
    }
    await expect(page.locator('path[data-line="prediction"]')).toHaveCount(2)
    await expect(page.locator('.forecast-plot svg path')).toHaveCount(2)
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
  await expect(page.locator('[data-symbol="MSFT"] path[data-line="prediction"]')).toBeVisible()
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
  await expect(
    page.getByRole('table', { name: 'Prices on inspected date' }).locator('tbody td').nth(1),
  ).not.toHaveText('—')
  const initial = await slider.inputValue()
  await slider.focus()
  await slider.press('Home')
  await expect(slider).not.toHaveValue(initial)
  await slider.press('ArrowRight')
  const second = await slider.inputValue()
  await page.getByRole('button', { name: 'Play timeline' }).click()
  await expect(slider).not.toHaveValue(second)
  await page.getByRole('button', { name: 'Pause timeline' }).click()
  await slider.focus()
  await slider.press('End')
  await expect(slider).toHaveValue('10000')
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
  await page.getByText('How the prediction was calculated').click()
  await expect(page.getByText(/historical returns from/i)).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Yahoo Finance price history', exact: true }),
  ).toBeVisible()
})

test('moves between Future and Calendar with the same multi-year or custom forecast', async ({
  page,
}) => {
  await events(page)
  const eventQueries: URLSearchParams[] = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (url.pathname === '/api/desk/events') eventQueries.push(url.searchParams)
  })
  await page.goto('/#/research/SNDK?view=future&range=2y')
  const link = page
    .getByRole('region', { name: 'Price forecast' })
    .getByRole('link', { name: 'Forecast calendar' })
  await expect(link).toHaveAttribute('href', '#/calendar/SNDK?horizon=2y')
  await link.click()
  const settings = page.getByRole('region', { name: 'Forecast settings' })
  await expect(settings.getByRole('button', { name: '2 years', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const projected = page.waitForResponse(
    (response) =>
      response.url().includes('/api/desk/projections?') &&
      new URL(response.url()).searchParams.get('horizon') === '10y',
  )
  await settings.getByRole('button', { name: '10 years', exact: true }).click()
  const result = (await (await projected).json()) as Projections
  const row = result.series[0]
  await expect(page.getByRole('slider', { name: 'Inspect timeline date' })).toHaveAttribute(
    'aria-valuetext',
    shortDay(row.points.at(-1)!.date),
  )
  await expect.poll(() => eventQueries.some((q) => q.get('end') === row.requested_end)).toBe(true)
  expect(
    eventQueries.every(
      (q) => (Date.parse(q.get('end')!) - Date.parse(q.get('start')!)) / 86400000 <= 2192,
    ),
  ).toBe(true)

  const day = (offset: number) =>
    new Date(Date.parse(row.as_of) + offset * 86400000).toISOString().slice(0, 10)
  const start = day(31),
    end = day(51)
  await settings.getByRole('button', { name: 'Custom', exact: true }).click()
  await settings.getByLabel('Forecast start date').fill(start)
  await settings.getByLabel('Forecast end date').fill(end)
  await settings.getByRole('button', { name: 'Apply dates' }).click()
  await expect
    .poll(() => eventQueries.some((q) => q.get('start') === start && q.get('end') === end))
    .toBe(true)
  await expect(page.getByRole('slider', { name: 'Inspect timeline date' })).toBeVisible()
  const back = page.getByRole('link', { name: 'SNDK Future chart' })
  await expect(back).toHaveAttribute(
    'href',
    '#/research/SNDK?view=future&range=custom&start=' + start + '&end=' + end,
  )
  await back.click()
  await expect(link).toHaveAttribute(
    'href',
    '#/calendar/SNDK?horizon=custom&start=' + start + '&end=' + end,
  )
})
