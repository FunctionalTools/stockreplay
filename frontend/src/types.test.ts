import { afterEach, describe, it, expect, vi } from 'vitest'
import { api, pct, filterEvents, validPinSet, type Config, type Observation } from './types'

afterEach(() => vi.unstubAllGlobals())
describe('research presentation', () => {
  it('distinguishes missing returns and true zero', () => {
    expect(pct(null)).toBe('—')
    expect(pct(0)).toBe('0.00%')
    expect(pct(0.25)).toBe('+0.25%')
    expect(pct(-2)).toBe('-2.00%')
  })
  const events = [
    { signal: '2020-01-10', return_pct: 4, success: true },
    { signal: '2020-01-04', return_pct: -7, success: false },
    { signal: '2020-01-16', return_pct: -0.5, success: false },
  ] as Observation[]
  it('includes all failures worst first', () => {
    expect(filterEvents(events, 'fail', 'worst').map((e) => e.return_pct)).toEqual([-7, -0.5])
    expect(events[0].return_pct).toBe(4)
  })
  it('sorts all observations chronologically', () => {
    expect(filterEvents(events, 'all', 'recent').map((e) => e.return_pct)).toEqual([-0.5, 4, -7])
  })
  const config = {
    source: 'csv',
    tickers: ['MSFT'],
    benchmark: 'SPY',
    start: '2020-01-01',
    end: '2020-12-31',
    entry: { rules: [{ ticker: 'NVDA' }] },
  } as Config
  const result = { config, sources: { SPY: { id: 's' }, NVDA: { id: 'n' }, MSFT: { id: 'm' } } }
  it('pins cross-stock datasets for reproducible reruns', () => {
    expect(validPinSet(config, result)).toEqual({ SPY: 's', NVDA: 'n', MSFT: 'm' })
  })
  it('does not pin across source, symbol, or time changes', () => {
    expect(validPinSet({ ...config, source: 'demo' }, result)).toBeUndefined()
    expect(validPinSet({ ...config, end: '2021-01-01' }, result)).toBeUndefined()
    expect(validPinSet({ ...config, tickers: ['AMD'] }, result)).toBeUndefined()
  })
  it('renders server validation errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ detail: [{ loc: ['body', 'holding'], msg: 'invalid' }] }), {
            status: 422,
          }),
        ),
    )
    await expect(api('/validate', 'POST', {})).rejects.toThrow('holding invalid')
  })
})
