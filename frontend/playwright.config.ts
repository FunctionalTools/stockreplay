import { defineConfig } from '@playwright/test'
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
    browserName: process.env.STOCKREPLAY_BROWSER === 'webkit' ? 'webkit' : 'chromium',
    baseURL: 'http://127.0.0.1:' + port,
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath:
        process.env.STOCKREPLAY_BROWSER === 'webkit'
          ? undefined
          : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
  },
  webServer: {
    command: '../.venv/bin/python ../scripts/e2e_server.py ' + port,
    url: 'http://127.0.0.1:' + port + '/api/health',
    timeout: 45000,
    reuseExistingServer: false,
  },
})
