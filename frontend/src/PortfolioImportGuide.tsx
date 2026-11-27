import { useId, useState, type ReactNode } from 'react'
import { ArrowDownToLine, ArrowRight, BookOpen, ExternalLink } from 'lucide-react'
import './portfolioImport.css'

export type ImportMode = 'file' | 'balance'

type Guide = {
  name: string
  group: 'Brokerages' | 'Banks' | 'Other'
  snapshot: 'positions' | 'ledger' | 'balance'
  getFile: ReactNode
  prepare?: ReactNode
  links?: { name: string; href: string }[]
}
const guides: Guide[] = [
  {
    name: 'Fidelity',
    group: 'Brokerages',
    snapshot: 'positions',
    getFile: (
      <>
        Open <b>Accounts &amp; Trade → Portfolio → Positions</b> on Fidelity.com. Select the
        accounts to include, choose <b>Download</b> above the positions table and save the CSV.
      </>
    ),
    prepare: (
      <>
        Keep the account, symbol, quantity and current value columns. Fidelity’s account numbers
        group positions automatically. Enter the statement date if the file omits it.
      </>
    ),
    links: [
      {
        name: 'Fidelity’s positions help',
        href: 'https://www.fidelity.com/webxpress/help/topics/learn_portfolio_positions.shtml',
      },
    ],
  },
  {
    name: 'Charles Schwab',
    group: 'Brokerages',
    snapshot: 'positions',
    getFile: (
      <>
        On Schwab.com open <b>Accounts → Positions</b> and select one account. If the positions
        table offers a CSV export, save it. You can also copy the holdings into the blank CSV below.
      </>
    ),
    prepare: (
      <>
        Keep one row per investment plus any cash position. Keep the column headings, including
        quantity and market value. Enter the same account nickname each time you import a
        single-account file.
      </>
    ),
    links: [
      {
        name: 'Schwab’s positions guide',
        href: 'https://www.schwab.com/content/how-to-check-positions',
      },
    ],
  },
  {
    name: 'Interactive Brokers',
    group: 'Brokerages',
    snapshot: 'positions',
    getFile: (
      <>
        In Client Portal, open <b>Performance &amp; Reports → Flex Queries</b>. Use <b>+</b> beside
        Activity Flex Query. Select the <b>Open Positions</b> section with summary rows. Choose{' '}
        <b>CSV</b> and <b>Last Business Day</b>, save the query and run it.
      </>
    ),
    prepare: (
      <>
        Include Account ID, Symbol, Quantity, Mark Price, Position Value, Currency and Report Date.
        Export just the positions table with field names. Include Cost Basis Money if you track cost
        basis.
      </>
    ),
    links: [
      {
        name: 'IBKR’s Flex Query instructions',
        href: 'https://www.ibkrguides.com/clientportal/performanceandstatements/activityflex.htm',
      },
      {
        name: 'IBKR’s Open Positions fields',
        href: 'https://www.ibkrguides.com/reportingreference/reportguide/open%20positionsfq.htm',
      },
    ],
  },
  {
    name: 'Wells Fargo',
    group: 'Banks',
    snapshot: 'ledger',
    getFile: (
      <>
        In Wells Fargo Online choose your account, then <b>Accounts → Download Account Activity</b>.
        Choose the date range and Quicken Web Connect format if offered. Save the QFX file.
      </>
    ),
    prepare: (
      <>
        StockReplay reads the closing ledger balance and its date from a QFX or OFX bank statement.
        If your download contains only transactions, choose <b>Enter statement balance</b> and use
        the ending balance from your statement.
      </>
    ),
    links: [
      {
        name: 'Wells Fargo’s download help',
        href: 'https://www.wellsfargo.com/help/online-banking/activity-faqs/',
      },
    ],
  },
  {
    name: 'Chase',
    group: 'Banks',
    snapshot: 'balance',
    getFile: (
      <>
        On chase.com open the <b>Main Menu → Statements &amp; documents</b>. Choose the checking or
        savings account and year. Use <b>Open</b> or <b>Save</b> beside the statement you want.
      </>
    ),
    links: [
      {
        name: 'Chase’s statement instructions',
        href: 'https://www.chase.com/personal/mobile-online-banking/login-paperless',
      },
    ],
  },
  {
    name: 'Bank of America',
    group: 'Banks',
    snapshot: 'balance',
    getFile: (
      <>
        In Online Banking open <b>Accounts → Statements &amp; Documents</b>. Choose your checking or
        savings statement and open its PDF. For an older copy, the same area has{' '}
        <b>Request statements</b>.
      </>
    ),
    links: [
      {
        name: 'Bank of America’s statement help',
        href: 'https://info.bankofamerica.com/en/digital-banking',
      },
    ],
  },
  {
    name: 'Capital One',
    group: 'Banks',
    snapshot: 'balance',
    getFile: (
      <>
        Sign in to capitalone.com, select the bank account and choose <b>View statements</b>. Open
        the statement for the period you want. Online access requires paperless enrollment. A
        combined statement can list several accounts.
      </>
    ),
    links: [
      {
        name: 'Capital One’s online statement guide',
        href: 'https://www.capitalone.com/help-center/checking-savings/online-statements/',
      },
    ],
  },
  {
    name: 'Another brokerage',
    group: 'Other',
    snapshot: 'positions',
    getFile: (
      <>
        Open the broker’s <b>Holdings</b> or <b>Positions</b> view. Download a complete snapshot in
        CSV, OFX or QFX format. StockReplay reads OFX and QFX investment files with positions.
      </>
    ),
  },
  {
    name: 'Another bank',
    group: 'Other',
    snapshot: 'ledger',
    getFile: (
      <>
        Download the bank’s OFX or Quicken Web Connect (QFX) statement with a closing ledger
        balance, or open your regular statement to find its ending balance and date.
      </>
    ),
    prepare: (
      <>
        Choose <b>Import a local file</b> for OFX, QFX, or a CSV with one balance row per account.
        For a PDF or a paper statement, choose <b>Enter statement balance</b>. Transaction activity
        lists individual purchases and deposits.
      </>
    ),
  },
]

