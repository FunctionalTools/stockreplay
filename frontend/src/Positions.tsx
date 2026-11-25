import { useEffect, useState, type FormEvent } from 'react'
import { Building2, BookOpen, FileUp, Plus, Pencil, Trash2 } from 'lucide-react'
import { PortfolioImportGuide } from './PortfolioImportGuide'
import { api, errorText } from './types'
import { Modal, Field, Empty, ErrorBox, Busy } from './ui'
import { PageHead, useResource, fmt, when, type Packet } from './deskCommon'
type Position = {
  id?: string
  symbol: string
  description: string
  quantity: number | null
  price: number | null
  value: number | null
  basis: number | null
  currency: string
  as_of: string | null
}
type Account = {
  id: string
  institution: string
  name: string
  updated?: string
  replaces?: number
  revision?: string
  positions: Position[]
}
type Mark = { price: number; currency: string | null; time: number }
const numeric = ['quantity', 'price', 'value', 'basis'] as const
const values = {
  quantity: 'Quantity',
  price: 'Unit price',
  value: 'Statement value',
  basis: 'Total cost basis',
}
const mapping: Record<string, string> = {
  symbol: 'Symbol',
  description: 'Description',
  quantity: 'Quantity',
  price: 'Unit price',
  value: 'Market value',
  basis: 'Total cost basis',
  account_number: 'Account number',
  account_name: 'Account name',
  currency: 'Currency',
  as_of: 'Statement date',
}
const blank: Position = {
  symbol: '',
  description: '',
  currency: 'USD',
  as_of: null,
  quantity: null,
  price: null,
  value: null,
  basis: null,
}
function totals(positions: Position[]) {
  const sums = new Map<string, number>()
  for (const p of positions)
    if (p.value !== null) sums.set(p.currency, (sums.get(p.currency) || 0) + p.value)
  return [...sums]
}
function StatementImport({
  close,
  done,
  initialInstitution,
}: {
  close: () => void
  done: () => void
  initialInstitution: string
}) {
  const [content, setContent] = useState(''),
    [institution, setInstitution] = useState(initialInstitution),
    [account, setAccount] = useState(''),
    [date, setDate] = useState(''),
    [currency, setCurrency] = useState('USD'),
    [map, setMap] = useState<Record<string, string>>({}),
    [preview, setPreview] = useState<Account[] | null>(null),
    [busy, wait] = useState(false),
    [error, setErr] = useState(''),
    [filename, setFile] = useState('')
  const change = (fn: () => void) => {
    setPreview(null)
    setErr('')
    fn()
  }
  async function submit(apply: boolean) {
    wait(true)
    setErr('')
    try {
      const data = await api<Account[]>(
        '/holdings/import/' + (apply ? 'apply' : 'preview'),
        'POST',
        {
          institution,
          account,
          as_of: date || null,
          currency,
          mapping: map,
          content,
          revisions: apply
            ? Object.fromEntries((preview || []).map((a) => [a.id, a.revision]))
            : {},
        },
      )
      if (apply) done()
      else setPreview(data)
    } catch (e) {
      setErr(errorText(e))
      setPreview(null)
    } finally {
      wait(false)
    }
  }
  return (
    <Modal title="Import a holdings statement" wide close={close}>
      <div className="modal-body stack">
        <details className="import-instructions">
          <summary>
            <BookOpen size={15} aria-hidden="true" /> How to import your portfolio
          </summary>
          <PortfolioImportGuide />
        </details>
        <form
          className="desk-form"
          onSubmit={(e) => {
            e.preventDefault()
            void submit(false)
          }}
        >
          <div className="form-grid">
            <Field name="Institution">
              <input
                value={institution}
                required
                onChange={(e) => change(() => setInstitution(e.target.value))}
              />
            </Field>
            <Field name="Account nickname">
              <input
                value={account}
                placeholder="Required for files without an account"
                onChange={(e) => change(() => setAccount(e.target.value))}
              />
            </Field>
            <Field name="Fallback currency">
              <input
                required
                pattern="[A-Z]{3}"
                maxLength={3}
                value={currency}
                onChange={(e) => change(() => setCurrency(e.target.value.toUpperCase()))}
              />
            </Field>
            <Field name="Statement as of">
              <input
                type="date"
                value={date}
                onChange={(e) => change(() => setDate(e.target.value))}
              />
            </Field>
          </div>
          <Field name="Positions statement">
            <input
              type="file"
              accept=".csv,.ofx,.qfx,text/csv"
              required
              disabled={busy}
              onChange={async (e) => {
                const f = e.target.files?.[0]
                change(() => {
                  setContent('')
                  setFile(f?.name || '')
                })
                if (f) {
                  if (f.size > 8_000_000) {
                    setErr('Choose a statement smaller than 8 MB.')
                    return
                  }
                  try {
                    setContent(await f.text())
                  } catch {
                    setErr('This file could not be read.')
                  }
                }
              }}
            />
          </Field>
          <details>
            <summary>Map another broker’s CSV columns</summary>
            <p>
              Enter the exact header for any column StockReplay should use. Recognized headers are
              mapped automatically.
            </p>
            <div className="form-grid">
              {Object.entries(mapping).map(([k, v]) => (
                <Field key={k} name={v + ' column'}>
                  <input
                    placeholder="Automatic"
                    value={map[k] || ''}
                    onChange={(e) => change(() => setMap({ ...map, [k]: e.target.value }))}
                  />
                </Field>
              ))}
            </div>
          </details>
          <button className="btn" disabled={busy || !content}>
            <FileUp size={14} />
            {busy ? 'Reading statement' : 'Preview statement'}
          </button>
        </form>
        <ErrorBox text={error} />
        {preview && (
          <section className="import-preview">
            <h3>Review {filename}</h3>
            {preview.map((a) => (
              <div key={a.id}>
                <h4>
                  {a.institution} · {a.name}
                </h4>
                <p>
                  {a.positions.length} positions ·{' '}
                  {totals(a.positions)
                    .map(([c, n]) => fmt(n) + ' ' + c)
                    .join(' / ') || 'Value unavailable'}
                </p>
                <p>
                  {a.replaces
                    ? 'Applying this snapshot replaces ' +
                      a.replaces +
                      ' existing positions in this account.'
                    : 'A new snapshot will be saved for this account.'}
                </p>
                <details>
                  <summary>Review all positions</summary>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Investment</th>
                          <th>Quantity</th>
                          <th>Value</th>
                          <th>Currency</th>
                          <th>Statement date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.positions.map((p, i) => (
                          <tr key={i}>
                            <td>{p.symbol || p.description}</td>
                            <td>{fmt(p.quantity, 6)}</td>
                            <td>{fmt(p.value)}</td>
                            <td>{p.currency}</td>
                            <td>{when(p.as_of)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            ))}
            <button className="btn primary" disabled={busy} onClick={() => submit(true)}>
              Apply reviewed statement
            </button>
          </section>
        )}
      </div>
    </Modal>
  )
}
function PositionForm({
  account,
  initial,
  close,
  done,
}: {
  account: Account
  initial: Position
  close: () => void
  done: () => void
}) {
  const [error, setErr] = useState(''),
    [busy, wait] = useState(false)
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const body: Record<string, unknown> = Object.fromEntries(form)
    for (const k of numeric) body[k] = form.get(k) === '' ? null : Number(form.get(k))
    body.as_of = body.as_of || null
    body.currency = String(body.currency).toUpperCase()
    wait(true)
    try {
      await api(
        '/holdings/accounts/' + account.id + '/positions' + (initial.id ? '/' + initial.id : ''),
        initial.id ? 'PUT' : 'POST',
        body,
      )
      done()
    } catch (x) {
      setErr(errorText(x))
    } finally {
      wait(false)
    }
  }
  return (
    <Modal title={initial.id ? 'Edit position' : 'Add position'} close={close}>
      <form className="modal-body stack" onSubmit={submit}>
        <p>
          {account.institution} · {account.name}
        </p>
        <div className="form-grid">
          <Field name="Investment symbol">
            <input name="symbol" defaultValue={initial.symbol} />
          </Field>
          <Field name="Investment description">
            <input name="description" defaultValue={initial.description} />
          </Field>
          {numeric.map((k) => (
            <Field key={k} name={values[k]}>
              <input name={k} type="number" step="any" defaultValue={initial[k] ?? ''} />
            </Field>
          ))}
          <Field name="Position currency">
            <input name="currency" required pattern="[A-Z]{3}" defaultValue={initial.currency} />
          </Field>
          <Field name="Valuation date">
            <input type="date" name="as_of" defaultValue={initial.as_of || ''} />
          </Field>
        </div>
        <ErrorBox text={error} />
        <button className="btn primary" disabled={busy}>
          Save position
        </button>
      </form>
    </Modal>
  )
}
export function HoldingsPage({ initialAction = '' }: { initialAction?: string }) {
  const data = useResource<Account[]>('/holdings'),
    [importing, setImport] = useState(false),
    [guideOpen, setGuideOpen] = useState(initialAction === 'import-guide'),
    [initialInstitution, setInitialInstitution] = useState('Fidelity'),
    [adding, setAdding] = useState(false),
    [edit, setEdit] = useState<{ a: Account; p: Position } | null>(null),
    [error, setErr] = useState(''),
    [remove, setRemove] = useState<{ url: string; title: string } | null>(null),
    [marks, setMarks] = useState<Record<string, string>>({}),
    [message, show] = useState('')
  useEffect(() => {
    if (initialAction === 'holdings') setImport(true)
    if (initialAction === 'import-guide') setGuideOpen(true)
    if (initialAction === 'account') setAdding(true)
  }, [initialAction])
  function openStatement(institution = 'Fidelity') {
    setGuideOpen(false)
    setInitialInstitution(institution)
    setImport(true)
  }
  const all = (data.data || []).flatMap((a) => a.positions),
    missing = all.filter((p) => p.value == null).length
  const saved = () => {
    setImport(false)
    setAdding(false)
    setEdit(null)
    setRemove(null)
    show('Holdings updated on this Mac.')
    setMarks({})
    data.reload()
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    try {
      await api('/holdings/accounts', 'POST', Object.fromEntries(new FormData(e.currentTarget)))
      saved()
    } catch (ex) {
      setErr(errorText(ex))
    }
  }
  async function mark(p: Position) {
    const id = p.id!
    setMarks((m) => ({ ...m, [id]: 'Checking…' }))
    try {
      const {
        data: q,
        error,
        stale,
      } = await api<Packet<Mark>>('/desk/quote/' + encodeURIComponent(p.symbol) + '?refresh=true')
      if (!q) throw Error(error || 'Price unavailable')
      const total =
        q.currency === p.currency && p.quantity != null
          ? ' · position ' + fmt(q.price * p.quantity) + ' ' + p.currency
          : ''
      setMarks((m) => ({
        ...m,
        [id]:
          (stale ? 'Cached · ' : '') +
          fmt(q.price) +
          ' ' +
          (q.currency || 'currency unreported') +
          total +
          ' · ' +
          new Date(q.time * 1000).toLocaleString(),
      }))
    } catch (e) {
      setMarks((m) => ({ ...m, [id]: errorText(e) }))
    }
  }
  return (
    <>
      <PageHead
        title="Portfolio"
        description="Keep your investments and bank balances together on this Mac."
      >
        <button className="btn primary" onClick={() => openStatement()}>
          <FileUp size={15} />
          Import statement
        </button>
      </PageHead>
      <div className="desk-toolbar">
        <button className="btn" onClick={() => setAdding(true)}>
          <Plus size={14} />
          Add account
        </button>
        <button className="btn" onClick={() => setGuideOpen(true)}>
          <BookOpen size={15} /> Import guide
        </button>
      </div>
      <ErrorBox text={error || data.error} />
      {message && <p role="status">{message}</p>}
      {data.loading && <Busy text="Reading local accounts" />}
      {all.length > 0 && (
        <section className="panel desk-card">
          <h3>Statement totals</h3>
          <div className="facts">
            {totals(all).map(([c, v]) => (
              <div key={c}>
                <small>{c}</small>
                <strong>{fmt(v)}</strong>
              </div>
            ))}
          </div>
          <small>
            {all.length} positions · {missing} without a valuation · totals shown per currency
          </small>
        </section>
      )}
      {data.data?.length === 0 && (
        <section className="panel">
          <Empty
            title="Add your first account"
            body="Import current positions from Fidelity or another institution, or enter balances and investments manually."
          />
        </section>
      )}
      {data.data?.map((a) => (
        <section className="panel desk-card" key={a.id}>
          <div className="section-head">
            <div>
              <small>{a.institution}</small>
              <h3>
                <Building2 size={17} />
                {a.name}
              </h3>
            </div>
            <div className="inline">
              <button className="btn small" onClick={() => setEdit({ a, p: blank })}>
                Add position
              </button>
              <button
                className="icon-btn"
                aria-label={'Delete account ' + a.name}
                onClick={() =>
                  setRemove({
                    url: '/holdings/accounts/' + a.id,
                    title: a.name,
                  })
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    'Investment',
                    'Quantity',
                    'Unit price',
                    'Value',
                    'Cost basis',
                    'Currency',
                    'As of',
                    'Actions',
                  ].map((n) => (
                    <th key={n}>{n}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {a.positions.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b>{p.symbol || '—'}</b>
                      <small className="cell-note">{p.description}</small>
                    </td>
                    <td>{fmt(p.quantity, 6)}</td>
                    <td>{fmt(p.price, 4)}</td>
                    <td>{fmt(p.value)}</td>
                    <td>{fmt(p.basis)}</td>
                    <td>{p.currency}</td>
                    <td>{when(p.as_of)}</td>
                    <td>
                      <div className="inline">
                        <button
                          className="icon-btn"
                          aria-label={'Edit ' + (p.symbol || p.description)}
                          onClick={() => setEdit({ a, p })}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="icon-btn"
                          aria-label={'Remove ' + (p.symbol || p.description)}
                          onClick={() =>
                            setRemove({
                              url: '/holdings/accounts/' + a.id + '/positions/' + p.id,
                              title: p.symbol || p.description,
                            })
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                        {/^[A-Z0-9^][A-Z0-9.^=-]{0,19}$/i.test(p.symbol) && (
                          <button className="text-btn" onClick={() => mark(p)}>
                            Get quote
                          </button>
                        )}
                      </div>
                      {marks[p.id!] && <small className="cell-note">{marks[p.id!]}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!a.positions.length && <p className="helper">This account has no positions yet.</p>}
        </section>
      ))}
      <p className="helper">
        Get quote requests that symbol’s public market price. Account names, balances, quantities
        and cost basis stay local. Imports refresh when you apply a new statement.
      </p>
      {guideOpen && (
        <Modal title="Portfolio import guide" wide close={() => setGuideOpen(false)}>
          <div className="modal-body">
            <PortfolioImportGuide onImport={openStatement} />
          </div>
        </Modal>
      )}
      {importing && (
        <StatementImport
          initialInstitution={initialInstitution}
          close={() => setImport(false)}
          done={saved}
        />
      )}{' '}
      {adding && (
        <Modal title="Add local account" close={() => setAdding(false)}>
          <form className="modal-body stack" onSubmit={create}>
            <Field name="Institution">
              <input name="institution" required />
            </Field>
            <Field name="Account nickname">
              <input name="name" required />
            </Field>
            <ErrorBox text={error} />
            <button className="btn primary">Create account</button>
          </form>
        </Modal>
      )}
      {edit && (
        <PositionForm account={edit.a} initial={edit.p} done={saved} close={() => setEdit(null)} />
      )}{' '}
      {remove && (
        <Modal title={'Remove ' + remove.title + '?'} close={() => setRemove(null)}>
          <div className="modal-body stack">
            <p>The selected local record and its positions will be removed.</p>
            <button className="btn" onClick={() => setRemove(null)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await api(remove.url, 'DELETE')
                  saved()
                } catch (e) {
                  setErr(errorText(e))
                  setRemove(null)
                }
              }}
            >
              Remove local record
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
