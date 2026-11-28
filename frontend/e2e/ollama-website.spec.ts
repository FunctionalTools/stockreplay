import { expect, test } from '@playwright/test'

const model = 'gpt-oss:20b'
const saved = { configured: false, verified: false, verified_at: null, storage: 'session' }
const local = { provider: 'ollama', model: 'qwen2.5:3b', ...saved }

test('both website keys are visible on a fresh Mac and hosted setup persists without a local model', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const hosted = {
    ...saved,
    provider: 'ollama_cloud',
    model,
    web_search: { verified: false },
  }
  let provider = 'ollama'
  const model2 = 'gpt-oss:120b'
  const unexpected: string[] = []
  await page.route('**/api/ai', (route) => {
    if (route.request().method() === 'PATCH') provider = route.request().postDataJSON().provider
    return route.fulfill({ json: provider === 'ollama' ? local : hosted })
  })
  await page.route('**/api/ai/ollama/models', (route) =>
    route.fulfill({ json: { running: false, models: [] } }),
  )
  await page.route('**/api/openai**', (route) => {
    unexpected.push(route.request().url())
    return route.abort()
  })
  await page.route('**/api/ai/ollama-cloud/models', (route) =>
    route.fulfill({ json: { models: [model, model2].map((id) => ({ id, label: id })) } }),
  )
  await page.route('**/api/ai/ollama-cloud', (route) => {
    expect(route.request().method()).toBe('PUT')
    expect(route.request().postDataJSON()).toEqual({
      key: 'hosted-browser-fixture',
      model: model2,
      remember: true,
    })
    Object.assign(hosted, {
      model: model2,
      configured: true,
      verified: true,
      storage: 'macOS Keychain',
      web_search: { verified: true },
    })
    return route.fulfill({ json: hosted })
  })
  await page.goto('/#/settings')
  const choices = page.getByRole('group', { name: 'AI provider' })
  const ollama = choices.getByRole('radio', { name: /^Ollama website API/ })
  await expect(ollama).toBeInViewport()
  await expect(choices.getByRole('radio', { name: /^OpenAI API/ })).toBeInViewport()
  await expect(choices.getByRole('radio', { name: /^On this Mac/ })).toBeChecked()
  await ollama.check()
  const key = page.getByLabel('Ollama website API key', { exact: true })
  await expect(key).toBeInViewport()
  await expect(page.getByRole('link', { name: 'Get an Ollama API key' })).toHaveAttribute(
    'href',
    'https://ollama.com/settings/keys',
  )
  await expect(page.getByLabel('Installed local model')).toHaveCount(0)
  await expect(page.getByLabel('Ollama web search API key')).toHaveCount(0)
  await key.fill('  hosted-browser-fixture  ')
  await page.getByLabel('API model').selectOption(model2)
  await page.getByLabel('Remember key in macOS Keychain').check()
  await page.getByRole('button', { name: 'Connect & test' }).click()
  await expect(page.getByText(/Model generation · Verified/)).toBeVisible()
  await expect(page.getByText('Web search · Verified')).toBeVisible()
  await page.reload()
  await expect(ollama).toBeChecked()
  await expect(page.getByLabel('API model')).toHaveValue(model2)
  await expect(key).toHaveValue('')
  await expect(page.getByLabel('Remember key in macOS Keychain')).toBeChecked()
  await key.fill('replacement')
  await expect(page.getByText(/Connect & test to verify this key and model/)).toBeVisible()
  await expect(page.getByText(/Model generation · Verified/)).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  expect(unexpected).toEqual([])
})

test('a failed provider switch leaves the previous provider usable', async ({ page }) => {
  await page.route('**/api/ai', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, json: { detail: 'Provider change could not be saved.' } })
      : route.fulfill({ json: local }),
  )
  await page.goto('/#/settings')
  await page.getByRole('radio', { name: /^Ollama website API/ }).click()
  await expect(page.getByText('Provider change could not be saved.')).toBeVisible()
  await expect(page.getByRole('radio', { name: /^On this Mac/ })).toBeChecked()
  await expect(page.getByLabel('Installed local model')).toBeVisible()
})

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
  await expect(page.getByRole('radio', { name: /^On this Mac/ })).toBeChecked()
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
