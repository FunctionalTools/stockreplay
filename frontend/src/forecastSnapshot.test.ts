import { expect, it } from 'vitest'
import {
  fromFutureFocus,
  matchesProjection,
  projectionPath,
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
  const consensus = {
    ...source,
    id: 'estimate',
    kind: 'consensus',
    url: 'https://example.org/estimates',
    source: 'Consensus publisher',
  }
  const article = {
    ...source,
    id: 'coverage',
    kind: 'company_news',
    url: 'https://example.org/news',
    source: 'Research publisher',
  }
  f.sources.unshift(consensus, article)
  f.quarters[0].source_ids = [article.id, 'S1', consensus.id]
  f.quarters[0].consensus = [
    { metric: 'EPS', value: 2.3, unit: 'USD', period: '2026-12-26', source_id: consensus.id },
  ]
  expect(quarterMarkers(f)[0].sources).toEqual([
    { label: 'Fiscal date', publisher: source.source, url: source.url },
    { label: 'Consensus', publisher: consensus.source, url: consensus.url },
    { label: 'Forecast evidence', publisher: article.source, url: article.url },
  ])
  f.quarters[0].source_ids = [article.id, consensus.id]
  expect(quarterMarkers(f)).toEqual([])
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

it('uses only saved AI paths anchored to the same price, target session and observation time', () => {
  const base = {
    symbol: 'SNDK',
    as_of: '2026-11-27',
    points: [
      { date: '2026-11-27', median: 99 },
      { date: '2026-11-30', median: 100 },
    ],
  } as ForecastSnapshot
  expect(matchesProjection(base, { ...base, anchor_kind: 'confirmed_close' })).toBe(true)
  expect(
    matchesProjection(base, {
      ...base,
      points: [...base.points, { date: '2026-12-01', median: 101, low: 100, high: 102 }],
    }),
  ).toBe(false)
  expect(matchesProjection(base, { ...base, as_of: '2026-11-30' })).toBe(false)
  expect(
    matchesProjection(base, {
      ...base,
      points: [{ ...base.points[0], median: 101 }, base.points[1]],
    }),
  ).toBe(false)
  const quote = {
    ...base,
    anchor_kind: 'intraday' as const,
    anchor_time: '2026-11-27T10:00:00-05:00',
  }
  expect(matchesProjection(base, quote)).toBe(false)
  expect(matchesProjection(quote, { ...quote, anchor_time: '2026-11-27T10:01:00-05:00' })).toBe(
    false,
  )
  expect(matchesProjection(quote, quote)).toBe(true)
  expect(
    projectionPath(['SNDK', 'AMD'], { preset: 'custom', start: '2026-12-01', end: '2026-12-15' }),
  ).toBe(
    '/desk/projections?symbols=SNDK%2CAMD&horizon=custom&seed=42&start=2026-12-01&end=2026-12-15',
  )
})
