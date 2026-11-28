import { useState } from 'react'
import { Copy } from 'lucide-react'
import { SourceLink } from './deskCommon'
import { Field, Modal } from './ui'
import './macSetup.css'

const choices = [
  {
    id: 'qwen2.5:3b',
    size: '1.9 GB',
    use: 'Start here. Its smaller download suits Intel Macs and MacBooks with limited free memory.',
  },
  {
    id: 'qwen2.5:7b',
    size: '4.7 GB',
    use: 'Try this larger model if your Mac has memory to spare, especially on Apple silicon. It may take longer to answer.',
  },
]

function Command({ command }: { command: string }) {
  const [message, setMessage] = useState('')
  return (
    <div className="mac-guide-command">
      <code tabIndex={0}>{command}</code>
      <button
        className="icon-btn"
        type="button"
        aria-label={'Copy ' + command}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command)
            setMessage('Copied')
          } catch {
            setMessage('Select the command and press ⌘C.')
          }
        }}
      >
        <Copy size={14} aria-hidden="true" />
      </button>
      {message && <small role="status">{message}</small>}
    </div>
  )
}

export function MacSetupGuide({ close }: { close: () => void }) {
  const [choice, setChoice] = useState(choices[0].id)
  const model = choices.find((item) => item.id === choice)!
  return (
    <Modal title="Free Mac setup guide" close={close} wide>
      <div className="modal-body mac-guide">
        <p>
          Run StockReplay and its AI on your MacBook or desktop Mac. The local setup uses public
          downloads and works without signing in, entering a key or enabling API billing.
        </p>
        <ol className="mac-steps">
          <li>
            <h3>Check your Mac</h3>
            <p>
              Open <strong> → About This Mac</strong> to see the macOS version, chip and memory.
              Ollama requires macOS Sonoma 14 or newer. Apple M-series chips support GPU
              acceleration. Intel Macs run the model on the CPU and can take longer.
            </p>
            <SourceLink url="https://support.apple.com/en-us/116943">
              Identify your Mac’s chip
            </SourceLink>
            {' · '}
            <SourceLink url="https://docs.ollama.com/macos">Ollama’s macOS requirements</SourceLink>
          </li>
          <li>
            <h3>Install and open Ollama</h3>
            <p>
              Download the Mac installer. Open the disk image in Finder, drag{' '}
              <strong>Ollama</strong> to <strong>Applications</strong> and open it. Allow its prompt
              to install the Terminal command. You can reopen the app later from Applications or
              Terminal.
            </p>
            <SourceLink url="https://ollama.com/download/mac">Download Ollama for Mac</SourceLink>
            <details>
              <summary>Install from Terminal instead</summary>
              <p>
                Ollama’s official install command also supports macOS. Run it once, then open
                Ollama.
              </p>
              <Command command="curl -fsSL https://ollama.com/install.sh | sh" />
            </details>
            <Command command="open -a Ollama" />
          </li>
          <li>
            <h3>Download one model</h3>
            <Field name="Model to download">
              <select value={model.id} onChange={(e) => setChoice(e.target.value)}>
                {choices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} · {item.size}
                  </option>
                ))}
              </select>
            </Field>
            <p>
              {model.use} Sizes are disk downloads. Allow extra free storage and memory for macOS,
              StockReplay and the running model.
            </p>
            <p>
              In the Ollama app, use its model picker to download <strong>{model.id}</strong> if
              listed. Wait for the download, then continue to StockReplay.{' '}
              <SourceLink url="https://ollama.com/blog/new-app">Ollama’s Mac app</SourceLink>
            </p>
            <p>
              To get this exact version in Terminal, open{' '}
              <strong>Applications → Utilities → Terminal</strong>. Run each command in order. The
              first downloads the model. The second should list its exact name.
            </p>
            <Command key={model.id} command={'ollama pull ' + model.id} />
            <Command command="ollama ls" />
            <SourceLink url={'https://ollama.com/library/' + model.id}>
              Model details and download size
            </SourceLink>
            {' · '}
            <SourceLink url="https://docs.ollama.com/cli">Ollama commands</SourceLink>
          </li>
          <li>
            <h3>Connect StockReplay</h3>
            <p>
              For a fresh copy, open the repository’s <strong>Code → Download ZIP</strong>, unzip it
              in Finder and double-click <strong>StockReplay.command</strong>. You can also run{' '}
              <code>./StockReplay.command</code> inside a checkout. The first launch downloads
              dependencies and opens the local website.
            </p>
            <p>
              In <strong>Settings → AI provider</strong>, choose <strong>On this Mac</strong>. Use{' '}
              <strong>Refresh models</strong>, select the downloaded model and click{' '}
              <strong>Connect &amp; test</strong>. Wait for <strong>Verified for generation</strong>
              . To add Ollama’s web search, paste a website key under{' '}
              <strong>Add web search to your local model</strong> and choose{' '}
              <strong>Test web search</strong>.
            </p>
            <SourceLink url="https://github.com/FunctionalTools/stockreplay">
              StockReplay repository
            </SourceLink>
          </li>
          <li>
            <h3>Try a stock, a forecast and a question</h3>
            <p>
              In <strong>Research</strong>, select a ticker, review the dated news and click{' '}
              <strong>Generate scores</strong>. Open the buy and risk reasons to check the cited
              evidence. Open <strong>Forecast calendar</strong> for projected price ranges and
              sourced company or market events.
            </p>
            <p>
              Open the assistant at the bottom right and ask “What are the risks for MSFT?” or
              “Graph AAPL today.” Watchlists and portfolio imports are available immediately.
              Prices, analyst ratings, public news and event feeds use internet access and require
              no paid data key.
            </p>
          </li>
        </ol>
        <details className="mac-guide-more">
          <summary>Keep a watchlist, portfolio and research history</summary>
          <p>
            Open <strong>Watchlists</strong>, create a list, then add the tickers you follow. In{' '}
            <strong>Portfolio → Import guide</strong>, choose your bank or broker for export
            instructions. Preview your file and review the accounts before applying the statement.
          </p>
          <p>
            Open the assistant’s history menu to resume a chat. Ask it to create a named tab for the
            stocks and charts you follow, then reopen it from <strong>My tabs</strong>. StockReplay
            keeps these on this Mac between sessions.
          </p>
          <a className="source-link" href="#/portfolio">
            Open Portfolio
          </a>
          {' · '}
          <a className="source-link" href="#/watchlists">
            Open Watchlists
          </a>
        </details>
        <details className="mac-guide-more">
          <summary>Privacy, offline use and storage</summary>
          <p>
            With the local provider selected, StockReplay sends model prompts to Ollama on this Mac.
            Quotes and articles contact public sources for the ticker you research. Private
            portfolio balances, saved chats and tabs live in StockReplay’s local database.
          </p>
          <p>
            After installation and model download, you can use the local model offline. Existing
            holdings, watchlists and saved research stay available. Fresh prices, stories and event
            dates need internet. Check source timestamps and cached-data labels when revisiting
            research.
          </p>
          <p>
            Ollama keeps model files in <code>~/.ollama/models</code>. StockReplay’s default data
            directory is <code>.stockreplay</code> in your checkout. To back it up, stop StockReplay
            and copy that directory.
          </p>
          <SourceLink url="https://docs.ollama.com/faq">Local storage and settings</SourceLink>
        </details>
        <details className="mac-guide-more">
          <summary>Ollama, a model or market data is unavailable</summary>
          <p>
            <strong>Cannot connect.</strong> Open Ollama in Applications. Check its local address in
            Terminal. A healthy server returns JSON with a models list. If the Mac app is closed,
            you can start the server with <code>ollama serve</code> in a separate Terminal window
            and leave that window open.
          </p>
          <Command command="curl http://127.0.0.1:11434/api/tags" />
          <p>
            <strong>Model list empty.</strong> Confirm the model download finished, run{' '}
            <code>ollama ls</code>, then choose <strong>Refresh models</strong>. StockReplay needs
            an installed local chat model. A cloud tag or an embedding model cannot power this
            setup.
          </p>
          <p>
            <strong>Slow or invalid response.</strong> The first call loads model weights. Close
            memory-heavy apps, choose the smaller model if memory is tight, and retest. If a model
            struggles to generate the requested format, try the other size when memory permits.
          </p>
          <p>
            <strong>Missing market evidence.</strong> Check your internet connection, the selected
            ticker and the source timestamp. Retry when the public feed is available. Some tickers
            have no published events or coverage. Use saved research while offline.
          </p>
          <SourceLink url="https://docs.ollama.com/api/tags">Local model list endpoint</SourceLink>
        </details>
      </div>
    </Modal>
  )
}
