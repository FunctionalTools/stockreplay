import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type Time,
} from 'lightweight-charts'
import { ChartCandlestick, Download, ExternalLink, Focus } from 'lucide-react'
import { type Result, type Observation, sourceName, money, pct } from './types'
import { Empty } from './ui'

const palette = {
  background: '#11171c',
  grid: '#20282f',
  tick: '#92a0aa',
  up: '#7adbb0',
  down: '#da898c',
  benchmark: '#8aabce',
}
export function Candles({
  r,
  symbol,
  windowSize,
  focus,
  signals,
  chartRef,
}: {
  r: Result
  symbol: string
  windowSize: number
  focus?: Observation
  signals: boolean
  chartRef: React.MutableRefObject<IChartApi | null>
}) {
  const mount = useRef<HTMLDivElement>(null)
  const [quote, setQuote] = useState('')
  useEffect(() => {
    const host = mount.current!,
      history = r.candles[symbol]
    if (!history?.length) return
    const signalAt = focus ? history.findIndex((bar) => bar.time === focus.signal) : -1
    const exitAt = focus ? history.findIndex((bar) => bar.time === focus.exit) : -1
    const data = focus ? history.slice(Math.max(0, signalAt - 12), exitAt + 13) : history
    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: palette.background },
        textColor: palette.tick,
        fontSize: 10,
        fontFamily: 'IBM Plex Mono, monospace',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#1a232a' },
        horzLines: { color: palette.grid, style: LineStyle.Dotted },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.16, bottom: 0.12 } },
      timeScale: { borderColor: palette.grid, rightOffset: 3, fixLeftEdge: true },
      handleScroll: { vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    })
    chartRef.current = chart
    const candles = chart.addCandlestickSeries({
      upColor: palette.up,
      downColor: palette.down,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
      borderVisible: false,
      priceLineStyle: LineStyle.Dashed,
      priceLineColor: '#527c6b',
      priceLineWidth: 1,
      priceLineVisible: !focus,
      lastValueVisible: !focus,
    })
    candles.setData(data.map((k) => ({ ...k, time: k.time as Time })))
    const markers = focus
      ? [
          {
            time: focus.signal as Time,
            position: 'aboveBar' as const,
            color: '#f1c576',
            shape: 'arrowDown' as const,
            text: 'Signal',
          },
          {
            time: focus.entry as Time,
            position: 'belowBar' as const,
            color: palette.up,
            shape: 'arrowUp' as const,
            text: 'Entry',
          },
          {
            time: focus.exit as Time,
            position: 'aboveBar' as const,
            color: palette.benchmark,
            shape: 'circle' as const,
            text: 'Exit',
          },
        ]
      : signals
        ? r.events
            .filter((e) => e.ticker === symbol)
            .map((e) => ({
              time: e.signal as Time,
              position: 'belowBar' as const,
              shape: 'circle' as const,
              color: '#dfbb7a',
              size: 0.5,
            }))
        : []
    candles.setMarkers(markers)
    if (focus || windowSize === 0) chart.timeScale().fitContent()
    else
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, data.length - windowSize),
        to: data.length + 2,
      })
    const format = (v: { open: number; high: number; low: number; close: number }) =>
      'O ' +
      money(v.open) +
      '   H ' +
      money(v.high) +
      '   L ' +
      money(v.low) +
      '   C ' +
      money(v.close)
    const baseQuote = focus ? history[signalAt] : data[data.length - 1]
    const latest = baseQuote.time + '   ' + format(baseQuote)
    setQuote(latest)
    chart.subscribeCrosshairMove((p) => {
      const point = p.seriesData.get(candles)
      setQuote(
        point && 'open' in point
          ? (typeof p.time === 'string' ? p.time + '   ' : '') + format(point)
          : latest,
      )
    })
    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: host.clientWidth, height: host.clientHeight })
      if (focus && host.clientWidth > 0) chart.timeScale().fitContent()
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [r.id, r.candles, r.events, symbol, windowSize, focus, signals, chartRef])
  return (
    <div className="candle-wrap">
      <div className="ohlc" aria-hidden="true">
        {quote}
      </div>
      <div
        ref={mount}
        className="candle-host"
        aria-label={symbol + ' interactive daily candlestick chart'}
      />
    </div>
  )
}

