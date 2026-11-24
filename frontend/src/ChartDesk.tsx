import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ColorType,
  createChart,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  type Time,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { Download, Play, Pause, Save } from 'lucide-react'
import { api, errorText } from './types'
import {
  PageHead,
  useResource,
  TickerBar,
  PacketNote,
  FetchState,
  SourceLink,
  fmt,
  type Packet,
  type Navigate,
} from './deskCommon'
import { Field, ErrorBox } from './ui'
import { indicatorsFor, type Bar, type Sample } from './studies'
type Series = {
  symbol: string
  as_of: string
  bars: Bar[]
  source: string
  url: string
  timezone: string
  currency: string | null
  latest_completed_session: string
}
type Drawing = {
  kind: 'horizontal' | 'trend'
  time: number
  price: number
  end_time?: number
  end_price?: number
}
type Layout = {
  interval: string
  span: string
  style: 'Candles' | 'Line' | 'OHLC' | 'Area'
  studies: string[]
  compare: string
  drawings: Drawing[]
}
const defaultLayout: Layout = {
  interval: '1d',
  span: '2y',
  style: 'Candles',
  studies: ['Volume', 'SMA 20'],
  compare: '',
  drawings: [],
}
const ranges: Record<string, string[]> = {
  '1m': ['1d', '5d'],
  '5m': ['5d', '1mo'],
  '15m': ['5d', '1mo'],
  '1h': ['1mo', '3mo', '1y'],
  '1d': ['1mo', '6mo', '1y', '2y', '5y', '10y'],
  '1wk': ['1y', '5y', '10y'],
  '1mo': ['5y', '10y', 'max'],
}
const intervals: Record<string, string> = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '15m': '15 minutes',
  '1h': '1 hour',
  '1d': 'Daily',
  '1wk': 'Weekly',
  '1mo': 'Monthly',
}
const studyNames = [
  'Volume',
  'SMA 20',
  'EMA 50',
  'Bollinger 20',
  'RSI 14',
  'MACD',
  'Dividends & splits',
]
const green = '#79dbb1',
  red = '#e28d91',
  gold = '#ecc378',
  blue = '#87b9ed'
