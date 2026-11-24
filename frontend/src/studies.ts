export type Bar = {
  time: number
  date: string
  open: number
  high: number
  low: number
  close: number
  raw_close: number
  volume: number | null
  dividend: number
  split: number
}
export type Sample = { time: number; value: number }
export function ema(input: Sample[], n: number): Sample[] {
  if (input.length < n) return []
  let avg = input.slice(0, n).reduce((s, x) => s + x.value, 0) / n
  const out = [{ time: input[n - 1].time, value: avg }],
    alpha = 2 / (n + 1)
  for (const p of input.slice(n)) {
    avg += alpha * (p.value - avg)
    out.push({ time: p.time, value: avg })
  }
  return out
}
export function indicatorsFor(bars: Bar[]) {
  const price = bars.map((b) => ({ time: b.time, value: b.close })),
    sma: Sample[] = [],
    upper: Sample[] = [],
    lower: Sample[] = [],
    rsi: Sample[] = []
  let gains = 0,
    losses = 0
  for (let i = 0; i < bars.length; i++) {
    if (i >= 19) {
      const window = price.slice(i - 19, i + 1),
        avg = window.reduce((s, v) => s + v.value, 0) / 20,
        sd = Math.sqrt(window.reduce((s, v) => s + (v.value - avg) ** 2, 0) / 20)
      sma.push({ time: bars[i].time, value: avg })
      upper.push({ time: bars[i].time, value: avg + 2 * sd })
      lower.push({ time: bars[i].time, value: avg - 2 * sd })
    }
    if (i) {
      const change = bars[i].close - bars[i - 1].close,
        up = Math.max(0, change),
        down = Math.max(0, -change)
      if (i <= 14) {
        gains += up / 14
        losses += down / 14
      } else {
        gains = (13 * gains + up) / 14
        losses = (13 * losses + down) / 14
      }
      if (i >= 14)
        rsi.push({
          time: bars[i].time,
          value: gains + losses === 0 ? 50 : (100 * gains) / (gains + losses),
        })
    }
  }
  const fast = new Map(ema(price, 12).map((p) => [p.time, p.value])),
    macd = ema(price, 26).map((p) => ({
      time: p.time,
      value: fast.get(p.time)! - p.value,
    }))
  return {
    sma,
    upper,
    lower,
    ema: ema(price, 50),
    rsi,
    macd,
    signal: ema(macd, 9),
  }
}
