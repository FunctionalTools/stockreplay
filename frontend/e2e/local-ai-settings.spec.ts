import { expect, test } from '@playwright/test'

const local = {
  provider: 'ollama',
  model: 'qwen2.5:3b',
  configured: false,
  verified: false,
  verified_at: null,
  storage: 'Local',
}
const cloud = {
  provider: 'openai',
  model: 'gpt-4.1-mini',
  configured: false,
  verified: false,
  verified_at: null,
  storage: 'Session',
}
test('fresh Mac guide explains the public local download, setup and offline workflow without a key', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const cloudCalls: string[] = []
  await page.route('**/api/openai**', (route) => {
    cloudCalls.push(route.request().url())
    return route.abort()
  })
  await page.route('**/api/ai', (route) => route.fulfill({ json: local }))
  await page.route('**/api/ai/ollama/models', (route) =>
    route.fulfill({
      json: {
        running: false,
        models: [],
        recommended: local.model,
        error: 'Open Ollama on this Mac.',
      },
    }),
  )
  await page.goto('/#/settings/SPY')
  await expect(page.getByLabel('AI provider')).toHaveValue('ollama')
  await expect(page.getByLabel('OpenAI API key')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Connect & test' })).toBeDisabled()
  await expect(page.getByText('Open Ollama on this Mac.')).toBeVisible()
  await page.getByRole('button', { name: 'Free Mac setup guide' }).click()
  const guide = page.getByRole('dialog', { name: 'Free Mac setup guide' })
  expect(
    await guide.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1)
  await expect(guide.getByText(/macOS Sonoma 14 or newer/)).toBeVisible()
  await expect(guide.getByText(/Intel Macs run the model on the CPU/)).toBeVisible()
  await expect(guide.getByRole('link', { name: 'Download Ollama for Mac' })).toHaveAttribute(
    'href',
    'https://ollama.com/download/mac',
  )
  await expect(guide.getByRole('button', { name: 'Copy ollama pull qwen2.5:3b' })).toBeVisible()
  await guide.getByLabel('Model to download').selectOption('qwen2.5:7b')
  await expect(guide.getByRole('button', { name: 'Copy ollama pull qwen2.5:7b' })).toBeVisible()
  await expect(
    guide.getByRole('link', { name: 'Model details and download size' }),
  ).toHaveAttribute('href', 'https://ollama.com/library/qwen2.5:7b')
  await guide.getByText('Privacy, offline use and storage').click()
  await expect(guide.getByText(/Fresh prices, stories and event dates need internet/)).toBeVisible()
  await guide.getByText('Ollama, a model or market data is unavailable').click()
  await expect(
    guide.getByRole('button', { name: 'Copy curl http://127.0.0.1:11434/api/tags' }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(guide).toHaveCount(0)
  expect(cloudCalls).toEqual([])
})

test('installed models refresh, real-test endpoint failure and success, and explicit cloud switching', async ({
  page,
}) => {
  let active = { ...local }
  let installed = false
  let succeed = false
  const tested: unknown[] = []
  const switched: string[] = []
  await page.route('**/api/ai', async (route) => {
    if (route.request().method() === 'PATCH') {
      const provider = route.request().postDataJSON().provider
      switched.push(provider)
      active = { ...(provider === 'openai' ? cloud : local) }
    }
    return route.fulfill({ json: active })
  })
  await page.route('**/api/ai/ollama/models', (route) =>
    route.fulfill({
      json: {
        running: true,
        recommended: local.model,
        models: installed
          ? [
              { id: local.model, label: local.model },
              { id: 'qwen2.5:7b', label: 'qwen2.5:7b' },
            ]
          : [],
      },
    }),
  )
  await page.route('**/api/ai/ollama', (route) => {
    const body = route.request().postDataJSON()
    tested.push(body)
    if (!succeed)
      return route.fulfill({
        status: 503,
        json: { detail: 'Local model could not generate a response.' },
      })
    active = { ...local, model: body.model, configured: true, verified: true }
    return route.fulfill({ json: active })
  })
  await page.goto('/#/settings/SPY')
  await expect(page.getByText(/Download a local chat model/)).toBeVisible()
  installed = true
  await page.getByRole('button', { name: 'Refresh models' }).click()
  await page.getByLabel('Installed local model').selectOption('qwen2.5:7b')
  await page.getByRole('button', { name: 'Connect & test' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Local model could not generate a response.' }),
  ).toBeVisible()
  await expect(page.getByText(/Verified for generation/)).toHaveCount(0)
  succeed = true
  await page.getByRole('button', { name: 'Connect & test' }).click()
  await expect(page.getByText('Verified for generation · qwen2.5:7b')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Installed local model')).toHaveValue('qwen2.5:7b')
  expect(tested).toEqual([{ model: 'qwen2.5:7b' }, { model: 'qwen2.5:7b' }])
  expect(switched).toEqual([])
  await page.getByLabel('AI provider').selectOption('openai')
  await expect(page.getByLabel('OpenAI API key')).toBeVisible()
  await expect(page.getByText(/Your API project pays/)).toBeVisible()
  await page.getByLabel('AI provider').selectOption('ollama')
  await expect(page.getByLabel('Installed local model')).toBeVisible()
  await expect(page.getByLabel('OpenAI API key')).toHaveCount(0)
  expect(switched).toEqual(['openai', 'ollama'])
})
