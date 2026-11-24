import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { PageHead, SourceLink } from './deskCommon'
import { Field } from './ui'
const widgets: Record<string, { name: string; config: Record<string, unknown> }> = {
  'advanced-chart': {
    name: 'Advanced chart and drawing tools',
    config: {
      interval: 'D',
      style: '1',
      allow_symbol_change: true,
      hide_side_toolbar: false,
      withdateranges: true,
      save_image: true,
      details: true,
      hotlist: true,
      calendar: true,
    },
  },
  screener: {
    name: 'Global stock screener',
    config: {
      defaultColumn: 'overview',
      defaultScreen: 'general',
      market: 'america',
      showToolbar: true,
    },
  },
  'stock-heatmap': {
    name: 'Stock heatmap',
    config: {
      dataSource: 'SPX500',
      blockSize: 'market_cap_basic',
      blockColor: 'change',
      grouping: 'sector',
      hasTopBar: true,
    },
  },
  'etf-heatmap': {
    name: 'ETF heatmap',
    config: {
      dataSource: 'AllUSEtf',
      blockSize: 'default',
      blockColor: 'change',
      hasTopBar: true,
    },
  },
  'crypto-coins-heatmap': {
    name: 'Crypto heatmap',
    config: {
      dataSource: 'Crypto',
      blockSize: 'market_cap_calc',
      blockColor: '24h_close_change|5',
      hasTopBar: true,
    },
  },
  events: {
    name: 'Economic calendar',
    config: { importanceFilter: '-1,0,1', countryFilter: 'us,ca,gb,eu,jp,cn' },
  },
  'technical-analysis': {
    name: 'Technical gauge',
    config: { interval: '1D', showIntervalTabs: true, displayMode: 'multiple' },
  },
  financials: {
    name: 'Company financial statements',
    config: { displayMode: 'regular' },
  },
  'symbol-profile': { name: 'Company profile', config: {} },
  timeline: {
    name: 'Market news timeline',
    config: { feedMode: 'all_symbols', displayMode: 'regular' },
  },
}
export function TradingTools({ symbol }: { symbol: string }) {
  const [choice, pick] = useState('advanced-chart'),
    [loaded, load] = useState(false),
    [ticker, setTicker] = useState(symbol),
    [selected, setSelected] = useState(symbol)
  const item = widgets[choice],
    usesSymbol = ['advanced-chart', 'technical-analysis', 'financials', 'symbol-profile'].includes(
      choice,
    )
  const config = {
    ...item.config,
    ...(usesSymbol ? { symbol: selected } : {}),
    autosize: true,
    width: '100%',
    height: '100%',
    theme: 'dark',
    colorTheme: 'dark',
    locale: 'en',
    timezone: 'exchange',
    isTransparent: false,
  }
  const src =
    'https://www.tradingview-widget.com/embed-widget/' +
    choice +
    '/?locale=en#' +
    encodeURIComponent(JSON.stringify(config))
  return (
    <>
      <PageHead
        title="TradingView tools"
        description="Open provider-hosted charting and market tools in a separate frame."
      />
      <section className="panel desk-card">
        <div className="desk-toolbar">
          <Field name="TradingView tool">
            <select
              value={choice}
              onChange={(e) => {
                pick(e.target.value)
                load(false)
              }}
            >
              {Object.entries(widgets).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.name}
                </option>
              ))}
            </select>
          </Field>
          {usesSymbol && (
            <Field name="TradingView exchange and symbol">
              <input
                value={ticker}
                placeholder="NASDAQ:NVDA"
                onChange={(e) => {
                  setTicker(e.target.value.toUpperCase())
                  load(false)
                }}
              />
            </Field>
          )}
          <button
            className="btn primary"
            disabled={usesSymbol && !ticker.trim()}
            onClick={() => {
              setSelected(ticker.trim())
              load(true)
            }}
          >
            Load TradingView tool
          </button>
          {loaded && (
            <button className="btn" onClick={() => load(false)}>
              Close connection
            </button>
          )}
        </div>
        <p>
          Loading connects your browser to TradingView. Symbol-specific tools receive the ticker you
          enter. Your holdings, API key, watchlists and local research stay in StockReplay.
        </p>
        {loaded && (
          <div className="tv-frame">
            <iframe
              key={src}
              src={src}
              title={item.name}
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
              allowFullScreen
            />
            <SourceLink url="https://www.tradingview.com/">Market tools by TradingView</SourceLink>
          </div>
        )}
      </section>
      <section className="panel desk-card">
        <h3>TradingView Supercharts</h3>
        <p>
          Pine Script, Strategy Tester, paper trading, broker connections, social publishing and
          exchange subscriptions are provided in TradingView’s own workspace. Availability depends
          on your TradingView account and market-data entitlements.
        </p>
        <a
          className="btn"
          href={
            'https://www.tradingview.com/chart/?symbol=' +
            encodeURIComponent(ticker.trim() || selected)
          }
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink size={14} />
          Open full TradingView workspace
        </a>{' '}
        <SourceLink url="https://www.tradingview.com/support/solutions/43000746464-getting-started-with-supercharts/">
          Supercharts guide
        </SourceLink>
      </section>
    </>
  )
}
