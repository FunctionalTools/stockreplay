import { useEffect, useState } from 'react'
import { CalendarDays, ChartNoAxesCombined, X } from 'lucide-react'
import { useSavedForecast } from './useSavedForecast'
import {
  futureHref,
  matchesProjection,
  providerName,
  snapshotPath,
  type ForecastSnapshot,
} from './forecastSnapshot'
import {
  calendarHref,
  horizons,
  isLastPriceReference,
  type Forecast,
  type Horizon,
} from './forecastData'
import type { Selection } from './priceRanges'
import { shortDay, tickerPattern, type Connection } from './workspace'
import { ErrorBox } from './ui'

export function extraSymbols(primary: string, query: string) {
  const raw = new URLSearchParams(query).get('compare') || ''
  return [
    ...new Set(
      raw
        .split(',')
        .map((v) => v.trim().toUpperCase())
        .filter((v) => v !== primary && tickerPattern.test(v)),
    ),
  ].slice(0, 7)
}
type Receive = (symbol: string, f: ForecastSnapshot | null, confirmed: boolean) => void
function ComparisonRow({
  symbol,
  selection,
  connection,
  remove,
  remember,
  href,
  base,
}: {
  symbol: string
  base?: Forecast
  selection: Selection
  connection: Connection | null
  remove: () => void
  remember: Receive
  href: string
}) {
  const { forecast, generated, busy, loading, error, generate } = useSavedForecast(
    snapshotPath(symbol, selection),
    { connection, base },
  )
  const confirmed = !!generated && forecast?.id === generated.id
  useEffect(() => remember(symbol, forecast, confirmed), [symbol, forecast, confirmed, remember])
  return (
    <li>
      <div>
        <a href={href} aria-label={'Open ' + symbol + ' forecast outlook'}>
          <strong>{symbol}</strong>
        </a>
        <small>
          {forecast
            ? (isLastPriceReference(forecast) ? 'Last-price reference · AI research by ' : '') +
              providerName(forecast.provider) +
              ' · ' +
              forecast.model +
              (base && !matchesProjection(forecast, base)
                ? ' · earlier snapshot through '
                : ' · through ') +
              shortDay(forecast.points.at(-1)?.date)
            : loading
              ? 'Checking saved forecast…'
              : (isLastPriceReference(base)
                  ? 'Last-price reference · '
                  : base
                    ? 'Price model · '
                    : '') + 'No saved forecast for this period'}
        </small>
      </div>
      <button
        className="btn small"
        disabled={busy || loading || !connection?.configured}
        onClick={generate}
      >
        {busy
          ? 'Generating ' + symbol + '…'
          : (forecast ? 'Update ' : 'Generate ') + symbol + ' forecast'}
      </button>
      <button
        className="icon-btn"
        aria-label={'Remove ' + symbol + ' from comparison'}
        onClick={remove}
      >
        <X size={14} />
      </button>
      {error && <ErrorBox text={error} />}
    </li>
  )
}
export function ForecastComparison({
  primary,
  extras,
  baselines,
  selection,
  change,
  connection,
  remember,
}: {
  primary: string
  extras: string[]
  baselines: Forecast[]
  selection: Selection
  change: (symbols: string[]) => void
  connection: Connection | null
  remember: Receive
}) {
  const [opened, open] = useState<boolean | null>(null),
    [text, type] = useState(''),
    [error, fail] = useState('')
  const expanded = opened ?? extras.length > 0
  const add = () => {
    const next = text.trim().toUpperCase()
    if (!tickerPattern.test(next)) return fail('Enter an exchange ticker, such as MSFT.')
    if (next === primary || extras.includes(next)) return fail(next + ' is already selected.')
    if (extras.length >= 7) return fail('Compare up to eight tickers.')
    type('')
    fail('')
    change([...extras, next])
  }
  const horizon = Object.hasOwn(horizons, selection.preset) ? (selection.preset as Horizon) : '1mo'
  return (
    <div className="future-comparison">
      <div className="future-links">
        <button
          type="button"
          aria-expanded={expanded}
          className="text-btn"
          onClick={() => open(!expanded)}
        >
          <ChartNoAxesCombined size={14} />
          {extras.length ? 'Comparing ' + (extras.length + 1) + ' tickers' : 'Compare forecasts'}
        </button>
        <a
          href={calendarHref({
            symbols: [primary, ...extras],
            horizon,
            start: selection.start,
            end: selection.end,
          })}
        >
          <CalendarDays size={14} /> Forecast calendar
        </a>
      </div>
      <div hidden={!expanded}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <input
            aria-label="Comparison ticker"
            placeholder="Ticker to compare"
            value={text}
            onChange={(e) => {
              type(e.target.value)
              fail('')
            }}
            spellCheck={false}
            autoComplete="off"
            maxLength={20}
          />
          <button className="btn small" disabled={!text.trim() || extras.length >= 7}>
            Add ticker
          </button>
        </form>
        <ErrorBox text={error} />
        {extras.length > 0 && (
          <ul aria-label="Comparison forecasts">
            {extras.map((s) => (
              <ComparisonRow
                key={s}
                symbol={s}
                base={baselines.find((v) => v.symbol === s)}
                href={futureHref(s, selection.preset, selection.start, selection.end, [
                  primary,
                  ...extras.filter((v) => v !== s),
                ])}
                selection={selection}
                connection={connection}
                remember={remember}
                remove={() => change(extras.filter((v) => v !== s))}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
