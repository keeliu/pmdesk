import { run, uid, now } from '../db.mjs'
import { modelConfig, callModel } from './model.mjs'

const MAX_DOC_CHARS = 12000
const MAX_ITEMS = 20

const SYS = `你是需求管理助手，负责从会议纪要、需求文档中提炼真实业务需求。规则：
1. 只提炼需要建设或改造系统能力的诉求：功能新增、功能优化、流程改造、数据诉求、集成诉求，以及会议明确的系统建设类待办。
2. 不输出会议元信息（时间、地点、主持、参会人、议程本身）与纯汇报性、通报性内容。
3. 一个诉求一条记录，同一诉求合并；标题不超过 30 字；描述包含背景、诉求与期望结果，不超过 200 字。
4. 文档写明提出方时给出 requester（enterprise/department/name），未写明则留空，禁止编造。
5. 文档点名或明显对应某系统时写入 apps 数组，否则留空数组，禁止编造。
6. 没有符合条件的诉求时返回 {"requirements":[]}。
7. 只输出 JSON，不要输出任何其他文字。格式：
{"requirements":[{"title":"...","description":"...","requester":{"enterprise":"","department":"","name":""},"apps":[]}]}`

function extractJson(content) {
  const text = String(content || '').trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(candidate.slice(start, end + 1)) } catch { return null }
}

export async function distillRequirements({ text, project, fileName = '' }) {
  const cfg = modelConfig(project.id)
  if (!cfg) return { ok: false, reason: '未配置模型网关' }
  const doc = String(text || '').trim()
  if (doc.length < 40) return { ok: false, reason: '文档内容过短，直接拆分' }
  const truncated = doc.length > MAX_DOC_CHARS
  const user = `请从以下文档中提炼需求并输出 JSON。文档《${fileName || '未命名'}》内容：\n${doc.slice(0, MAX_DOC_CHARS)}${truncated ? '\n（文档后续内容已截断，请基于已有内容提炼）' : ''}`
  try {
    const resp = await callModel(cfg, [{ role: 'system', content: SYS }, { role: 'user', content: user }])
    const usage = resp.usage || {}
    const parsed = extractJson(resp.choices?.[0]?.message?.content)
    const list = Array.isArray(parsed?.requirements) ? parsed.requirements : null
    if (!list) {
      run('INSERT INTO llm_calls (id, project_id, requirement_id, skill_slug, provider, model, prompt_tokens, completion_tokens, cost, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        uid('LLM-'), project.id, '', 'intake-distill', cfg.baseUrl, cfg.model, usage.prompt_tokens || 0, usage.completion_tokens || 0, 0, 'error', now())
      return { ok: false, reason: '模型未返回有效 JSON' }
    }
    const seen = new Set()
    const items = []
    for (const raw of list) {
      const title = String(raw?.title || '').trim()
      const description = String(raw?.description || '').trim()
      if (title.length < 4 || seen.has(title)) continue
      seen.add(title)
      const requester = raw?.requester && typeof raw.requester === 'object'
        ? ['enterprise', 'department', 'name'].filter(k => String(raw.requester[k] || '').trim())
            .reduce((o, k) => ({ ...o, [k]: String(raw.requester[k]).trim() }), {})
        : {}
      const apps = Array.isArray(raw?.apps) ? raw.apps.map(a => String(a).trim()).filter(Boolean) : []
      items.push({ title, description, requester, apps })
      if (items.length >= MAX_ITEMS) break
    }
    run('INSERT INTO llm_calls (id, project_id, requirement_id, skill_slug, provider, model, prompt_tokens, completion_tokens, cost, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      uid('LLM-'), project.id, '', 'intake-distill', cfg.baseUrl, cfg.model, usage.prompt_tokens || 0, usage.completion_tokens || 0,
      ((usage.prompt_tokens || 0) * 0.0000015 + (usage.completion_tokens || 0) * 0.000002), 'success', now())
    return { ok: true, items, truncated }
  } catch (e) {
    run('INSERT INTO llm_calls (id, project_id, requirement_id, skill_slug, provider, model, prompt_tokens, completion_tokens, cost, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      uid('LLM-'), project.id, '', 'intake-distill', cfg.baseUrl, cfg.model, 0, 0, 0, 'error', now())
    return { ok: false, reason: `提炼失败：${e.message}` }
  }
}

export function distillNote(result) {
  if (result.ok) return `大模型提炼 ${result.items.length} 条需求`
  return `大模型提炼未启用（${result.reason}），已按段落拆分`
}