export function guideInstitution(name: string) {
  return guides.find((guide) => guide.name === name && guide.group !== 'Other')?.name || ''
}

export function PortfolioImportGuide({
  onImport,
  initialInstitution = 'Fidelity',
}: {
  onImport?: (guideName: string, mode: ImportMode) => void
  initialInstitution?: string
}) {
  const [selected, setSelected] = useState(
    guides.some((g) => g.name === initialInstitution) ? initialInstitution : 'Another brokerage',
  )
  const guide = guides.find((g) => g.name === selected)!
  const isBank = guide.snapshot !== 'positions'
  const isBalance = guide.snapshot === 'balance'
  const id = useId()
  const template = isBank
    ? '/stockreplay-bank-balances-template.csv'
    : '/stockreplay-positions-template.csv'
  const backupMode = isBalance ? 'file' : 'balance'
  return (
    <div className="portfolio-import-guide">
      <label className="field guide-picker">
        <span>Choose your institution</span>
        <select value={guide.name} onChange={(e) => setSelected(e.target.value)} aria-controls={id}>
          {(['Brokerages', 'Banks', 'Other'] as const).map((group) => (
            <optgroup label={group} key={group}>
              {guides
                .filter((g) => g.group === group)
                .map((g) => (
                  <option key={g.name}>{g.name}</option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <ol id={id} className="guide-steps">
        <li>
          <h3>
            {isBalance
              ? 'Open your account statement'
              : isBank
                ? 'Download a balance statement'
                : 'Get your current positions'}
          </h3>
          <p>{guide.getFile}</p>
          {guide.links && (
            <div className="guide-links">
              {guide.links.map((link) => (
                <a
                  key={link.href}
                  className="source-link"
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {link.name} <ExternalLink size={13} aria-hidden="true" />
                </a>
              ))}
            </div>
          )}
        </li>
        <li>
          <h3>
            {isBalance
              ? 'Enter the closing balance'
              : isBank
                ? 'Check for a closing balance'
                : 'Prepare your holdings file'}
          </h3>
          <p>
            {guide.prepare ||
              (isBalance ? (
                <>
                  Choose <b>Enter statement balance</b>. Give the account a nickname, then enter its
                  ending balance, currency and closing date. Use a separate entry for each account.
                  The PDF stays with you.
                </>
              ) : (
                <>
                  The CSV needs a symbol or description and a quantity or market value. Use{' '}
                  <b>Map another broker’s CSV columns</b> to match unfamiliar headers.
                </>
              ))}
          </p>
        </li>
        <li>
          <h3>Review and save on this Mac</h3>
          <p>
            Choose <b>Preview statement</b>. Check the account, values, currency and date, then{' '}
            <b>Apply reviewed statement</b>. An update replaces the existing positions in each
            matching account.
          </p>
        </li>
      </ol>
      <details className="guide-more">
        <summary>
          <BookOpen size={15} aria-hidden="true" /> CSV template and future updates
        </summary>
        <p>
          {isBank
            ? 'Enter one row per account. Include the account name, a description such as “Closing balance”, the balance, its currency and the statement date.'
            : 'Enter one row per investment or cash position. Use Market Value for the total value of the row and Total Cost Basis for its full cost basis.'}{' '}
          Use three-letter currencies and dates in YYYY-MM-DD format.
        </p>
        <a className="source-link" href={template} download>
          <ArrowDownToLine size={14} aria-hidden="true" />{' '}
          {isBank ? 'Download blank bank balance CSV' : 'Download blank holdings CSV'}
        </a>
        <p>
          Reuse the same institution and account identifier each time. For files without account
          numbers, use the same nickname. A nickname-only entry and an account-number export create
          separate accounts. Review the replacement count before applying a complete snapshot,
          including any positions entered by hand.
        </p>
      </details>
      {onImport && (
        <div className="guide-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => onImport(guide.name, isBalance ? 'balance' : 'file')}
          >
            {isBalance ? 'Enter statement balance' : 'Import a local file'}{' '}
            <ArrowRight size={15} aria-hidden="true" />
          </button>
          {isBank && (
            <button type="button" className="btn" onClick={() => onImport(guide.name, backupMode)}>
              {isBalance ? 'Import a local file' : 'Enter statement balance'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
