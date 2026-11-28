import { describe, expect, it } from 'vitest'
import {
  calendarHref,
  calendarSelection,
  eventPeriod,
  eventPaths,
  forecastInspectionDate,
  latestSharedClose,
  type Forecast,
} from './forecastData'

const history = (dates: string[]) =>
  ({ history: dates.map((date, i) => ({ date, price: 10 + i })) }) as Forecast

describe('forecast comparisons', () => {
  it('anchors on a shared observed session across exchanges', () => {
    const us = history(['2026-11-24', '2026-11-25', '2026-11-27'])
    const tokyo = history(['2026-11-24', '2026-11-25', '2026-11-26'])
    expect(latestSharedClose([us, tokyo])).toBe('2026-11-25')
    expect(latestSharedClose([tokyo, us])).toBe('2026-11-25')
    expect(latestSharedClose([us, history(['2026-11-26'])])).toBeNull()
  })
  it('restores ordered, unique ticker selections from a shared calendar URL', () => {
    const s = calendarSelection('brk-b', 'symbols=brk-b,7203.T,%5EGSPC,BRK-B&horizon=5y')
    expect(s).toEqual({ symbols: ['BRK-B', '7203.T', '^GSPC'], horizon: '5y' })
    const [path, q] = calendarHref(s).split('?')
    expect(calendarSelection(decodeURIComponent(path.split('/')[2]), q)).toEqual(s)
    expect(
      calendarSelection('SPY', 'symbols=A,B,C,D,E,F,G,H,I,J&horizon=constructor').symbols.length,
    ).toBe(8)
    expect(calendarSelection('SPY', 'horizon=constructor').horizon).toBe('1mo')
  })
  it('inspects the latest common projected price, or the primary forecast on a market holiday', () => {
    const projected = (anchor: string, days: string[]) =>
      ({ as_of: anchor, points: [anchor, ...days].map((date) => ({ date })) }) as Forecast
    const stock = projected('2026-11-25', ['2026-11-27', '2026-11-30'])
    expect(forecastInspectionDate([stock])).toBe('2026-11-30')
    expect(forecastInspectionDate([stock, projected('2026-11-26', ['2026-11-27'])])).toBe(
      '2026-11-27',
    )
    expect(forecastInspectionDate([stock, projected('2026-11-26', ['2026-12-01'])])).toBe(
      '2026-11-30',
    )
  })
  it('keeps event dates at the selected horizon when the observed quote predates it', () => {
    const row = {
      as_of: '2026-11-24',
      horizon_origin: '2026-11-27',
      requested_end: '2026-12-27',
      points: [{ date: '2026-11-24' }, { date: '2026-12-24' }],
    } as Forecast
    expect(eventPeriod([row])).toEqual({ start: '2026-11-27', end: '2026-12-27' })
  })
  it('preserves each homepage horizon and splits ten-year event requests without a missing day', () => {
    for (const horizon of ['5d', '3mo', 'ytd', '2y', '10y', 'max'] as const) {
      expect(calendarSelection('SNDK', 'horizon=' + horizon)).toEqual({
        symbols: ['SNDK'],
        horizon,
      })
    }
    const selection = {
      symbols: ['SNDK', 'MSFT'],
      horizon: 'custom' as const,
      start: '2027-01-12',
      end: '2037-01-12',
    }
    const [, query] = calendarHref(selection).split('?')
    expect(calendarSelection('SNDK', query)).toEqual(selection)
    const [a, b] = eventPaths(selection.symbols, selection.start, selection.end)
    expect(a).toContain('start=2027-01-12&end=2032-01-12')
    expect(b).toContain('start=2032-01-13&end=2037-01-12')
    expect(eventPaths(['SNDK'], '2027-01-01', '2027-01-31')[1]).toBeNull()
  })
})
