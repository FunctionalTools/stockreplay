export const pct = (n: number | null | undefined, sign = true, digits = 2) =>
  n == null ? '—' : (sign && n > 0 ? '+' : '') + n.toFixed(digits) + '%'
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json().catch(() => ({
    detail: 'The local service returned an unreadable response.',
  }))
  if (!response.ok)
    throw Error(
      Array.isArray(value.detail)
        ? value.detail
            .map((v: { loc: string[]; msg: string }) => v.loc.slice(1).join('.') + ' ' + v.msg)
            .join(' · ')
        : value.detail || 'Request failed.',
    )
  return value as T
}
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
