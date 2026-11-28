import { expect, test } from '@playwright/test'

const model = 'gpt-oss:20b'
const saved = { configured: false, verified: false, verified_at: null, storage: 'session' }
const local = { provider: 'ollama', model: 'qwen2.5:3b', ...saved }

test('a website key can verify web search while inference stays local', async ({ page }) => {
  const hostedCalls: string[] = []
  let connected = false
  await page.route('**/api/ai', (route) => route.fulfill({ json: local }))
  await page.route('**/api/ai/ollama-cloud**', (route) => {
    hostedCalls.push(route.request().url())
    return route.abort()
  })
  await page.route('**/api/ai/ollama-search', (route) => {
    if (route.request().method() === 'PUT') {
      expect(route.request().postDataJSON()).toEqual({ key: 'search-fixture', remember: false })
      connected = true
    }
    if (route.request().method() === 'DELETE') connected = false
    return route.fulfill({ json: { ...saved, configured: connected, verified: connected } })
  })
  const shell = await page.goto('/#/settings')
  expect(shell?.headers()['cache-control']).toContain('no-cache')
  await page.getByLabel('Ollama web search API key').fill('search-fixture')
  await page.getByRole('button', { name: 'Test web search' }).click()
  await expect(page.getByText(/Web search verified/)).toBeVisible()
  await expect(page.getByLabel('AI provider')).toHaveValue('ollama')
  await expect(page.getByLabel('Ollama web search API key')).toHaveValue('')
  await page.reload()
  await expect(page.getByText(/Web search verified/)).toBeVisible()
  await page.getByRole('button', { name: 'Remove search key' }).click()
  await expect(page.getByText('Search key removed.')).toBeVisible()
  expect(hostedCalls).toEqual([])
})

test('hosted Ollama shows generation and search permissions independently', async ({ page }) => {
  const entry = { provider: 'ollama_cloud', model, ...saved }
  const attempts: string[] = []
  await page.route('**/api/ai', (route) => route.fulfill({ json: entry }))
  await page.route('**/api/ai/ollama-cloud/models', (route) =>
    route.fulfill({ json: { models: [{ id: model, label: model }] } }),
  )
  await page.route('**/api/ai/ollama-cloud', (route) => {
    const key = route.request().postDataJSON().key
    attempts.push(key)
    if (key === 'rejected-test-key')
      return route.fulfill({ status: 401, json: { detail: 'Ollama rejected the key.' } })
    return route.fulfill({
      json: {
        ...entry,
        configured: true,
        web_search: { verified: true },
        generation_detail: 'The selected model has reached its quota.',
      },
    })
  })
  await page.goto('/#/settings')
  const input = page.getByLabel('Ollama website API key')
  await expect(page.getByRole('link', { name: 'Cloud pricing' })).toBeVisible()
  await input.fill('rejected-test-key')
  await page.getByRole('button', { name: 'Connect & test' }).click()
  await expect(page.getByRole('alert')).toContainText('Ollama rejected the key.')
  await input.fill('search-only-test-key')
  await page.getByRole('button', { name: 'Connect & test' }).click()
  await expect(page.getByText('Web search · Verified')).toBeVisible()
  await expect(page.getByText(/Model generation · Unverified/)).toBeVisible()
  await expect(page.getByText('The selected model has reached its quota.')).toBeVisible()
  await expect(input).toHaveValue('')
  expect(attempts).toEqual(['rejected-test-key', 'search-only-test-key'])
})
