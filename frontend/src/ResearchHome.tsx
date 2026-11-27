import { type ReactNode, useId } from 'react'
import { ArrowUpRight, BriefcaseBusiness } from 'lucide-react'
import { amount, shortDay, type Preferences } from './workspace'
import './researchHome.css'

type HomeHolding = {
  symbol: string
  currency: string
  gross_value: number | null
  partial_value: boolean
  weight: number | null
  quantity: number | null
  first_date: string | null
  last_date: string | null
  undated: boolean
}
export type HomeContext = {
  portfolio_symbol: string | null
  holdings: HomeHolding[]
  position_count: number
  symbol: string
}

function statementDate(row: HomeHolding) {
  if (!row.first_date) return 'Date unavailable'
  const range =
    row.first_date === row.last_date
      ? shortDay(row.first_date)
      : shortDay(row.first_date) + ' – ' + shortDay(row.last_date)
  return row.undated ? range + ' · some dates unavailable' : range
}

export function ResearchHome({
  home,
  mode,
  symbol,
  startingSymbol,
  choose,
  follow,
  guide,
  portfolio,
  children,
}: {
  home: HomeContext | null
  mode: Preferences['home_mode']
  symbol: string
  startingSymbol: string
  choose: (symbol: string) => void
  follow: () => void
  guide: () => void
  portfolio: () => void
  children: ReactNode
}) {
  const title = useId()
  const holdings = home?.holdings || []
  const visible = holdings.slice(0, 3)
  // Keep the selected holding in view even when its position is smaller.
  if (!visible.some((h) => h.symbol === symbol)) {
    const selected = holdings.find((h) => h.symbol === symbol)
    if (selected) visible.splice(2, 1, selected)
  }
  const opening =
    mode === 'ticker'
      ? 'Your saved starting ticker'
      : home?.portfolio_symbol
        ? 'Opening ticker from your holdings'
        : home
          ? 'S&P 500 benchmark'
          : 'Market benchmark'
  return (
    <section className="research-home panel" aria-labelledby={title}>
      <div className="home-picker">
        <div>
          <h2 id={title}>Research a ticker</h2>
          {(home || mode === 'ticker') && (
            <small>
              {symbol === startingSymbol ? (
                <>
                  {opening} · <strong>{startingSymbol}</strong>
                </>
              ) : (
                <>
                  Viewing <strong>{symbol}</strong> · Home starts with {startingSymbol}
                </>
              )}
            </small>
          )}
        </div>
        {children}
        {mode === 'ticker' && (
          <button className="text-btn" onClick={follow}>
            Follow my holdings
          </button>
        )}
      </div>
      {home &&
        (holdings.length ? (
          <div className="home-holdings">
            <div className="home-holdings-title">
              <h3>
                <BriefcaseBusiness size={15} /> Your holdings
              </h3>
              <button className="text-btn" onClick={portfolio}>
                View portfolio <ArrowUpRight size={14} />
              </button>
            </div>
            <div className="home-positions">
              {visible.map((h) => (
                <button
                  key={h.currency + h.symbol}
                  className="home-position"
                  aria-label={'Research holding ' + h.symbol + ' in ' + h.currency}
                  aria-pressed={h.symbol === symbol}
                  onClick={() => choose(h.symbol)}
                >
                  <span className="home-position-title">
                    <strong>{h.symbol}</strong>
                    <span>
                      {h.weight !== null
                        ? new Intl.NumberFormat(undefined, {
                            style: 'percent',
                            maximumFractionDigits: 1,
                          }).format(h.weight) +
                          ' of ' +
                          h.currency
                        : h.currency}
                    </span>
                  </span>
                  {h.weight !== null && (
                    <span className="home-allocation" aria-hidden="true">
                      <i style={{ width: Math.min(100, h.weight * 100) + '%' }} />
                    </span>
                  )}
                  <small>
                    {h.quantity !== null &&
                      h.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' units'}
                    {h.quantity !== null && h.gross_value !== null && ' · '}
                    {h.gross_value !== null &&
                      amount(h.gross_value, h.currency) + (h.partial_value ? ' reported' : '')}
                  </small>
                  <small>{statementDate(h)}</small>
                </button>
              ))}
            </div>
            <small className="home-weight-note">
              Weights use absolute statement values, including cash, within each currency.
            </small>
          </div>
        ) : (
          <div className="home-empty">
            <span>
              {home.position_count
                ? 'Your statement has no researchable ticker.'
                : 'Add your holdings to see their portfolio weights here.'}
            </span>
            <button className="text-btn" onClick={home.position_count ? portfolio : guide}>
              {home.position_count ? 'View portfolio' : 'Import holdings'}{' '}
              <ArrowUpRight size={14} />
            </button>
          </div>
        ))}
    </section>
  )
}
