export type Any = any

export class ApiError extends Error {
  status: number
  details: Any
  constructor(message: string, status: number, details: Any = null) {
    super(message)
    this.status = status
    this.details = details
  }
}

export async function api<T = Any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) }
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { credentials: 'include', ...init, headers })
  const type = res.headers.get('content-type') || ''
  if (!res.ok) {
    let message = `请求失败（${res.status}）`
    let details = null
    if (type.includes('application/json')) {
      try { const body = await res.json(); message = body.error || message; details = body.details } catch { /* 忽略 */ }
    }
    throw new ApiError(message, res.status, details)
  }
  if (type.includes('application/json')) return res.json()
  return (await res.text()) as T
}

export const get = <T = Any>(path: string) => api<T>(path)
export const post = <T = Any>(path: string, body?: Any) => api<T>(path, { method: 'POST', body: JSON.stringify(body || {}) })
export const put = <T = Any>(path: string, body?: Any) => api<T>(path, { method: 'PUT', body: JSON.stringify(body || {}) })
export const patch = <T = Any>(path: string, body?: Any) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body || {}) })
export const del = <T = Any>(path: string) => api<T>(path, { method: 'DELETE' })

export function readFile(file: File): Promise<{ name: string; base64: string; size: number; type: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name, base64: String(reader.result || ''), size: file.size, type: file.type })
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

export const fmtTime = (v?: string) => v ? v.slice(0, 19).replace('T', ' ') : '—'
export const fmtDay = (v?: string) => v ? v.slice(0, 10) : '—'

export { PRIORITY_TONE, STATUS_TONE as TONE } from './status'

export function parseHash(): string[] {
  const raw = location.hash.replace(/^#/, '') || '/projects'
  return raw.split('/').filter(Boolean)
}

export function navigate(path: string) {
  if (location.hash === '#' + path) return
  location.hash = path
}

export function downloadUrl(path: string) {
  const a = document.createElement('a')
  a.href = path
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