function Plot({
  r,
  tab,
  plotRef,
}: {
  r: Result
  tab: string
  plotRef: React.MutableRefObject<HTMLDivElement | null>
}) {
  useEffect(() => {
    const node = plotRef.current!
    let active = true,
      dispose = () => {}
    import('plotly.js-basic-dist-min').then(async ({ default: P }) => {
      if (!active) return
      const histogram = tab === 'Distribution'
      const traces = histogram
        ? [
            {
              type: 'bar',
              x: r.distribution.map((b) => (b.low + b.high) / 2),
              y: r.distribution.map((b) => b.count),
              width: r.distribution.map((b) => (b.high - b.low) * 0.96),
              customdata: r.distribution.map((b) => [b.low, b.high]),
              name: 'Observations',
              marker: { color: palette.up, line: { width: 1, color: palette.background } },
              hovertemplate:
                '%{customdata[0]:.2f}% to %{customdata[1]:.2f}%<br>%{y} observations<extra></extra>',
            },
          ]
        : ['strategy', 'benchmark'].map((k, i) => ({
            type: 'scatter',
            mode: 'lines+markers',
            marker: { size: r.curve.length > 100 ? 0 : 5 },
            line: { width: 2, color: i ? palette.benchmark : palette.up },
            name: i ? r.config.benchmark : 'Strategy',
            x: r.curve.map((e) => (r.config.kind === 'portfolio' ? e.x : Number(e.x))),
            y: r.curve.map((e) => e[k as 'strategy' | 'benchmark']),
            hovertemplate: '%{y:.2f}%<extra>%{fullData.name}</extra>',
          }))
      await P.newPlot(
        node,
        traces,
        {
          paper_bgcolor: palette.background,
          plot_bgcolor: palette.background,
          margin: { l: 54, r: 18, t: 16, b: 48 },
          font: { color: palette.tick, family: 'DM Sans Variable, sans-serif', size: 11 },
          showlegend: !histogram,
          legend: { orientation: 'h', x: 0, y: 1.12 },
          bargap: 0.05,
          hovermode: histogram ? 'closest' : 'x unified',
          xaxis: {
            gridcolor: palette.grid,
            title: {
              text: histogram
                ? 'Net return (%)'
                : r.config.kind === 'portfolio'
                  ? 'Session'
                  : 'Sessions after entry',
            },
          },
          yaxis: {
            gridcolor: palette.grid,
            zerolinecolor: '#4c5964',
            ticksuffix: histogram ? '' : '%',
            title: { text: histogram ? 'Count' : '' },
          },
        },
        { displayModeBar: false, responsive: true },
      )
      if (!active) {
        P.purge(node)
        return
      }
      const ro = new ResizeObserver(() => P.Plots.resize(node))
      ro.observe(node)
      dispose = () => {
        ro.disconnect()
        P.purge(node)
      }
    })
    return () => {
      active = false
      dispose()
    }
  }, [r, tab, plotRef])
  return <div className="plot-host" ref={plotRef} aria-label={tab + ' chart'} />
}

