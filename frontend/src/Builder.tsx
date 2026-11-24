import { useEffect, useId, useState } from 'react'
import { Plus, X, Play, Search } from 'lucide-react'
import {
  api,
  type Config,
  type Group,
  type Rule,
  type Source,
  newRule,
  indicators,
  objectives,
  sourceName,
  errorText,
} from './types'
import { Field, ErrorBox, Modal } from './ui'

export function SymbolPicker({
  value,
  change,
}: {
  value: string[]
  change: (v: string[]) => void
}) {
  const [q, setQ] = useState(''),
    [hits, setHits] = useState<{ symbol: string; name: string }[]>([]),
    [err, setErr] = useState(''),
    [focused, focus] = useState(false),
    [active, highlight] = useState(-1),
    [searching, searchBusy] = useState(false)
  const listId = useId()
  useEffect(() => {
    let current = true
    highlight(-1)
    if (focused)
      api<{ symbol: string; name: string }[]>('/symbols?q=' + encodeURIComponent(q))
        .then((v) => {
          if (current) setHits(v)
        })
        .catch((e) => {
          if (current) setErr(errorText(e))
        })
    return () => {
      current = false
    }
  }, [q, focused])
  const add = (s: string) => {
    const symbol = s.trim().toUpperCase()
    if (!/^[A-Z^][A-Z0-9.^=-]{0,11}$/.test(symbol)) {
      setErr('Enter a valid exchange symbol.')
      return
    }
    if (!value.includes(symbol)) change([...value, symbol])
    setQ('')
    focus(false)
    setErr('')
  }
  const options = hits.slice(0, 6)
  async function online() {
    searchBusy(true)
    setErr('')
    try {
      setHits(await api('/symbols?online=true&q=' + encodeURIComponent(q)))
      highlight(-1)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      searchBusy(false)
    }
  }
  return (
    <div
      className="symbol-field"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) focus(false)
      }}
    >
      <span className="field-title">Traded symbols</span>
      <div className="symbols">
        {value.map((s) => (
          <button
            key={s}
            type="button"
            className="ticker"
            onClick={() => change(value.filter((x) => x !== s))}
            aria-label={'Remove ' + s}
          >
            {s}
            <X size={12} />
          </button>
        ))}
        <div className="inline">
          <Search size={13} />
          <input
            role="combobox"
            aria-expanded={focused}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={focused && active >= 0 ? listId + '-' + active : undefined}
            aria-label="Search tickers"
            placeholder="Find or add ticker"
            value={q}
            onFocus={() => focus(true)}
            onChange={(e) => {
              setQ(e.target.value)
              focus(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                focus(true)
                highlight((i) =>
                  Math.max(0, Math.min(options.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))),
                )
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                if (active >= 0 && options[active]) add(options[active].symbol)
                else if (q) add(q)
              }
              if (e.key === 'Escape' && focused) {
                e.preventDefault()
                e.stopPropagation()
                focus(false)
              }
            }}
          />
        </div>
      </div>
      {focused && (
        <div className="suggestions">
          <div role="listbox" id={listId} aria-label="Matching tickers">
            {options.map((h, i) => (
              <button
                role="option"
                aria-selected={i === active}
                id={listId + '-' + i}
                type="button"
                key={h.symbol}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(h.symbol)}
              >
                <b>{h.symbol}</b>
                {h.name}
              </button>
            ))}
          </div>
          {q.trim() && !options.some((h) => h.symbol === q.toUpperCase()) && (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(q)}>
              Add {q.toUpperCase()}
            </button>
          )}
          {q.length > 1 && (
            <button
              type="button"
              disabled={searching}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void online()}
            >
              {searching ? 'Searching Yahoo…' : 'Search Yahoo Finance'}
            </button>
          )}
        </div>
      )}
      <ErrorBox text={err} />
    </div>
  )
}

