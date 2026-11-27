import { useState } from 'react'
import { SourceLink } from './deskCommon'
import { shortDay, type Opinion, type ScoreFactor, type Source } from './workspace'
import './score-factors.css'

function Evidence({ source: s, appliesTo }: { source: Source; appliesTo: string }) {
  const dateLabel = { close: 'Close', published: 'Published', retrieved: 'Checked' }[
    s.date_kind ?? 'published'
  ]
  return (
    <li>
      <small>{appliesTo}</small>
      <span className="factor-observation">{s.text}</span>
      <div className="factor-attribution">
        <SourceLink url={s.url}>{s.source}</SourceLink>
        <span>
          {s.date_kind ? dateLabel + ' ' : ''}
          {shortDay(s.date)}
        </span>
        {s.stale && <span>Cached after a source error</span>}
        {s.related?.map((link) => (
          <SourceLink key={link.url} url={link.url}>
            {link.label}
          </SourceLink>
        ))}
      </div>
      {s.period_end && <small>Latest reporting quarter ended {shortDay(s.period_end)}</small>}
    </li>
  )
}

function FactorRow({ factor: f, sources }: { factor: ScoreFactor; sources: Source[] }) {
  const [open, setOpen] = useState(false)
  const citations = new Set([...(f.buy?.citations ?? []), ...(f.risk?.citations ?? [])])
  return (
    <details className="score-factor" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span>
          {f.label}
          {f.status === 'older' && <small>Older evidence</small>}
        </span>
        <span className="factor-directions">
          <span>
            Buy <b>{f.buy?.direction}</b>
          </span>
          <span>
            Risk <b>{f.risk?.direction}</b>
          </span>
        </span>
      </summary>
      {open && (
        <div className="factor-body">
          <dl>
            <div>
              <dt>Buy score</dt>
              <dd>{f.buy?.text}</dd>
            </div>
            <div>
              <dt>Risk score</dt>
              <dd>{f.risk?.text}</dd>
            </div>
          </dl>
          <ul aria-label={'Evidence for ' + f.label}>
            {sources
              .filter((s) => citations.has(s.id))
              .map((s) => (
                <Evidence
                  key={s.id}
                  source={s}
                  appliesTo={
                    f.buy?.citations.includes(s.id) && f.risk?.citations.includes(s.id)
                      ? 'Evidence for both scores'
                      : f.buy?.citations.includes(s.id)
                        ? 'Buy score evidence'
                        : 'Risk score evidence'
                  }
                />
              ))}
          </ul>
        </div>
      )}
    </details>
  )
}

export function ScoreFactors({ opinion }: { opinion: Opinion }) {
  const [open, setOpen] = useState(false)
  if (!opinion.factors)
    return (
      <p className="legacy-factors">
        This assessment predates the factor breakdown. Update scores to see how each factor affects
        buying and risk.
      </p>
    )
  const used = opinion.factors.filter((f) => f.status !== 'missing')
  const missing = opinion.factors.filter((f) => f.status === 'missing')
  const older = used.filter((f) => f.status === 'older').length
  return (
    <details className="score-breakdown" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span>Score breakdown</span>
        <small>
          {[
            used.length + ' factors used',
            older && older + ' with older evidence',
            missing.length && missing.length + ' unavailable',
          ]
            .filter(Boolean)
            .join(' · ')}
        </small>
      </summary>
      {open && (
        <div className="score-breakdown-body">
          <p>
            Effects reflect the model’s judgment for each score. Higher risk means greater potential
            downside or uncertainty.
          </p>
          {used.map((f) => (
            <FactorRow key={f.id} factor={f} sources={opinion.sources} />
          ))}
          {!!missing.length && (
            <div className="missing-factors">
              <h4>Unavailable for this assessment</h4>
              <p>These factors had no usable dated evidence and contributed to neither score.</p>
              <ul>
                {missing.map((f) => (
                  <li key={f.id}>{f.label}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </details>
  )
}
