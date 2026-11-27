import { describe, expect, it } from 'vitest'
import {
  calendarHref,
  calendarSelection,
  latestSharedClose,
  type Forecast,
} from './forecastCalendar'

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
})