const ts = (v: number) => v as UTCTimestamp
const line = (points: Sample[]) => points.map((p) => ({ ...p, time: ts(p.time) }))
type MountProps = {
  data: Series
  comparison: Series | null
  layout: Layout
  count: number
  draw: string
  pick: (time: number, price: number) => void
  handle: React.RefObject<IChartApi | null>
}
function Canvas({ data, comparison, layout, count, draw, pick, handle }: MountProps) {
  const host = useRef<HTMLDivElement>(null),
    osc = useRef<HTMLDivElement>(null),
    [hover, show] = useState('')
  const drawRef = useRef(draw),
    pickRef = useRef(pick)
  drawRef.current = draw
  pickRef.current = pick
  useEffect(() => {
    const el = host.current
    if (!el) return
    const bars = data.bars.slice(0, count)
    if (!bars.length) return
    const intraday = ['1m', '5m', '15m', '1h'].includes(layout.interval)
    const zone = intraday ? data.timezone || 'UTC' : 'UTC'
    const formatter = (opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-US', { timeZone: zone, ...opts })
    const clock = formatter({ hour: '2-digit', minute: '2-digit', hour12: false }),
      day = formatter({ month: 'short', day: 'numeric' }),
      month = formatter({ month: 'short' }),
      year = formatter({ year: 'numeric' }),
      full = formatter(
        intraday ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' },
      )
    const tick = (time: Time, kind: TickMarkType) => {
      if (typeof time !== 'number') return null
      const value = new Date(time * 1000)
      return (
        kind === TickMarkType.Year
          ? year
          : kind === TickMarkType.Month
            ? month
            : kind === TickMarkType.DayOfMonth
              ? day
              : clock
      ).format(value)
    }
    const options = {
      width: el.clientWidth,
      height: 400,
      layout: {
        background: { type: ColorType.Solid, color: '#11171c' },
        textColor: '#aab8bd',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#1c262d' },
        horzLines: { color: '#253039' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: {
        timeFormatter: (t: Time) => (typeof t === 'number' ? full.format(t * 1000) : String(t)),
      },
      timeScale: {
        tickMarkFormatter: tick,
        timeVisible: intraday,
        secondsVisible: false,
        borderColor: '#283139',
      },
      rightPriceScale: { borderVisible: false },
      handleScroll: { vertTouchDrag: false },
    }
    const chart = createChart(el, options)
    handle.current = chart
    const candles = {
      upColor: green,
      downColor: red,
      borderVisible: false,
      wickUpColor: green,
      wickDownColor: red,
    }
    const base =
      layout.style === 'Line'
        ? chart.addLineSeries({ color: green, lineWidth: 2 })
        : layout.style === 'Area'
          ? chart.addAreaSeries({
              lineColor: green,
              topColor: '#245b49',
              bottomColor: 'rgba(17,23,28,0.1)',
            })
          : layout.style === 'OHLC'
            ? chart.addBarSeries({ upColor: green, downColor: red })
            : chart.addCandlestickSeries(candles)
    base.setData(
      bars.map((b) => ({
        time: ts(b.time),
        open: b.open,
        close: b.close,
        high: b.high,
        low: b.low,
        value: b.close,
      })),
    )
    if (layout.studies.includes('Volume')) {
      const volume = chart.addHistogramSeries({
        priceScaleId: 'volume',
        priceFormat: { type: 'volume' },
        lastValueVisible: false,
        priceLineVisible: false,
      })
      volume.setData(
        bars
          .filter((b) => b.volume != null)
          .map((b) => ({
            time: ts(b.time),
            value: b.volume!,
            color: b.close >= b.open ? '#315c4d' : '#63454c',
          })),
      )
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
      base.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.2 } })
    }
    const studies = indicatorsFor(bars)
    function overlay(points: Sample[], color: string, title: string, sub: IChartApi = chart) {
      sub
        .addLineSeries({
          color,
          title,
          lineWidth: 1,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        })
        .setData(line(points))
    }
    if (layout.studies.includes('SMA 20')) overlay(studies.sma, gold, 'SMA 20')
    if (layout.studies.includes('EMA 50')) overlay(studies.ema, blue, 'EMA 50')
    if (layout.studies.includes('Bollinger 20')) {
      overlay(studies.upper, '#a99bd7', 'BB upper')
      overlay(studies.lower, '#a99bd7', 'BB lower')
    }
    if (layout.studies.includes('Dividends & splits'))
      base.setMarkers(
        bars
          .filter((b) => b.dividend || b.split)
          .map((b) => ({
            time: ts(b.time),
            position: 'belowBar',
            shape: 'circle',
            color: gold,
            text: [
              b.dividend ? 'D ' + fmt(b.dividend, 4) : '',
              b.split ? 'Split ×' + fmt(b.split) : '',
            ]
              .filter(Boolean)
              .join(' '),
          })),
      )
    if (comparison) {
      const shared = new Map(bars.map((b) => [b.time, b.close])),
        match = comparison.bars.filter((b) => shared.has(b.time))
      if (match.length) {
        const factor = shared.get(match[0].time)! / match[0].close
        overlay(
          match.map((b) => ({ time: b.time, value: b.close * factor })),
          blue,
          comparison.symbol + ' rebased',
        )
      }
    }
    for (const d of layout.drawings) {
      if (d.time > bars[bars.length - 1].time) continue
      if (d.kind === 'horizontal') {
        base.createPriceLine({
          price: d.price,
          color: gold,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'Level',
        })
      } else if (
        d.end_time != null &&
        d.end_price != null &&
        d.time !== d.end_time &&
        d.end_time <= bars[bars.length - 1].time
      ) {
        overlay(
          [
            { time: d.time, value: d.price },
            { time: d.end_time, value: d.end_price },
          ].sort((a, b) => a.time - b.time),
          gold,
          'Trend',
        )
      }
    }
    chart.subscribeClick((e) => {
      if (!drawRef.current || typeof e.time !== 'number' || !e.point) return
      const p = base.coordinateToPrice(e.point.y)
      if (p != null) pickRef.current(e.time, Number(p))
    })
    const byTime = new Map(bars.map((b) => [b.time, b]))
    chart.subscribeCrosshairMove((e) => {
      const b = byTime.get(Number(e.time))
      show(
        b
          ? 'O ' +
              fmt(b.open) +
              '   H ' +
              fmt(b.high) +
              '   L ' +
              fmt(b.low) +
              '   C ' +
              fmt(b.close)
          : '',
      )
    })
    const panes: IChartApi[] = []
    for (const name of ['RSI 14', 'MACD'].filter((v) => layout.studies.includes(v))) {
      if (!osc.current) continue
      const subEl = document.createElement('div')
      subEl.dataset.study = name
      osc.current.appendChild(subEl)
      const sub = createChart(subEl, {
        ...options,
        height: 105,
        timeScale: { visible: false },
      })
      panes.push(sub)
      if (name === 'RSI 14') overlay(studies.rsi, '#bb9be7', name, sub)
      else {
        overlay(studies.macd, blue, 'MACD', sub)
        overlay(studies.signal, gold, 'Signal', sub)
      }
    }
    const sync = () => {
      const range = chart.timeScale().getVisibleRange()
      if (range)
        panes.forEach((p) => {
          if (p.timeScale().getVisibleLogicalRange()) p.timeScale().setVisibleRange(range)
        })
    }
    chart.timeScale().fitContent()
    panes.forEach((p) => p.timeScale().fitContent())
    sync()
    chart.timeScale().subscribeVisibleLogicalRangeChange(sync)
    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth })
      panes.forEach((p) => p.applyOptions({ width: el.clientWidth }))
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(sync)
      chart.remove()
      handle.current = null
      panes.forEach((p) => p.remove())
      osc.current?.replaceChildren()
    }
  }, [data, comparison, layout, count, handle])
  return (
    <>
      <div className="chart-legend" aria-live="off">
        {hover || 'Move the crosshair to inspect a bar.'}
      </div>
      <div className={'desk-chart ' + (draw ? 'drawing' : '')} ref={host} />
      <div ref={osc} />
    </>
  )
}
export function ChartDesk({
  symbol,
  select,
  go,
}: {
  symbol: string
  select: (s: string) => void
  go: Navigate
}) {
  const [layout, set] = useState<Layout>(defaultLayout),
    [ready, setReady] = useState(false),
    [compare, compareInput] = useState(''),
    [draw, tool] = useState(''),
    [start, first] = useState<{ time: number; price: number } | null>(null),
    [cursor, seek] = useState<number | null>(null),
    [playing, play] = useState(false),
    [note, show] = useState(''),
    [error, setErr] = useState(''),
    handle = useRef<IChartApi | null>(null)
  useEffect(() => {
    let active = true
    void api<Layout | null>('/desk/layout/' + encodeURIComponent(symbol))
      .then((c) => {
        if (active && c) {
          set(c)
          compareInput(c.compare)
        }
      })
      .catch((e) => {
        if (active) setErr(errorText(e))
      })
      .finally(() => {
        if (active) setReady(true)
      })
    return () => {
      active = false
    }
  }, [symbol])
  const query = '?interval=' + layout.interval + '&span=' + layout.span
  const series = useResource<Packet<Series>>(
      ready ? '/desk/chart/' + encodeURIComponent(symbol) + query : null,
    ),
    comp = useResource<Packet<Series>>(
      ready && layout.compare ? '/desk/chart/' + encodeURIComponent(layout.compare) + query : null,
    )
  const data = series.data?.data,
    total = data?.bars.length || 0,
    count = cursor == null ? total : Math.min(total, cursor),
    b = data?.bars[count - 1]
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => seek((c) => Math.min(total, (c ?? 0) + 1)), 450)
    return () => clearInterval(id)
  }, [playing, total])
  useEffect(() => {
    if (playing && count >= total) play(false)
  }, [playing, count, total])
  const change = (patch: Partial<Layout>) => {
    set((v) => ({ ...v, ...patch }))
    show('')
    if (patch.interval || patch.span) {
      seek(null)
      play(false)
    }
  }
  const pick = useCallback(
    (time: number, price: number) => {
      if (draw === 'horizontal') {
        set((l) => ({
          ...l,
          drawings: [...l.drawings, { kind: 'horizontal', time, price }],
        }))
        tool('')
      } else if (draw === 'trend') {
        if (!start) {
          first({ time, price })
          show('Select the second point on the chart.')
        } else if (time !== start.time) {
          set((l) => ({
            ...l,
            drawings: [
              ...l.drawings,
              { kind: 'trend', ...start, end_time: time, end_price: price },
            ],
          }))
          first(null)
          tool('')
          show('')
        }
      }
    },
    [draw, start],
  )
  function png() {
    if (!handle.current) return
    const a = document.createElement('a')
    a.href = handle.current.takeScreenshot().toDataURL('image/png')
    a.download = symbol + '-' + layout.interval + '.png'
    a.click()
  }
  return (
    <>
      <PageHead
        title="Charts"
        description="Explore adjusted market prices, indicators, comparisons and bar-by-bar replay."
      >
        <button className="btn" onClick={() => go('TradingView tools', symbol)}>
          TradingView tools ↗
        </button>
      </PageHead>
      <TickerBar
        symbol={symbol}
        select={select}
        refresh={() => {
          series.reload(true)
          if (layout.compare) comp.reload(true)
        }}
        busy={series.loading}
      />
      <section className="panel desk-card">
        <div className="desk-toolbar">
          <Field name="Chart interval">
            <select
              value={layout.interval}
              onChange={(e) =>
                change({
                  interval: e.target.value,
                  span: ranges[e.target.value][0],
                })
              }
            >
              {Object.entries(intervals).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field name="Chart range">
            <select value={layout.span} onChange={(e) => change({ span: e.target.value })}>
              {ranges[layout.interval].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          <Field name="Chart style">
            <select
              value={layout.style}
              onChange={(e) => change({ style: e.target.value as Layout['style'] })}
            >
              {['Candles', 'Line', 'OHLC', 'Area'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              change({ compare: compare.toUpperCase().trim() })
            }}
          >
            <Field name="Compare ticker">
              <input
                maxLength={20}
                placeholder="e.g. SPY"
                value={compare}
                onChange={(e) => compareInput(e.target.value)}
              />
            </Field>
            <button className="btn">Apply comparison</button>
          </form>
        </div>
        <div className="study-options">
          {studyNames.map((s) => (
            <label key={s}>
              <input
                type="checkbox"
                checked={layout.studies.includes(s)}
                onChange={() =>
                  change({
                    studies: layout.studies.includes(s)
                      ? layout.studies.filter((v) => v !== s)
                      : [...layout.studies, s],
                  })
                }
              />
              {s}
            </label>
          ))}
        </div>
        <FetchState {...series} />
        <ErrorBox text={error || comp.error} />
        {series.data && <PacketNote p={series.data} />} {comp.data && <PacketNote p={comp.data} />}
        {data && b && (
          <>
            <div className="security-head">
              <div>
                <small>
                  {data.symbol} · {intervals[layout.interval]} · {data.source}
                </small>
                <h2>
                  {fmt(b.close)} <small>{data.currency || ''}</small>
                </h2>
                <p>
                  {cursor == null ? 'Latest displayed bar' : 'Replay bar'} · {b.date} ·{' '}
                  {data.timezone}
                  {layout.compare ? ' · ' + layout.compare + ' rebased at first shared close' : ''}
                </p>
              </div>
              <button className="icon-btn" aria-label="Export price chart PNG" onClick={png}>
                <Download size={16} />
              </button>
            </div>
            <Canvas
              data={data}
              comparison={comp.data?.data || null}
              count={count}
              layout={layout}
              draw={draw}
              pick={pick}
              handle={handle}
            />
            <div className="desk-toolbar replay">
              <button
                className="btn"
                onClick={() => {
                  if (cursor == null || count >= total) seek(Math.max(1, Math.floor(total / 3)))
                  play(!playing)
                }}
              >
                {playing ? <Pause size={14} /> : <Play size={14} />}{' '}
                {playing ? 'Pause' : 'Play replay'}
              </button>
              <input
                aria-label="Replay bar"
                type="range"
                min="1"
                max={total}
                value={count}
                onChange={(e) => {
                  play(false)
                  seek(Number(e.target.value))
                }}
              />
              <span>
                {count} / {total}
              </span>
              <button
                className="btn small"
                onClick={() => {
                  play(false)
                  seek(null)
                }}
              >
                Latest
              </button>
            </div>
            <div className="desk-toolbar">
              {(['horizontal', 'trend'] as const).map((v) => (
                <button
                  key={v}
                  className={'btn small ' + (draw === v ? 'primary' : '')}
                  aria-pressed={draw === v}
                  onClick={() => {
                    first(null)
                    tool(draw === v ? '' : v)
                    show(
                      draw === v
                        ? ''
                        : 'Select ' +
                            (v === 'trend' ? 'two points' : 'a price level') +
                            ' on the chart.',
                    )
                  }}
                >
                  {v === 'trend' ? 'Trend line' : 'Horizontal level'}
                </button>
              ))}
              <button
                className="btn small"
                disabled={!layout.drawings.length}
                onClick={() => change({ drawings: layout.drawings.slice(0, -1) })}
              >
                Undo drawing
              </button>
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await api('/desk/layout/' + encodeURIComponent(symbol), 'PUT', layout)
                    show('Chart layout saved on this Mac.')
                  } catch (e) {
                    setErr(errorText(e))
                  }
                }}
              >
                <Save size={14} />
                Save layout
              </button>
            </div>
            <p role="status">{note}</p>
            <SourceLink url={data.url}>{data.source} market history</SourceLink> ·{' '}
            <SourceLink url="https://www.tradingview.com/lightweight-charts/">
              Lightweight Charts by TradingView
            </SourceLink>
          </>
        )}
      </section>
    </>
  )
}
