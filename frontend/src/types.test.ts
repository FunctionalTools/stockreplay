import { afterEach, describe, it, expect, vi } from 'vitest'
import { api, pct } from './types'

afterEach(() => vi.unstubAllGlobals())
describe('research presentation', () => {
  it('distinguishes missing returns and true zero', () => {
    expect(pct(null)).toBe('—')
    expect(pct(0)).toBe('0.00%')
    expect(pct(0.25)).toBe('+0.25%')
    expect(pct(-2)).toBe('-2.00%')
  })
  it('renders server validation errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: [{ loc: ['body', 'holding'], msg: 'invalid' }] }), {
          status: 422,
        }),
      ),
    )
    await expect(api('/validate', 'POST', {})).rejects.toThrow('holding invalid')
  })
})