function Rules({
  label,
  group,
  change,
}: {
  label: string
  group: Group
  change: (g: Group) => void
}) {
  const update = (i: number, patch: Partial<Rule>) =>
    change({ ...group, rules: group.rules.map((r, j) => (i === j ? { ...r, ...patch } : r)) })
  return (
    <fieldset>
      <legend>{label}</legend>
      <div className="rule-head">
        <Field name="Combine conditions">
          <select
            value={group.logic}
            onChange={(e) => change({ ...group, logic: e.target.value as Group['logic'] })}
          >
            <option value="and">Match all (AND)</option>
            <option value="or">Match any (OR)</option>
          </select>
        </Field>
        <button
          type="button"
          className="btn small"
          disabled={group.rules.length >= 8}
          onClick={() => change({ ...group, rules: [...group.rules, newRule()] })}
        >
          <Plus size={14} />
          Condition
        </button>
      </div>
      {group.rules.map((r, i) => (
        <div className="rule" key={i}>
          <div className="field-grid">
            <Field name="Indicator">
              <select
                value={r.indicator}
                onChange={(e) => {
                  const indicator = e.target.value
                  update(i, {
                    indicator,
                    ...(indicator.startsWith('cross_') ? { operator: 'gt', value: 0 } : {}),
                  })
                }}
              >
                {Object.entries(indicators).map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field name="Signal ticker">
              <input
                required
                maxLength={12}
                value={r.ticker}
                onChange={(e) => update(i, { ticker: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field name="Operator">
              <select value={r.operator} onChange={(e) => update(i, { operator: e.target.value })}>
                {Object.entries({
                  lt: 'Less than',
                  lte: 'At most',
                  gt: 'Greater than',
                  gte: 'At least',
                }).map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field name="Threshold">
              <input
                required
                type="number"
                step="any"
                value={r.value}
                onChange={(e) => update(i, { value: Number(e.target.value) })}
              />
            </Field>
            {!['daily_return', 'positive_streak', 'negative_streak', 'volume'].includes(
              r.indicator,
            ) && (
              <Field name="Window (sessions)">
                <input
                  required
                  type="number"
                  min={1}
                  max={504}
                  value={r.window}
                  onChange={(e) => update(i, { window: Number(e.target.value) })}
                />
              </Field>
            )}
            {r.indicator.startsWith('cross_') && (
              <Field name="Slow window">
                <input
                  required
                  type="number"
                  min={r.window + 1}
                  max={756}
                  value={r.slow}
                  onChange={(e) => update(i, { slow: Number(e.target.value) })}
                />
              </Field>
            )}
          </div>
          {group.rules.length > 1 && (
            <button
              type="button"
              className="text-btn negative"
              onClick={() => change({ ...group, rules: group.rules.filter((_, j) => j !== i) })}
            >
              Remove condition
            </button>
          )}
        </div>
      ))}
    </fieldset>
  )
}

export function Builder({
  initial,
  message,
  close,
  apply,
}: {
  initial: Config
  message: string
  close: () => void
  apply: (c: Config, run: boolean) => void
}) {
  const [c, set] = useState<Config>(structuredClone(initial)),
    [err, setErr] = useState('')
  const patch = (v: Partial<Config>) => set({ ...c, ...v })
  function submit(run: boolean) {
    if (!c.tickers.length) {
      setErr('Add at least one traded symbol.')
      return
    }
    if (c.start >= c.end) {
      setErr('End date must follow the start date.')
      return
    }
    apply(c, run)
  }
  return (
    <Modal title="Hypothesis builder" close={close} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit((e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'run')
        }}
      >
        <div className="modal-body stack">
          {message && <div className="callout">{message}</div>}
          <Field name="Research name">
            <input
              required
              maxLength={100}
              value={c.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field name="Hypothesis">
            <textarea
              required
              minLength={3}
              value={c.hypothesis}
              onChange={(e) => patch({ hypothesis: e.target.value })}
            />
          </Field>
          <div className="field-grid">
            <Field name="Experiment type">
              <select
                value={c.kind}
                onChange={(e) => patch({ kind: e.target.value as Config['kind'] })}
              >
                <option value="event">Event study</option>
                <option value="portfolio">Portfolio backtest</option>
              </select>
            </Field>
            <Field name="Data source">
              <select
                value={c.source}
                onChange={(e) => patch({ source: e.target.value as Source })}
              >
                {Object.entries(sourceName).map(([s, n]) => (
                  <option value={s} key={s}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <SymbolPicker value={c.tickers} change={(tickers) => patch({ tickers })} />
          <div className="field-grid">
            <Field name="Start date">
              <input
                required
                type="date"
                value={c.start}
                onChange={(e) => patch({ start: e.target.value })}
              />
            </Field>
            <Field name="End date">
              <input
                required
                type="date"
                value={c.end}
                onChange={(e) => patch({ end: e.target.value })}
              />
            </Field>
            <Field name="Benchmark">
              <input
                required
                value={c.benchmark}
                onChange={(e) => patch({ benchmark: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field name="Holding period (sessions)">
              <input
                required
                type="number"
                min={1}
                max={252}
                value={c.holding}
                onChange={(e) => patch({ holding: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Rules label="Entry rules" group={c.entry} change={(entry) => patch({ entry })} />
          {c.exit ? (
            <>
              <Rules label="Early exit rules" group={c.exit} change={(exit) => patch({ exit })} />
              <button type="button" className="text-btn" onClick={() => patch({ exit: null })}>
                Remove early exit
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn fit"
              onClick={() => patch({ exit: { logic: 'and', rules: [newRule()] } })}
            >
              <Plus size={14} />
              Add an early exit
            </button>
          )}
          <div className="field-grid">
            <Field name="Expected outcome">
              <select value={c.objective} onChange={(e) => patch({ objective: e.target.value })}>
                {Object.entries(objectives).map(([s, n]) => (
                  <option key={s} value={s}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field name="Market regime">
              <select value={c.regime} onChange={(e) => patch({ regime: e.target.value })}>
                <option value="all">All sessions</option>
                <option value="bull">Above 200-day benchmark SMA</option>
                <option value="bear">Below 200-day benchmark SMA</option>
              </select>
            </Field>
            <Field name="Commission (bps / side)">
              <input
                required
                type="number"
                min={0}
                max={500}
                step="any"
                value={c.cost_bps}
                onChange={(e) => patch({ cost_bps: Number(e.target.value) })}
              />
            </Field>
            <Field name="Slippage (bps / side)">
              <input
                required
                type="number"
                min={0}
                max={500}
                step="any"
                value={c.slippage_bps}
                onChange={(e) => patch({ slippage_bps: Number(e.target.value) })}
              />
            </Field>
          </div>
          <details>
            <summary>Statistical parameters</summary>
            <div className="field-grid">
              {(
                [
                  ['confidence', 'Confidence level', 0.8, 0.99, 0.01],
                  ['samples', 'Bootstrap replicates', 200, 5000, 1],
                  ['block_sessions', 'Minimum block length (0 = auto)', 0, 252, 1],
                  ['seed', 'Random seed', 0, 2147483647, 1],
                ] as const
              ).map(([k, n, min, max, step]) => (
                <Field key={k} name={n}>
                  <input
                    required
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    value={c.stats[k]}
                    onChange={(e) => patch({ stats: { ...c.stats, [k]: Number(e.target.value) } })}
                  />
                </Field>
              ))}
            </div>
          </details>
          <details>
            <summary>Structured configuration</summary>
            <pre>{JSON.stringify(c, null, 2)}</pre>
          </details>
          <ErrorBox text={err} />
        </div>
        <div className="modal-foot">
          <button className="btn" type="submit" value="apply">
            Apply configuration
          </button>
          <button className="btn primary" type="submit" value="run">
            <Play size={14} />
            Run experiment
          </button>
        </div>
      </form>
    </Modal>
  )
}
