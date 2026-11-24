import { describe, expect, it } from 'vitest'
import { ema, indicatorsFor, type Bar } from './studies'
const bars = (n: number) => Array.from({ length: n }, (_, i) => ({ time: i, close: i + 1 }) as Bar)
describe('chart studies', () => {
  it('seeds EMA using only completed observations', () => {
    expect(
      ema(
        [
          { time: 1, value: 1 },
          { time: 2, value: 2 },
          { time: 3, value: 3 },
        ],
        2,
      ),
    ).toEqual([
      { time: 2, value: 1.5 },
      { time: 3, value: 2.5 },
    ])
  })
  it('keeps lookahead out of replay and respects warmups', () => {
    const a = indicatorsFor(bars(20)),
      b = indicatorsFor(bars(100))
    expect(a.sma).toEqual([{ time: 19, value: 10.5 }])
    expect(a.sma).toEqual(b.sma.slice(0, 1))
    expect(a.rsi[0]).toEqual({ time: 14, value: 100 })
    expect(b.macd[0].time).toBe(25)
    expect(b.signal[0].time).toBe(33)
  })
})
