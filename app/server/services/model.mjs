import { get, parseJson } from '../db.mjs'
import { decryptSecret } from '../core.mjs'

export function modelConfig(projectId) {
  const row = get('SELECT value FROM settings WHERE key = ?', `model:${projectId}`)
  if (!row) return null
  const cfg = parseJson(row.value, null)
  if (!cfg?.baseUrl || !cfg?.model || !cfg?.apiKeyEnc) return null
  return { ...cfg, apiKey: decryptSecret(cfg.apiKeyEnc) }
}

export async function callModel(cfg, messages, tools) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const body = { model: cfg.model, messages, temperature: 0.2 }
  if (tools) { body.tools = tools; body.tool_choice = 'auto' }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error(`模型服务返回 ${res.status}${detail ? `：${detail}` : ''}`)
  }
  return res.json()
}
