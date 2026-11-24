import { useState } from 'react'
import { FlaskConical, Play } from 'lucide-react'
import {
  api,
  type Result,
  type Robust,
  type Config,
  type Measure,
  errorText,
  pct,
  tone,
  validPinSet,
  indicators,
  sourceName,
} from './types'
import { Busy, Empty, ErrorBox, Field } from './ui'
import { SymbolPicker } from './Builder'

function parseList(input: string) {
  if (!input.trim() || input.split(',').some((t) => !t.trim()))
    throw Error('Enter comma-separated numbers for each parameter.')
  const values = [...new Set(input.split(',').map(Number))]
  if (values.length > 5 || values.some((v) => !Number.isFinite(v)))
    throw Error('Choose up to five finite values per parameter.')
  return values
}
export function Robustness({ r, done }: { r: Result; done: (robust: Robust) => void }) {
  const c = r.config,
    first = c.entry.rules[0].value
  const previous = r.robustness?.parameters
  const defaultHolds = [
    ...new Set([Math.max(1, c.holding - 2), c.holding, Math.min(252, c.holding + 2)]),
  ]
  const [settings, setSettings] = useState<Config>(structuredClone(previous?.config || c)),
    [thresholds, setThresholds] = useState(
      (previous?.thresholds || [first - 1, first, first + 1]).join(', '),
    ),
    [holds, setHoldings] = useState((previous?.holdings || defaultHolds).join(', ')),
    [cost, setCost] = useState((previous?.costs || [0, 5, 10]).join(', ')),
    [split, setSplit] = useState(previous?.split ?? 0.7),
    [folds, setFolds] = useState(previous?.folds ?? 3),
    [busy, setBusy] = useState(false),
    [err, setErr] = useState(''),
    [phase, setPhase] = useState<'train' | 'test'>('test')
  async function run() {
    setErr('')
    setBusy(true)
    try {
      const value = await api<Robust>('/runs/' + r.id + '/robustness', 'POST', {
        config: settings,
        pins: validPinSet(settings, r),
        thresholds: parseList(thresholds),
        holdings: parseList(holds),
        costs: parseList(cost),
        split,
        folds,
      })
      done(value)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const lab = r.robustness
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Robustness lab</h1>
          <p>Stress-test {c.name} across parameters and chronological holdouts.</p>
        </div>
        <span className="badge">{sourceName[c.source]}</span>
      </div>
      <section className="panel form-panel">
        <div className="title-icon">
          <FlaskConical size={18} />
          <h3>Sensitivity experiment</h3>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void run()
          }}
          className="stack"
        >
          <div className="field-grid three">
            <Field name={'Thresholds · ' + indicators[c.entry.rules[0].indicator]}>
              <input required value={thresholds} onChange={(e) => setThresholds(e.target.value)} />
            </Field>
            <Field name="Holding periods (sessions)">
              <input required value={holds} onChange={(e) => setHoldings(e.target.value)} />
            </Field>
            <Field name="Commissions (bps / side)">
              <input required value={cost} onChange={(e) => setCost(e.target.value)} />
            </Field>
          </div>
          <details>
            <summary>Universe, dates and walk-forward settings</summary>
            <div className="stack">
              <SymbolPicker
                value={settings.tickers}
                change={(tickers) => setSettings({ ...settings, tickers })}
              />
              <div className="field-grid three">
                <Field name="Start date">
                  <input
                    type="date"
                    required
                    value={settings.start}
                    onChange={(e) => setSettings({ ...settings, start: e.target.value })}
                  />
                </Field>
                <Field name="End date">
                  <input
                    type="date"
                    required
                    value={settings.end}
                    onChange={(e) => setSettings({ ...settings, end: e.target.value })}
                  />
                </Field>
                <Field name="Regime">
                  <select
                    value={settings.regime}
                    onChange={(e) => setSettings({ ...settings, regime: e.target.value })}
                  >
                    <option value="all">All sessions</option>
                    <option value="bull">Bull</option>
                    <option value="bear">Bear</option>
                  </select>
                </Field>
                <Field name="Training fraction">
                  <input
                    type="number"
                    min=".5"
                    max=".85"
                    step=".05"
                    required
                    value={split}
                    onChange={(e) => setSplit(Number(e.target.value))}
                  />
                </Field>
                <Field name="Walk-forward folds">
                  <input
                    required
                    type="number"
                    min={2}
                    max={5}
                    value={folds}
                    onChange={(e) => setFolds(Number(e.target.value))}
                  />
                </Field>
              </div>
            </div>
          </details>
          <div className="actions">
            <span className="muted">Parameters are selected using training observations only.</span>
            <button className="btn primary" disabled={busy}>
              {busy ? (
                <Busy text="Evaluating" />
              ) : (
                <>
                  <Play size={14} />
                  Run robustness
                </>
              )}
            </button>
          </div>
          <ErrorBox text={err} />
        </form>
      </section>
      {lab ? (
        <>
          <section className="panel form-panel">
            <div className="panel-head flush">
              <div>
                <h3>Parameter sensitivity</h3>
                <p>
                  {lab.quantity} · training through {lab.train_end} · holdout from {lab.test_start}
                </p>
              </div>
              <div className="seg">
                <button className={phase === 'train' ? 'on' : ''} onClick={() => setPhase('train')}>
                  In-sample
                </button>
                <button className={phase === 'test' ? 'on' : ''} onClick={() => setPhase('test')}>
                  Holdout
                </button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="heatmap">
                <thead>
                  <tr>
                    <th>Threshold / hold</th>
                    {[...new Set(lab.cells.map((c) => c.holding))].map((h) => (
                      <th key={h}>{h} sessions</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...new Set(lab.cells.map((c) => c.threshold))].map((t) => (
                    <tr key={t}>
                      <th>{t}</th>
                      {lab.cells
                        .filter((c) => c.threshold === t)
                        .map((cell) => {
                          const m = cell[phase],
                            a = Math.min(0.55, 0.1 + Math.abs(m.effect || 0) / 12)
                          return (
                            <td
                              key={cell.holding}
                              style={{
                                background:
                                  m.effect == null
                                    ? 'transparent'
                                    : m.effect >= 0
                                      ? 'rgba(70,175,130,' + a + ')'
                                      : 'rgba(191,101,109,' + a + ')',
                              }}
                            >
                              <b>{pct(m.effect)}</b>
                              <small>{m.count} observations</small>
                            </td>
                          )
                        })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel form-panel">
            <h3>Expanding walk-forward evaluation</h3>
            <p className="muted">
              Each fold freezes the highest training effect with at least five observations before
              evaluating the next period.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {[
                      'Train through',
                      'Holdout',
                      'Chosen threshold / hold',
                      'Count',
                      'Holdout effect',
                    ].map((v) => (
                      <th key={v}>{v}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lab.folds.map((f) => (
                    <tr key={f.start}>
                      <td>{f.train_end}</td>
                      <td>
                        {f.start} — {f.end}
                      </td>
                      <td>
                        {f.selected
                          ? f.selected.threshold + ' / ' + f.selected.holding
                          : 'Insufficient sample'}
                      </td>
                      <td>{f.test?.count ?? 0}</td>
                      <td className={tone(f.test?.effect)}>{pct(f.test?.effect)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel form-panel">
            <h3>Holdout cost sensitivity</h3>
            {lab.costs.map(({ bps, test }: { bps: number; test: Measure }) => (
              <div className="compact-row" key={bps}>
                <span>{bps} bps commission per side</span>
                <b>{pct(test.mean)} mean net return</b>
              </div>
            ))}
          </section>
        </>
      ) : (
        <section className="panel">
          <Empty
            title="No robustness results yet"
            body="Run the sensitivity experiment to compare training and holdout outcomes."
          />
        </section>
      )}
    </>
  )
}