export function ChartPanel({ r, focus }: { r: Result; focus?: Observation }) {
  const [tab, setTab] = useState('Price history'),
    [asset, setAsset] = useState(r.config.tickers[0]),
    [range, setRange] = useState(126),
    [signals, setSignals] = useState(false)
  const chart = useRef<IChartApi | null>(null),
    plot = useRef<HTMLDivElement | null>(null)
  const symbol = focus?.ticker || (r.config.tickers.includes(asset) ? asset : r.config.tickers[0]),
    path = r.config.kind === 'portfolio' ? 'Equity curve' : 'Event path'
  async function download() {
    if (tab === 'Price history') {
      const canvas = chart.current?.takeScreenshot()
      if (!canvas) return
      const a = document.createElement('a')
      a.download = 'stockreplay-' + symbol + '.png'
      a.href = canvas.toDataURL()
      a.click()
    } else if (plot.current) {
      const { default: P } = await import('plotly.js-basic-dist-min')
      await P.downloadImage(plot.current, { format: 'svg', filename: 'stockreplay-' + tab })
    }
  }
  return (
    <section className="panel chart-panel">
      <div className="chart-tabs">
        {focus ? (
          <h3>
            <ChartCandlestick size={17} />
            Event inspection
          </h3>
        ) : (
          <div className="tabs" aria-label="Chart view">
            {['Price history', path, 'Distribution'].map((t) => (
              <button className={tab === t ? 'selected' : ''} key={t} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
        )}
        <button
          title="Download chart"
          aria-label="Download chart"
          className="icon-btn"
          onClick={download}
        >
          <Download size={15} />
        </button>
      </div>
      {tab === 'Price history' ? (
        <>
          <div className="chart-labels">
            <div className="inline">
              {r.config.tickers.length > 1 && !focus ? (
                <select
                  aria-label="Chart symbol"
                  value={symbol}
                  onChange={(e) => setAsset(e.target.value)}
                >
                  {r.config.tickers.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              ) : (
                <strong>{symbol}</strong>
              )}
              <span className="muted">/</span>
              <span className="muted">Daily candles</span>
            </div>
            {!focus && (
              <div className="seg mini">
                {(
                  [
                    ['3M', 63],
                    ['6M', 126],
                    ['1Y', 252],
                    ['All', 0],
                  ] as const
                ).map(([n, v]) => (
                  <button key={n} className={range === v ? 'on' : ''} onClick={() => setRange(v)}>
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Candles
            r={r}
            symbol={symbol}
            focus={focus}
            windowSize={range}
            signals={signals}
            chartRef={chart}
          />
          <div className="chart-foot">
            <span className="inline">
              <i className="dot" />
              Adjusted USD · {sourceName[r.config.source]}
            </span>
            {!focus && (
              <button
                className={'text-btn ' + (signals ? 'positive' : '')}
                aria-pressed={signals}
                onClick={() => setSignals(!signals)}
              >
                <Focus size={13} />
                Signals {signals ? 'on' : 'off'}
              </button>
            )}
            <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
              TradingView <ExternalLink size={9} />
            </a>
          </div>
        </>
      ) : r.events.length ? (
        <Plot r={r} tab={tab} plotRef={plot} />
      ) : (
        <Empty
          title="No qualifying events"
          body="Adjust the entry rules or date range to plot results."
        />
      )}
    </section>
  )
}

export function Confidence({ r }: { r: Result }) {
  const i = r.inference,
    m = r.metrics
  const span = Math.max(Math.abs(m.mean || 0), Math.abs(m.benchmark || 0), 0.01)
  return (
    <section className="panel confidence">
      <h3>Evidence summary</h3>
      <div className="comparison-bars">
        <div className="eyeline">Matched returns</div>
        {[
          [r.config.tickers.join(' / '), m.mean, 'asset'],
          [r.config.benchmark, m.benchmark, 'bench'],
        ].map(([s, n, k]) => (
          <div key={k} className="bar-row">
            <div>
              <span>
                <i className={'swatch ' + k} />
                {s}
              </span>
              <b>{pct(n as number | null)}</b>
            </div>
            <div className="track">
              <div
                className={String(k)}
                style={{ width: Math.min(100, (Math.abs(Number(n || 0)) / span) * 100) + '%' }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="confidence-block">
        <div className="eyeline">Block-bootstrap interval</div>
        <strong>{i.low == null ? 'Insufficient sample' : pct(i.low) + ' to ' + pct(i.high)}</strong>
        <p>
          {Math.round(100 * i.confidence)}% · {i.quantity} · {i.block}-session blocks
        </p>
      </div>
      <div className="compact-row">
        <span>Two-sided p-value</span>
        <b>{i.p_value == null ? '—' : i.p_value.toFixed(3)}</b>
      </div>
      <div className="compact-row">
        <span>Median net return</span>
        <b>{pct(m.median)}</b>
      </div>
    </section>
  )
}
