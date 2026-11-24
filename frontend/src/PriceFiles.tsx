import { useState } from 'react'
import { api, errorText } from './types'
import { useResource } from './deskCommon'
import { Busy, ErrorBox, Field } from './ui'
import { usePrices, PricePlot } from './PricePlot'
import { tickerPattern } from './workspace'
export function PriceFiles({ open = false }: { open?: boolean }) {
  const files =
    useResource<{ id: string; ticker: string; first: string; last: string; rows: number }[]>(
      '/prices/imports',
    )
  const [s, setS] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [id, select] = useState(''),
    [busy, wait] = useState(false),
    [err, fail] = useState('')
  return (
    <details className="panel desk-card" open={open || undefined}>
      <summary>Imported price history</summary>
      <p>
        Chart daily prices from your own CSV on this Mac. Include Date, Open, High, Low, Close, Adj
        Close and Volume.
      </p>
      <form
        className="desk-toolbar"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!file) return
          wait(true)
          try {
            if (file.size > 6000000) throw Error('Choose a CSV smaller than 6 MB.')
            const r = await api<{ snapshot: string }>('/data/import', 'POST', {
              ticker: s,
              csv: await file.text(),
            })
            select(r.snapshot)
            files.reload()
            fail('')
          } catch (ex) {
            fail(errorText(ex))
          } finally {
            wait(false)
          }
        }}
      >
        <Field name="Price file ticker">
          <input maxLength={20} value={s} onChange={(e) => setS(e.target.value.toUpperCase())} />
        </Field>
        <Field name="Daily price CSV">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </Field>
        <button className="btn" disabled={busy || !file || !tickerPattern.test(s)}>
          Import prices
        </button>
      </form>
      <ErrorBox text={err || files.error} />
      {!!files.data?.length && (
        <Field name="Saved price file">
          <select value={id} onChange={(e) => select(e.target.value)}>
            <option value="">Select a file to chart</option>
            {files.data.map((f) => (
              <option key={f.id} value={f.id}>
                {f.ticker} · {f.first} – {f.last} · {f.rows} rows
              </option>
            ))}
          </select>
        </Field>
      )}
      {id && <LocalPlot id={id} />}
    </details>
  )
}
function LocalPlot({ id }: { id: string }) {
  const p = usePrices(['local'], '1y', id)
  return (
    <>
      {p.loading && <Busy text="Reading imported prices" />}
      <ErrorBox text={p.errors.join(' ')} />
      <PricePlot series={p.series} />
    </>
  )
}
