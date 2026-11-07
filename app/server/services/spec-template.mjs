import crypto from 'node:crypto'

export const SPEC_PLACEHOLDERS = ['docTitle', 'docSubtitle', 'toc', 'content', 'footer']
export const REQUIRED_PLACEHOLDERS = ['content']
export const MAX_SPEC_HTML_BYTES = 10 * 1024 * 1024

export const DEFAULT_SPEC_TEMPLATE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{docTitle}}</title>
<style>
:root{--ink:#1c2126;--muted:#6d7783;--line:#e2e6ea;--accent:#2f5cf6;--bg:#fff;--soft:#f6f7f9}
*{box-sizing:border-box}body{margin:0;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:var(--ink);background:#eef0f3;font-size:14px;line-height:1.75}
.wrap{display:flex;max-width:1320px;margin:0 auto;background:var(--bg);min-height:100vh;box-shadow:0 0 30px rgba(0,0,0,.06)}
.toc{width:260px;flex:none;border-right:1px solid var(--line);padding:28px 18px;position:sticky;top:0;height:100vh;overflow:auto;background:#fbfbfc}
.toc .doc{font-size:15px;font-weight:600;margin-bottom:4px}.toc .sub{color:var(--muted);font-size:12px;margin-bottom:20px}
.toc a{display:block;color:#4a5560;text-decoration:none;font-size:13px;padding:6px 8px;border-radius:5px}.toc a:hover{background:var(--soft);color:var(--accent)}
.content{flex:1;min-width:0;padding:36px 48px 80px}
.title{border-bottom:2px solid var(--ink);padding-bottom:18px;margin-bottom:20px}
.title h1{font-size:26px;margin:0 0 8px}.title .doc-meta{color:var(--muted);font-size:12px}
.chapter-head{margin-top:36px;padding-top:8px;border-top:1px solid var(--line)}
.chapter-head h2{margin-top:12px}
h2{font-size:19px;margin:36px 0 12px;padding-left:10px;border-left:3px solid var(--accent)}
h3{font-size:15px;margin:22px 0 8px}h4{margin:0 0 8px;font-size:13px}
table.grid{width:100%;border-collapse:collapse;margin:10px 0 18px;font-size:12.5px}
table.grid th{background:var(--soft);text-align:left;font-weight:600;padding:8px 10px;border:1px solid var(--line)}
table.grid td{padding:8px 10px;border:1px solid var(--line);vertical-align:top}
.meta-table th{width:110px}
.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.meta-grid>div{background:var(--soft);border-radius:8px;padding:12px 14px}
.meta-grid span{color:var(--muted);font-size:11px}.meta-grid p{margin:4px 0 0}
.notice{background:#fff7e8;border:1px solid #f0d6a8;border-radius:8px;padding:10px 14px;margin:12px 0;font-size:12.5px}
.notice ul{margin:6px 0 0;padding-left:18px}
.warn{color:#b25b00}.ok-note{color:#1f7a4d}
.page-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.page-card{border:1px solid var(--line);border-radius:10px;padding:12px}
.page-meta{display:flex;gap:8px;color:var(--muted);font-size:11px;margin-top:8px;flex-wrap:wrap}
.proto-link{display:none}
.wf{display:flex;gap:6px;height:120px;background:#f7f8fa;border-radius:6px;padding:6px;margin-top:6px}
.wf-side{width:36px;background:#e7ebf0;border-radius:4px;padding:6px;display:flex;flex-direction:column;gap:5px}.wf-side i{display:block;height:6px;background:#cfd6de;border-radius:2px}
.wf-main{flex:1;display:flex;flex-direction:column;gap:5px}.wf-top{height:10px;background:#e2e7ed;border-radius:3px}
.wf-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}.wf-card{background:#fff;border:1px solid #e4e8ec;border-radius:3px;padding:4px;font-size:8px;color:#7b8590;display:flex;flex-direction:column;gap:2px}
.wf-card b{font-size:11px;color:#2f5cf6}.wf-rows{display:flex;flex-direction:column;gap:4px;flex:1}.wf-rows span{display:block;flex:1;background:#eceff2;border-radius:2px}
.doc-foot{margin-top:40px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}
@media print{.toc{display:none}.wrap{box-shadow:none;max-width:none}.content{padding:0}body{background:#fff}h2{break-after:avoid}.page-card{break-inside:avoid}.req-chapter{break-before:page}}
@media(max-width:900px){.toc{display:none}.content{padding:20px}.meta-grid,.page-grid{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<nav class="toc"><div class="doc">迭代需求分析说明书</div><div class="sub">{{docSubtitle}}</div>{{toc}}</nav>
<main class="content"><div class="title"><h1>{{docTitle}}</h1>
<div class="doc-meta">{{docSubtitle}}</div></div>
{{content}}
<div class="doc-foot">{{footer}}</div>
</main></div></body></html>`

function templateError(message, code = 'SPEC_TEMPLATE_INVALID') {
  const e = new Error(message)
  e.statusCode = 400
  e.code = code
  return e
}

export function templateHash(template) {
  return crypto.createHash('sha256').update(String(template || ''), 'utf8').digest('hex')
}

export function renderSpecTemplate(template, parts) {
  const source = String(template || '')
  if (!source.trim()) throw templateError('说明书模板为空')
  const names = new Set()
  for (const match of source.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) names.add(match[1])
  const unknown = [...names].filter(name => !SPEC_PLACEHOLDERS.includes(name))
  if (unknown.length) throw templateError(`说明书模板包含未知占位符：${unknown.map(n => `{{${n}}}`).join('、')}`)
  const missing = REQUIRED_PLACEHOLDERS.filter(name => !names.has(name))
  if (missing.length) throw templateError(`说明书模板缺少必需占位符：${missing.map(n => `{{${n}}}`).join('、')}`)

  let html = source
  for (const name of SPEC_PLACEHOLDERS) {
    html = html.split(`{{${name}}}`).join(String(parts[name] ?? ''))
  }
  if (/\{\{/.test(html)) throw templateError('说明书模板存在未闭合的占位符')
  if (Buffer.byteLength(html, 'utf8') > MAX_SPEC_HTML_BYTES) {
    throw templateError(`说明书 HTML 超过上限 ${Math.round(MAX_SPEC_HTML_BYTES / 1024 / 1024)} MB`)
  }
  return html
}

const UNSAFE_PATTERNS = [
  [/<\s*(script|iframe|object|embed|base)\b/i, '脚本或可嵌入标签'],
  [/\son[a-z]+\s*=/i, '事件属性'],
  [/(?:href|src)\s*=\s*(["'])\s*javascript:/i, 'javascript 链接'],
  [/url\(\s*["']?\s*(?:https?:)?\/\//i, '外部样式资源'],
  [/(?:src|href)\s*=\s*(["'])\s*(?:https?:)?\/\//i, '外部资源引用']
]

export function assertSpecSafety(html) {
  for (const [re, label] of UNSAFE_PATTERNS) {
    if (re.test(html)) {
      throw templateError(`说明书模板包含不安全内容：${label}`, 'SPEC_TEMPLATE_UNSAFE')
    }
  }
}

export function assertSpecStructure(html, { requirementCount = 0 } = {}) {
  if (/<script/i.test(html)) throw templateError('说明书模板包含脚本', 'SPEC_TEMPLATE_UNSAFE')
  const chapters = (html.match(/class="req-chapter"/g) || []).length
  const anchors = (html.match(/data-req-id="/g) || []).length
  const ids = (html.match(/id="req-[^"]+"/g) || []).length
  if (chapters !== requirementCount || anchors !== requirementCount || ids !== requirementCount) {
    const e = new Error(`说明书渲染不一致：需求 ${requirementCount} 条，章节 ${chapters}，锚点 ${anchors}`)
    e.statusCode = 500
    e.code = 'SPEC_RENDER_INCONSISTENT'
    e.details = { requirementCount, chapters, anchors, ids }
    throw e
  }
  if (!/id="overview"/.test(html)) throw templateError('说明书缺少迭代总览章节')
  if (!/id="appendix-a"/.test(html)) throw templateError('说明书缺少附录章节')
}
