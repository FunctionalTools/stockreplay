import { useId, useState, type ReactNode } from 'react'
import { ArrowDownToLine, ArrowRight, BookOpen, ExternalLink } from 'lucide-react'
import './portfolioImport.css'

type Source = 'Fidelity' | 'Other brokerage' | 'Bank'
const sources: Source[] = ['Fidelity', 'Other brokerage', 'Bank']

function HelpLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="source-link" href={href} target="_blank" rel="noopener noreferrer">
      {children} <ExternalLink size={13} aria-hidden="true" />
    </a>
  )
}

export function PortfolioImportGuide({ onImport }: { onImport?: (institution: string) => void }) {
  const [source, setSource] = useState<Source>('Fidelity')
  const contentId = useId()
  return (
    <div className="portfolio-import-guide">
      <div className="guide-sources" role="group" aria-label="Choose your institution">
        {sources.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={source === name}
            aria-controls={contentId}
            onClick={() => setSource(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <ol id={contentId} className="guide-steps">
        <li>
          <h3>
            {source === 'Bank' ? 'Get a balance statement' : 'Download your current positions'}
          </h3>
          {source === 'Fidelity' && (
            <>
              <p>
                Sign in to Fidelity on the web. Open{' '}
                <b>Accounts &amp; Trade → Portfolio → Positions</b>. Select the accounts you want,
                then choose <b>Download</b> above the positions table and save the CSV.
              </p>
              <HelpLink href="https://www.fidelity.com/webxpress/help/topics/learn_portfolio_positions.shtml">
                Fidelity’s positions help
              </HelpLink>
            </>
          )}
          {source === 'Other brokerage' && (
            <>
              <p>
                Open your broker’s <b>Holdings</b> or <b>Positions</b> view and export the full
                account as CSV. On Schwab, start at <b>Accounts → Positions</b>. StockReplay also
                reads OFX and QFX files that include investment positions.
              </p>
              <HelpLink href="https://www.schwab.com/content/how-to-check-positions">
                Schwab’s positions guide
              </HelpLink>
            </>
          )}
          {source === 'Bank' && (
            <>
              <p>
                Download an OFX or Quicken Web Connect (QFX) file that includes the closing ledger
                balance. At Wells Fargo, open <b>Accounts → Download Account Activity</b> and look
                for the Quicken Web Connect format.
              </p>
              <HelpLink href="https://www.wellsfargo.com/help/online-banking/activity-faqs/">
                Wells Fargo’s download help
              </HelpLink>
            </>
          )}
        </li>
        <li>
          <h3>
            {source === 'Bank' ? 'Choose the balance to import' : 'Choose your file in StockReplay'}
          </h3>
          {source === 'Fidelity' && (
            <p>
              In <b>Portfolio → Import statement</b>, select the CSV and enter the statement date if
              your export omits it. StockReplay reads Fidelity’s column names and groups the
              positions by account.
            </p>
          )}
          {source === 'Other brokerage' && (
            <p>
              In <b>Portfolio → Import statement</b>, enter the institution and choose the file. For
              a CSV, each row needs a symbol or description and a quantity or market value. Open{' '}
              <b>Map another broker’s CSV columns</b> to match unfamiliar headers.
            </p>
          )}
          {source === 'Bank' && (
            <p>
              In <b>Portfolio → Import statement</b>, enter the bank’s name and select the file. If
              your download only lists transactions, use the blank CSV below. Enter one row per
              account with a description, market value, currency and statement date.
            </p>
          )}
        </li>
        <li>
          <h3>Review and save locally</h3>
          <p>
            Choose <b>Preview statement</b>. Check the accounts, dates, currencies and values
            against your statement. Select <b>Apply reviewed statement</b> to save the holdings on
            this Mac.
          </p>
        </li>
      </ol>
      <details className="guide-more">
        <summary>
          <BookOpen size={15} aria-hidden="true" /> CSV template and future updates
        </summary>
        <p>
          Fill one row per investment or cash balance in the blank template. Use a consistent
          account nickname when your file omits the account number. Enter dates as YYYY-MM-DD and
          currencies as three-letter codes, such as USD.
        </p>
        <a className="source-link" href="/stockreplay-positions-template.csv" download>
          <ArrowDownToLine size={14} aria-hidden="true" /> Download blank holdings CSV
        </a>
        <p>
          To refresh an account, use a complete current snapshot with the same institution and
          account identifier. Applying it replaces that account’s previous positions, including
          manual entries. The preview shows how many positions will be replaced.
        </p>
      </details>
      {onImport && (
        <button
          type="button"
          className="btn primary guide-start"
          onClick={() => onImport(source === 'Fidelity' ? source : '')}
        >
          Choose a statement <ArrowRight size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
