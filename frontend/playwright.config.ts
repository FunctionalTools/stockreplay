import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(
  new URL('../.local/browsers', import.meta.url),
)
const port = Number(process.env.STOCKREPLAY_TEST_PORT || 18765)
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 240000,
  expect: { timeout: 20000 },
  use: {
    baseURL: 'http://127.0.0.1:' + port,
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    },
  },
  webServer: {
    command: '../.venv/bin/python ../scripts/e2e_server.py ' + port,
    url: 'http://127.0.0.1:' + port + '/api/health',
    timeout: 45000,
    reuseExistingServer: false,
  },
})
