import { expect, it } from 'vitest'
import {
  fromFutureFocus,
  futureHref,
  modelEventMarkers,
  quarterMarkers,
  selectedFuture,
  type ForecastSnapshot,
} from './forecastSnapshot'

it('uses the civil forecast horizon for sourced non-trading events and preserves their meaning', () => {
  const source = {
    id: 'S1',
    title: 'Q1 FY 2027',
    source: 'Issuer',
    date: '2026-12-26',
    url: 'https://example.org/fiscal',
    kind: 'fiscal',
    date_basis: 'event',
  }
  const f = {
    symbol: 'AAPL',
    range: '1mo',
    created: '2026-11-28T01:00:00Z',
    as_of: '2026-11-27',
    requested_end: '2026-12-27',
    points: [{ date: '2026-12-24' }],
    sources: [
      source,
      { ...source, id: 'S2', date_basis: 'retrieved' },
      { ...source, id: 'S3', date: '2026-12-29' },
    ],
    quarters: [
      {
        quarter: 'Q1',
        date: '2026-12-26',
        period: 'Q1 FY 2027',
        date_kind: 'period_end',
        expectation: 'Seasonal demand.',
        timing: 'estimated',
        source_ids: ['S1'],
      },
    ],
    drivers: [],
  } as unknown as ForecastSnapshot
  expect(quarterMarkers(f).map((e) => [e.date, e.status, e.url])).toEqual([
    ['2026-12-26', 'estimated', 'https://example.org/fiscal'],
  ])
  expect(modelEventMarkers(f).map((e) => e.id)).toEqual(['saved-AAPL-S1'])
})
it('preserves assistant-selected and custom horizons on the homepage Future route', () => {
  const sel = fromFutureFocus('future_custom_2027-01-05_2027-01-20')!
  const href = futureHref('AAPL', sel.preset, sel.start, sel.end, ['MSFT'])
  expect(href).toBe(
    '#/research/AAPL?view=future&range=custom&start=2027-01-05&end=2027-01-20&compare=MSFT',
  )
  expect(selectedFuture(href.split('?')[1])).toEqual(sel)
  expect(fromFutureFocus('future')).toEqual({ preset: '6mo' })
  expect(fromFutureFocus('future_1w')).toEqual({ preset: '1w' })
  expect(fromFutureFocus('future_custom_2027-02-30_2027-03-03')).toBeNull()
})
