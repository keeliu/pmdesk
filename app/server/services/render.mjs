const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function projectSystemScope(project) {
  if (project.systemScope) return project.systemScope
  if (typeof project.system_scope_json === 'string') return parseJson(project.system_scope_json, {})
  return project.system_scope_json || {}
}

export function emptyAnalysis() {
  return {
    description: { background: '', goal: '', roles: [], value: '' },
    process: { summary: '', steps: [] },
    functions: { architecture: [], list: [], flow: [], support: [] },
    integration: { apps: [], points: [] },
    acceptance: { steps: [], overall: '', metrics: [] },
    meta: { requiresSupport: false, revisionNotes: [] }
  }
}

const text = v => v && typeof v === 'object' ? String(v.value ?? v.label ?? '') : String(v ?? '')
const textList = list => (Array.isArray(list) ? list : []).map(text)

export function normalizeAnalysis(input) {
  const base = emptyAnalysis()
  const a = input || {}
  const d = a.description || {}
  const p = a.process || {}
  const f = a.functions || {}
  const ac = a.acceptance || {}
  return {
    description: {
      background: text(d.background), goal: text(d.goal),
      roles: textList(d.roles), value: text(d.value)
    },
    process: {
      summary: text(p.summary),
      exceptionNote: text(p.exceptionNote),
      steps: (p.steps || []).map(s => ({
        node: text(s.node), role: text(s.role), action: text(s.action),
        branch: text(s.branch), result: text(s.result), next: text(s.next)
      }))
    },
    functions: {
      architecture: (f.architecture || []).map(n => ({
        ...n, name: text(n.name), description: text(n.description), parent: text(n.parent), priority: text(n.priority)
      })),
      list: (f.list || []).map(x => ({
        ...x, name: text(x.name), description: text(x.description), trigger: text(x.trigger),
        rules: text(x.rules), result: text(x.result), acceptance: text(x.acceptance), group: text(x.group)
      })),
      flow: f.flow || [],
      support: (f.support || []).map(x => ({ ...x, name: text(x.name), description: text(x.description) }))
    },
    integration: { apps: a.integration?.apps || [], points: a.integration?.points || [] },
    acceptance: { steps: textList(ac.steps), overall: text(ac.overall), metrics: ac.metrics || [] },
    meta: { ...base.meta, ...(a.meta || {}) }
  }
}

const PLACEHOLDER = /处理相关业务|详见后续|待补充|待定|TBD|TODO|待完善/i
const ACTION_VERB = /^(配置|登记|录入|查询|检索|审批|审核|分配|计算|处理|发送|导出|同步|维护|办理|归档|发布|校验|生成|管理|编辑|创建|提交|关闭|统计|对账|结算|核销|推送|接收|上传|下载|启用|停用|解除|绑定|关联|调整|撤销|回滚|导入|更新|查看|发起|确认|退回|通知|合并|查重|拆分|筛选|排序|修改)/
const OBSERVABLE = /可|能|显示|生成|提示|校验|记录|查询|达到|下降|提升|低于|高于|≤|≥|%|条|人日|分钟|小时|秒/

function isPlaceholderOnly(text) {
  const value = String(text || '')
  if (!PLACEHOLDER.test(value)) return false
  return value.replace(PLACEHOLDER, '').replace(/[\s。；，,.\-—]/g, '').length < 6
}

export function checkAnalysis(analysis, req, project) {
  const issues = []
  const a = normalizeAnalysis(analysis)
  const scope = projectSystemScope(project)
  const scopeAll = [...(scope.platforms || []), ...(scope.applications || []), ...(scope.modules || [])]
  const err = (field, message) => issues.push({ level: 'error', field, message })
  const warn = (field, message) => issues.push({ level: 'warn', field, message })

  if (!a.description.goal) err('description.goal', '缺少目标与价值')
  if (!a.description.background) warn('description.background', '缺少现状与背景')
  if (!a.description.roles?.length) warn('description.roles', '未列出使用角色')

  if ((a.process.steps || []).length < 3) err('process.steps', '业务流程至少需要 3 个步骤')
  for (const s of a.process.steps || []) {
    if (!s.node || !s.role || !s.action) err('process.steps', `流程步骤「${s.node || '未命名'}」需包含节点、角色与动作`)
  }
  const hasBranch = (a.process.steps || []).some(s => s.branch && !['—', '无', '-'].includes(String(s.branch).trim()))
  if (!hasBranch && !a.process.exceptionNote) err('process.steps', '业务流程需包含异常分支，或填写单步流程说明')

  const functions = a.functions.list || []
  if (functions.length < 2) err('functions.list', '功能说明至少需要 2 个功能')
  const titleKey = String(req?.title || '').replace(/\s/g, '')
  for (const f of functions) {
    const name = String(f.name || '')
    if (!name) { err('functions.list', '功能名不能为空'); continue }
    if (!ACTION_VERB.test(name)) err('functions.list', `功能「${name}」需为动宾结构，以动作开头`)
    if (titleKey && (name === titleKey || name.includes(titleKey))) {
      err('functions.list', `功能「${name}」不得复用需求标题，需描述具体动作与对象`)
    }
    if (!f.acceptance) err('functions.list', `功能「${name}」缺少验收要点`)
    else if (!OBSERVABLE.test(f.acceptance)) err('functions.list', `功能「${name}」的验收要点缺少可观察结果`)
    if (!f.trigger || !f.rules || !f.result) warn('functions.list', `功能「${name}」建议补充触发场景、处理规则与结果`)
    if (isPlaceholderOnly(f.description) || isPlaceholderOnly(f.acceptance)) {
      err('functions.list', `功能「${name}」不能只写占位表述`)
    }
  }

  const arch = a.functions.architecture || []
  const modules = arch.filter(n => !n.parent)
  if (!modules.length) err('functions.architecture', '功能架构至少需要 1 个模块')
  const names = new Set(arch.map(n => n.name))
  for (const f of functions) {
    if (!names.has(f.name)) err('functions.architecture', `功能架构未包含「${f.name}」`)
  }

  if (!(a.integration.apps || []).length) err('integration.apps', '未登记涉及应用')
  const appNames = (a.integration.apps || []).map(x => x.name)
  for (const app of a.integration.apps || []) {
    if (app.kind !== 'external' && !scopeAll.includes(app.name)) {
      err('integration.apps', `应用「${app.name}」超出项目系统范围，请更新范围或标记为外部依赖`)
    }
  }
  for (const p of a.integration.points || []) {
    if (!p.app || !p.direction || !p.object || !p.trigger) {
      err('integration.points', `集成点「${p.app || '未指定'}」需包含应用、方向、数据对象与触发时机`)
    }
    if (p.app && !appNames.includes(p.app)) err('integration.points', `集成点应用「${p.app}」未在涉及应用中登记`)
  }

  if (!a.acceptance.overall) err('acceptance.overall', '缺少整体完成标准')
  if (!(a.acceptance.steps || []).length) warn('acceptance.steps', '建议补充逐步完成标准')

  const allText = [
    a.description.background, a.description.goal, a.description.value,
    ...(a.process.steps || []).map(s => [s.node, s.action, s.branch, s.result].join(' ')),
    ...functions.map(f => [f.name, f.description, f.trigger, f.rules, f.result, f.acceptance].join(' ')),
    ...(a.functions.support || []).map(s => [s.name, s.description].join(' ')),
    ...(a.acceptance.steps || []), a.acceptance.overall
  ].join('\n')
  const supportNeeded = /通知|消息|提醒|权限|角色|审批|配置|参数|日志|审计|导入|导出/.test(allText)
  if (supportNeeded && !(a.functions.support || []).length) {
    err('functions.support', '功能涉及通知、权限、配置或日志依赖，但未登记辅助支撑功能')
  }
  return { ok: !issues.some(i => i.level === 'error'), issues }
}

function layoutOf(name = '') {
  if (/详情|查看|明细/.test(name)) return 'detail'
  if (/配置|新增|编辑|申请|录入|提交/.test(name)) return 'form'
  if (/看板|统计|报表|概览|仪表/.test(name)) return 'dashboard'
  return 'list'
}

export function buildPrototypePages(analysis, req) {
  const a = normalizeAnalysis(analysis)
  const list = a.functions.list || []
  const groups = []
  const seen = new Set()
  for (const f of list) {
    const key = f.group || '业务功能'
    if (!seen.has(key)) { seen.add(key); groups.push({ name: key, items: [] }) }
    groups.find(g => g.name === key).items.push(f)
  }
  const pages = []
  const overviewItems = list.slice(0, 6)
  pages.push({
    id: 'p-overview', name: '需求概览', layout: 'dashboard', subtitle: `${req.code || '需求'} · ${req.title}`,
    functions: overviewItems.map(f => f.name), kind: 'overview'
  })
  for (const f of list) {
    pages.push({
      id: 'p-' + (f.id || f.name).toString().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').slice(0, 24),
      name: f.name, layout: layoutOf(f.name), subtitle: f.description?.slice(0, 60) || '功能页面',
      functions: [f.name], acceptance: f.acceptance, kind: 'function'
    })
  }
  if (groups.length > 1) {
    pages.push({
      id: 'p-groups', name: '功能分组', layout: 'list', subtitle: '按业务分组查看全部功能',
      functions: groups.map(g => g.name), kind: 'group'
    })
  }
  return pages.map(p => ({ ...p, states: ['default', 'empty', 'loading', 'error', 'forbidden'] }))
}

function stateBlock(page) {
  const rows = (page.functions.length ? page.functions : ['业务记录'])
  const rowHtml = rows.map((f, i) => `
      <tr><td><span class="dot ${i % 3 === 0 ? 'ok' : i % 3 === 1 ? 'warn' : ''}"></span>${esc(f)}</td>
      <td>${esc(['待处理', '处理中', '已完成'][i % 3])}</td><td>${esc(['运营组', '业务组', '管理员'][i % 3])}</td>
      <td>${esc('2026-11-0' + ((i % 8) + 1))}</td><td><button class="link">查看</button></td></tr>`).join('')
  const cards = rows.map((f, i) => `
      <div class="kpi"><span class="kpi-label">${esc(f)}</span><strong>${18 + i * 7}</strong><span class="trend">↑ ${3 + i}%</span></div>`).join('')
  const form = `
      <div class="form-grid">
        <label>名称<input value="${esc(page.functions[0] || '新建记录')}" readonly></label>
        <label>所属分类<select><option>${esc(page.functions[0] || '默认分类')}</option></select></label>
        <label>负责人<input value="产品运营" readonly></label>
        <label>生效时间<input value="2026-11-10" readonly></label>
        <label class="wide">说明<textarea readonly>${esc(page.subtitle || '')}</textarea></label>
      </div>
      <div class="actions"><button class="primary">提交</button><button>取消</button></div>`
  const detail = `
      <div class="detail-head"><h3>${esc(page.functions[0] || page.name)}</h3><span class="tag">进行中</span></div>
      <dl class="detail-grid">
        <div><dt>业务编号</dt><dd>${esc(reqCodeHint(page))}</dd></div>
        <div><dt>负责人</dt><dd>产品运营</dd></div>
        <div><dt>更新时间</dt><dd>2026-11-04 10:20</dd></div>
        <div><dt>状态</dt><dd>处理中</dd></div>
      </dl>
      <table class="table"><thead><tr><th>环节</th><th>处理人</th><th>时间</th><th>结果</th></tr></thead>
      <tbody><tr><td>提交</td><td>业务用户</td><td>11-01</td><td>成功</td></tr>
      <tr><td>审核</td><td>运营管理员</td><td>11-02</td><td>通过</td></tr></tbody></table>`
  return `
  <div class="state" data-state="default">
    ${page.layout === 'dashboard' ? `<div class="kpis">${cards}</div>` : ''}
    ${page.layout === 'form' ? form : page.layout === 'detail' ? detail : `
      <div class="toolbar"><input placeholder="搜索关键字" readonly><button class="primary">新增</button><button>导出</button></div>
      <table class="table"><thead><tr><th>功能/记录</th><th>状态</th><th>负责人</th><th>更新时间</th><th>操作</th></tr></thead>
      <tbody>${rowHtml}</tbody></table>`}
  </div>
  <div class="state" data-state="empty"><div class="empty"><div class="empty-icon">◇</div><h3>暂无数据</h3><p>当前筛选条件下没有记录，可调整条件或新增。</p><button class="primary">新增记录</button></div></div>
  <div class="state" data-state="loading"><div class="skeleton"></div><div class="skeleton w70"></div><div class="skeleton w40"></div></div>
  <div class="state" data-state="error"><div class="empty"><div class="empty-icon err">!</div><h3>加载失败</h3><p>服务暂时不可用，请稍后重试。</p><button class="primary">重新加载</button></div></div>
  <div class="state" data-state="forbidden"><div class="empty"><div class="empty-icon">⚿</div><h3>无访问权限</h3><p>当前账号未获得该功能的查看权限，请联系管理员。</p></div></div>`
}

function reqCodeHint(page) {
  return page.id === 'p-overview' ? 'DEMO-0001' : 'DEMO-' + page.id.replace(/\D/g, '').padStart(4, '0')
}

export function prototypePageHtml(page, ctx = {}) {
  const projectName = ctx.projectName || '需求管理工作台'
  const reqTitle = ctx.reqTitle || ''
  const pages = ctx.pages || [page]
  const nav = pages.map(p => `<a href="#" data-nav="${esc(p.id)}" class="${p.id === page.id ? 'active' : ''}">${esc(p.name)}</a>`).join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.name)} · ${esc(projectName)}</title>
<style>
:root{--bg:#f5f6f8;--surface:#fff;--ink:#1c2126;--muted:#7a828c;--line:#e4e7eb;--accent:#2f5cf6;--accent-weak:#eaefff;--ok:#12855a;--warn:#b26a00;--danger:#c0392b}
*{box-sizing:border-box}body{margin:0;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;background:var(--bg);color:var(--ink);font-size:13px}
.shell{display:flex;min-height:100vh}.side{width:196px;background:#151a21;color:#c9d0d8;padding:16px 12px;flex:none}
.brand{font-weight:600;color:#fff;font-size:14px;margin:4px 8px 18px}.brand small{display:block;color:#7e8894;font-weight:400;font-size:11px;margin-top:4px}
.side a{display:block;color:#aab3bd;text-decoration:none;padding:8px 10px;border-radius:6px;margin-bottom:2px}
.side a.active{background:#243041;color:#fff}.main{flex:1;min-width:0}
.top{height:52px;background:var(--surface);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 20px}
.top h1{font-size:14px;margin:0}.top .crumb{color:var(--muted);font-size:12px;margin-left:10px}
.states-witch{display:flex;gap:6px}.states-witch button{border:1px solid var(--line);background:#fff;padding:5px 9px;border-radius:5px;cursor:pointer;color:var(--muted);font-size:12px}
.states-witch button.on{border-color:var(--accent);color:var(--accent);background:var(--accent-weak)}
.body{padding:20px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px}
.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
.panel-head h2{margin:0;font-size:16px}.panel-head p{margin:4px 0 0;color:var(--muted);font-size:12px}
.tag{display:inline-block;background:var(--accent-weak);color:var(--accent);padding:2px 8px;border-radius:10px;font-size:11px}
.toolbar{display:flex;gap:8px;margin-bottom:12px}.toolbar input{flex:1;border:1px solid var(--line);border-radius:6px;padding:7px 10px;background:#fafbfc}
button{font-family:inherit;font-size:12px;border:1px solid var(--line);background:#fff;border-radius:6px;padding:7px 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.table{width:100%;border-collapse:collapse}.table th{text-align:left;color:var(--muted);font-weight:500;font-size:12px;padding:9px 8px;border-bottom:1px solid var(--line)}
.table td{padding:11px 8px;border-bottom:1px solid #f0f2f4}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-right:7px}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}
.link{border:0;background:none;color:var(--accent);padding:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:#fafbfc;border:1px solid var(--line);border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:5px}
.kpi-label{color:var(--muted);font-size:12px}.kpi strong{font-size:24px;font-weight:600}.trend{color:var(--ok);font-size:11px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.form-grid label{display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:12px}
.form-grid input,.form-grid select,.form-grid textarea{border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-family:inherit;font-size:13px;color:var(--ink);background:#fafbfc}
.form-grid .wide{grid-column:1/-1}.form-grid textarea{min-height:74px}.actions{display:flex;gap:8px;margin-top:16px}
.detail-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}.detail-head h3{margin:0;font-size:15px}
.detail-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 16px;padding:12px;background:#fafbfc;border-radius:8px}
.detail-grid dt{color:var(--muted);font-size:11px;margin-bottom:4px}.detail-grid dd{margin:0;font-size:13px}
.state{display:none}.state.on{display:block}.empty{text-align:center;padding:48px 16px;color:var(--muted)}
.empty h3{color:var(--ink);margin:8px 0 6px}.empty-icon{width:44px;height:44px;line-height:42px;border-radius:50%;background:var(--accent-weak);color:var(--accent);font-size:20px;margin:0 auto}
.empty-icon.err{background:#fdecea;color:var(--danger)}.empty button{margin-top:12px}
.skeleton{height:38px;border-radius:6px;background:linear-gradient(90deg,#eef1f4 25%,#f7f9fa 37%,#eef1f4 63%);background-size:400% 100%;animation:sk 1.2s infinite;margin-bottom:10px}
.w70{width:70%}.w40{width:40%}@keyframes sk{0%{background-position:100% 50%}100%{background-position:0 50%}}
.footer{color:var(--muted);font-size:11px;margin-top:14px;text-align:right}
@media(max-width:760px){.side{display:none}.form-grid{grid-template-columns:1fr}.detail-grid{grid-template-columns:1fr 1fr}}
</style></head>
<body><div class="shell">
<aside class="side"><div class="brand">${esc(projectName)}<small>${esc(reqTitle)}</small></div>${nav}</aside>
<div class="main"><div class="top"><div><strong>${esc(page.name)}</strong><span class="crumb">${esc(page.subtitle || '')}</span></div>
<div class="states-witch"><button data-s="default" class="on">默认</button><button data-s="empty">空</button><button data-s="loading">加载</button><button data-s="error">错误</button><button data-s="forbidden">无权限</button></div></div>
<div class="body"><div class="panel"><div class="panel-head"><div><h2>${esc(page.name)}</h2><p>${esc(page.subtitle || '')}</p></div><span class="tag">${esc(page.layout)}</span></div>
${stateBlock(page)}<div class="footer">原型仅用于需求评审，数据为示意内容</div></div></div></div></div>
<script>
const states=[...document.querySelectorAll('.state')],btns=[...document.querySelectorAll('.states-witch button')];
function show(s){states.forEach(e=>e.classList.toggle('on',e.dataset.state===s));btns.forEach(b=>b.classList.toggle('on',b.dataset.s===s))}
btns.forEach(b=>b.onclick=()=>show(b.dataset.s));show('default');
document.querySelectorAll('[data-nav]').forEach(a=>a.onclick=e=>{e.preventDefault();const id=a.dataset.nav;if(window.parent!==window){parent.postMessage({type:'proto-nav',id},'*')}});
</script></body></html>`
}

export function specMarkdown({ req, project, analysis, pages, version, reviews, changes }) {
  const a = normalizeAnalysis(analysis)
  const lines = []
  lines.push(`# ${req.title} 需求分析说明书`)
  lines.push('')
  lines.push(`| 项目 | 内容 |`)
  lines.push(`| --- | --- |`)
  lines.push(`| 需求编号 | ${req.code || '未编号'} |`)
  lines.push(`| 所属项目 | ${project.name}（${project.code}） |`)
  lines.push(`| 说明书版本 | V${version} |`)
  lines.push(`| 需求状态 | ${req.status} |`)
  lines.push(`| 生成时间 | ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} |`)
  lines.push('')
  lines.push('## 1 需求概述')
  lines.push('')
  lines.push(`**背景**：${a.description.background || '—'}`)
  lines.push('')
  lines.push(`**目标**：${a.description.goal || '—'}`)
  lines.push('')
  lines.push(`**价值**：${a.description.value || '—'}`)
  lines.push('')
  lines.push(`**角色**：${(a.description.roles || []).join('、') || '—'}`)
  lines.push('')
  lines.push('## 2 澄清结论')
  lines.push('')
  lines.push('| 维度 | 结论 |')
  lines.push('| --- | --- |')
  const clar = parseClar(req.clarification_json)
  for (const [k, label] of [['roles', '角色与岗位'], ['goal', '目标与价值'], ['scope', '范围'], ['boundary', '边界'], ['acceptance', '验收口径']]) {
    lines.push(`| ${label} | ${(clar.answers?.[k]?.value || '—').toString().replace(/\n/g, ' ')} |`)
  }
  lines.push(`| 涉及应用 | ${(a.integration.apps || []).map(x => x.name + (x.kind === 'external' ? '（外部依赖）' : '')).join('、') || '—'} |`)
  lines.push('')
  lines.push('## 3 业务流程说明')
  lines.push('')
  lines.push(a.process.summary || '')
  lines.push('')
  lines.push('| 节点 | 角色/岗位 | 动作 | 分支条件 | 分支结果 | 下一节点 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const s of a.process.steps || []) {
    lines.push(`| ${s.node || ''} | ${s.role || ''} | ${s.action || ''} | ${s.branch || '—'} | ${s.result || '—'} | ${s.next || '—'} |`)
  }
  lines.push('')
  lines.push('## 4 功能设计')
  lines.push('')
  lines.push('### 4.1 功能架构')
  lines.push('')
  lines.push('| 层级 | 功能 | 说明 | 优先级 |')
  lines.push('| --- | --- | --- | --- |')
  for (const n of a.functions.architecture || []) {
    lines.push(`| ${n.parent || '一级'} | ${n.name} | ${n.description || ''} | ${n.priority || 'P1'} |`)
  }
  lines.push('')
  lines.push('### 4.2 功能说明')
  lines.push('')
  lines.push('| 功能 | 说明 | 优先级 | 验收要点 |')
  lines.push('| --- | --- | --- | --- |')
  for (const f of a.functions.list || []) {
    lines.push(`| ${f.name} | ${(f.description || '').replace(/\n/g, ' ')} | ${f.priority || 'P1'} | ${(f.acceptance || '').replace(/\n/g, ' ')} |`)
  }
  lines.push('')
  lines.push('### 4.3 功能流程')
  lines.push('')
  lines.push('| 起点 | 动作 | 条件 | 终点 |')
  lines.push('| --- | --- | --- | --- |')
  for (const f of a.functions.flow || []) {
    lines.push(`| ${f.from || ''} | ${f.action || ''} | ${f.condition || '—'} | ${f.to || ''} |`)
  }
  lines.push('')
  lines.push('### 4.4 辅助支撑功能')
  lines.push('')
  if ((a.functions.support || []).length) {
    lines.push('| 功能 | 说明 |')
    lines.push('| --- | --- |')
    for (const s of a.functions.support) lines.push(`| ${s.name} | ${s.description || ''} |`)
  } else lines.push('本期无需额外辅助支撑功能。')
  lines.push('')
  lines.push('## 5 集成说明')
  lines.push('')
  lines.push('### 5.1 涉及应用')
  lines.push('')
  lines.push('| 应用 | 类型 | 说明 |')
  lines.push('| --- | --- | --- |')
  for (const app of a.integration.apps || []) {
    lines.push(`| ${app.name} | ${app.kind === 'external' ? '外部依赖' : '内部应用'} | ${app.note || ''} |`)
  }
  lines.push('')
  lines.push('### 5.2 集成点')
  lines.push('')
  lines.push('| 应用 | 方向 | 数据对象 | 触发时机 | 说明 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const p of a.integration.points || []) {
    lines.push(`| ${p.app || ''} | ${p.direction || ''} | ${p.object || ''} | ${p.trigger || ''} | ${p.note || ''} |`)
  }
  lines.push('')
  lines.push('## 6 界面原型')
  lines.push('')
  lines.push(`原型版本 V${version}，共 ${pages.length} 个页面。`)
  lines.push('')
  lines.push('| 页面 | 布局 | 覆盖功能 | 状态 |')
  lines.push('| --- | --- | --- | --- |')
  for (const p of pages) {
    lines.push(`| ${p.name} | ${p.layout} | ${(p.functions || []).join('、')} | 默认 / 空 / 加载 / 错误 / 无权限 |`)
  }
  lines.push('')
  lines.push('## 7 验收口径')
  lines.push('')
  lines.push('### 7.1 逐步完成标准')
  lines.push('')
  for (const s of a.acceptance.steps || []) lines.push(`- ${s}`)
  lines.push('')
  lines.push('### 7.2 整体完成标准')
  lines.push('')
  lines.push(a.acceptance.overall || '—')
  lines.push('')
  lines.push('### 7.3 价值验证')
  lines.push('')
  if ((a.acceptance.metrics || []).length) {
    lines.push('| 指标 | 目标值 | 观察周期 |')
    lines.push('| --- | --- | --- |')
    for (const m of a.acceptance.metrics) lines.push(`| ${m.name} | ${m.target} | ${m.period || '上线后一个月'} |`)
  } else lines.push('—')
  lines.push('')
  if (changes?.length) {
    lines.push('## 8 变更记录')
    lines.push('')
    lines.push('| 编号 | 分级 | 内容 | 处理方式 | 状态 | 时间 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const c of changes) lines.push(`| CHG-${String(c.seq).padStart(3, '0')} | ${c.grade} | ${(c.content || '').replace(/\n/g, ' ')} | ${c.handling || '—'} | ${c.status} | ${c.created_at.slice(0, 10)} |`)
    lines.push('')
  }
  if (reviews?.length) {
    lines.push('## 9 评审记录')
    lines.push('')
    lines.push('| 轮次 | 评审人 | 结论 | 时间 |')
    lines.push('| --- | --- | --- | --- |')
    for (const r of reviews) lines.push(`| 第 ${r.round} 轮 | ${parseJson(r.reviewers_json, []).join('、')} | ${r.conclusion || '进行中'} | ${(r.decided_at || r.created_at).slice(0, 10)} |`)
    lines.push('')
  }
  return lines.join('\n')
}

function parseClar(json) {
  try { return JSON.parse(json || '{}') } catch { return {} }
}
function parseJson(json, fb) {
  try { return JSON.parse(json || 'null') ?? fb } catch { return fb }
}

function wireframe(page) {
  const items = (page.functions || []).slice(0, 4)
  const cards = items.map((f, i) => `<div class="wf-card"><span>${esc(f)}</span><b>${12 + i * 4}</b></div>`).join('')
  return `<div class="wf"><div class="wf-side"><i></i><i></i><i></i></div><div class="wf-main"><div class="wf-top"></div>
    <div class="wf-cards">${cards}</div><div class="wf-rows"><span></span><span></span><span></span><span></span></div></div></div>`
}

export function specHtml({ req, project, analysis, pages, version, reviews, changes, protoId }) {
  const a = normalizeAnalysis(analysis)
  const md = specMarkdown({ req, project, analysis, pages, version, reviews, changes })
  const sections = []
  sections.push(`<section id="s1"><h2>1 需求概述</h2>
    <div class="meta-grid">
      <div><span>背景</span><p>${esc(a.description.background || '—')}</p></div>
      <div><span>目标</span><p>${esc(a.description.goal || '—')}</p></div>
      <div><span>价值</span><p>${esc(a.description.value || '—')}</p></div>
      <div><span>角色</span><p>${esc((a.description.roles || []).join('、') || '—')}</p></div>
    </div></section>`)
  const clar = parseClar(req.clarification_json)
  const clarRows = [['角色与岗位', 'roles'], ['目标与价值', 'goal'], ['范围', 'scope'], ['边界', 'boundary'], ['验收口径', 'acceptance']]
    .map(([label, k]) => `<tr><th>${label}</th><td>${esc(clar.answers?.[k]?.value || '—')}</td></tr>`).join('')
  sections.push(`<section id="s2"><h2>2 澄清结论</h2><table class="grid">${clarRows}
    <tr><th>涉及应用</th><td>${esc((a.integration.apps || []).map(x => x.name).join('、') || '—')}</td></tr></table></section>`)
  const steps = (a.process.steps || []).map(s => `<tr><td>${esc(s.node)}</td><td>${esc(s.role)}</td><td>${esc(s.action)}</td><td>${esc(s.branch || '—')}</td><td>${esc(s.result || '—')}</td><td>${esc(s.next || '—')}</td></tr>`).join('')
  sections.push(`<section id="s3"><h2>3 业务流程说明</h2><p>${esc(a.process.summary || '')}</p>
    <table class="grid"><thead><tr><th>节点</th><th>角色</th><th>动作</th><th>分支条件</th><th>分支结果</th><th>下一节点</th></tr></thead><tbody>${steps}</tbody></table></section>`)
  const arch = (a.functions.architecture || []).map(n => `<tr><td>${esc(n.parent || '一级')}</td><td>${esc(n.name)}</td><td>${esc(n.description || '')}</td><td>${esc(n.priority || 'P1')}</td></tr>`).join('')
  const fns = (a.functions.list || []).map(f => `<tr><td><b>${esc(f.name)}</b></td><td>${esc(f.description || '')}</td><td>${esc(f.priority || 'P1')}</td><td>${esc(f.acceptance || '')}</td></tr>`).join('')
  const flow = (a.functions.flow || []).map(f => `<tr><td>${esc(f.from || '')}</td><td>${esc(f.action || '')}</td><td>${esc(f.condition || '—')}</td><td>${esc(f.to || '')}</td></tr>`).join('')
  const support = (a.functions.support || []).map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.description || '')}</td></tr>`).join('')
  sections.push(`<section id="s4"><h2>4 功能设计</h2>
    <h3>4.1 功能架构</h3><table class="grid"><thead><tr><th>层级</th><th>功能</th><th>说明</th><th>优先级</th></tr></thead><tbody>${arch}</tbody></table>
    <h3>4.2 功能说明</h3><table class="grid"><thead><tr><th>功能</th><th>说明</th><th>优先级</th><th>验收要点</th></tr></thead><tbody>${fns}</tbody></table>
    <h3>4.3 功能流程</h3><table class="grid"><thead><tr><th>起点</th><th>动作</th><th>条件</th><th>终点</th></tr></thead><tbody>${flow}</tbody></table>
    <h3>4.4 辅助支撑功能</h3>${support ? `<table class="grid"><thead><tr><th>功能</th><th>说明</th></tr></thead><tbody>${support}</tbody></table>` : '<p>本期无需额外辅助支撑功能。</p>'}</section>`)
  const apps = (a.integration.apps || []).map(x => `<tr><td>${esc(x.name)}</td><td>${x.kind === 'external' ? '外部依赖' : '内部应用'}</td><td>${esc(x.note || '')}</td></tr>`).join('')
  const points = (a.integration.points || []).map(p => `<tr><td>${esc(p.app || '')}</td><td>${esc(p.direction || '')}</td><td>${esc(p.object || '')}</td><td>${esc(p.trigger || '')}</td><td>${esc(p.note || '')}</td></tr>`).join('')
  sections.push(`<section id="s5"><h2>5 集成说明</h2><h3>5.1 涉及应用</h3><table class="grid"><thead><tr><th>应用</th><th>类型</th><th>说明</th></tr></thead><tbody>${apps}</tbody></table>
    <h3>5.2 集成点</h3><table class="grid"><thead><tr><th>应用</th><th>方向</th><th>数据对象</th><th>触发时机</th><th>说明</th></tr></thead><tbody>${points}</tbody></table></section>`)
  const pageCards = pages.map(p => `<div class="page-card"><h4>${esc(p.name)}</h4>${wireframe(p)}
    <div class="page-meta"><span>${esc(p.layout)}</span><span>${esc((p.functions || []).join('、'))}</span></div>
    ${protoId ? `<a class="proto-link" target="_blank" href="/api/prototypes/${protoId}/page/${p.id}?embed=1">打开可交互原型</a>` : ''}</div>`).join('')
  sections.push(`<section id="s6"><h2>6 界面原型</h2><p>原型版本 V${version}，共 ${pages.length} 个页面，覆盖默认、空、加载、错误与无权限五种状态。</p><div class="page-grid">${pageCards}</div></section>`)
  const stepsAcc = (a.acceptance.steps || []).map(s => `<li>${esc(s)}</li>`).join('')
  const metrics = (a.acceptance.metrics || []).map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.target)}</td><td>${esc(m.period || '上线后一个月')}</td></tr>`).join('')
  sections.push(`<section id="s7"><h2>7 验收口径</h2><h3>7.1 逐步完成标准</h3><ul>${stepsAcc}</ul>
    <h3>7.2 整体完成标准</h3><p>${esc(a.acceptance.overall || '—')}</p>
    <h3>7.3 价值验证</h3>${metrics ? `<table class="grid"><thead><tr><th>指标</th><th>目标值</th><th>观察周期</th></tr></thead><tbody>${metrics}</tbody></table>` : '<p>—</p>'}</section>`)
  if (changes?.length) {
    sections.push(`<section id="s8"><h2>8 变更记录</h2><table class="grid"><thead><tr><th>编号</th><th>分级</th><th>内容</th><th>处理</th><th>状态</th></tr></thead><tbody>
      ${changes.map(c => `<tr><td>CHG-${String(c.seq).padStart(3, '0')}</td><td>${esc(c.grade)}</td><td>${esc(c.content)}</td><td>${esc(c.handling || '—')}</td><td>${esc(c.status)}</td></tr>`).join('')}</tbody></table></section>`)
  }
  if (reviews?.length) {
    sections.push(`<section id="s9"><h2>9 评审记录</h2><table class="grid"><thead><tr><th>轮次</th><th>评审人</th><th>结论</th><th>时间</th></tr></thead><tbody>
      ${reviews.map(r => `<tr><td>第 ${r.round} 轮</td><td>${esc(parseJson(r.reviewers_json, []).join('、'))}</td><td>${esc(r.conclusion || '进行中')}</td><td>${esc((r.decided_at || r.created_at).slice(0, 10))}</td></tr>`).join('')}</tbody></table></section>`)
  }
  const toc = [['s1', '1 需求概述'], ['s2', '2 澄清结论'], ['s3', '3 业务流程'], ['s4', '4 功能设计'], ['s5', '5 集成说明'], ['s6', '6 界面原型'], ['s7', '7 验收口径']]
    .concat(changes?.length ? [['s8', '8 变更记录']] : []).concat(reviews?.length ? [['s9', '9 评审记录']] : [])
    .map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(req.title)} · 需求分析说明书 V${version}</title>
<style>
:root{--ink:#1c2126;--muted:#6d7783;--line:#e2e6ea;--accent:#2f5cf6;--bg:#fff;--soft:#f6f7f9}
*{box-sizing:border-box}body{margin:0;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:var(--ink);background:#eef0f3;font-size:14px;line-height:1.75}
.wrap{display:flex;max-width:1280px;margin:0 auto;background:var(--bg);min-height:100vh;box-shadow:0 0 30px rgba(0,0,0,.06)}
.toc{width:230px;flex:none;border-right:1px solid var(--line);padding:28px 18px;position:sticky;top:0;height:100vh;background:#fbfbfc}
.toc .doc{font-size:15px;font-weight:600;margin-bottom:4px}.toc .sub{color:var(--muted);font-size:12px;margin-bottom:20px}
.toc a{display:block;color:#4a5560;text-decoration:none;font-size:13px;padding:6px 8px;border-radius:5px}.toc a:hover{background:var(--soft);color:var(--accent)}
.content{flex:1;min-width:0;padding:36px 48px 80px}
.title{border-bottom:2px solid var(--ink);padding-bottom:18px;margin-bottom:20px}
.title h1{font-size:26px;margin:0 0 8px}.title .doc-meta{color:var(--muted);font-size:12px}
h2{font-size:19px;margin:36px 0 12px;padding-left:10px;border-left:3px solid var(--accent)}
h3{font-size:15px;margin:22px 0 8px}h4{margin:0 0 8px;font-size:13px}
table.grid{width:100%;border-collapse:collapse;margin:10px 0 18px;font-size:12.5px}
table.grid th{background:var(--soft);text-align:left;font-weight:600;padding:8px 10px;border:1px solid var(--line)}
table.grid td{padding:8px 10px;border:1px solid var(--line);vertical-align:top}
.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.meta-grid>div{background:var(--soft);border-radius:8px;padding:12px 14px}
.meta-grid span{color:var(--muted);font-size:11px}.meta-grid p{margin:4px 0 0}
.page-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.page-card{border:1px solid var(--line);border-radius:10px;padding:12px}
.page-meta{display:flex;gap:8px;color:var(--muted);font-size:11px;margin-top:8px;flex-wrap:wrap}
.proto-link{display:inline-block;margin-top:6px;color:var(--accent);font-size:12px;text-decoration:none}
.wf{display:flex;gap:6px;height:120px;background:#f7f8fa;border-radius:6px;padding:6px;margin-top:6px}
.wf-side{width:36px;background:#e7ebf0;border-radius:4px;padding:6px;display:flex;flex-direction:column;gap:5px}.wf-side i{display:block;height:6px;background:#cfd6de;border-radius:2px}
.wf-main{flex:1;display:flex;flex-direction:column;gap:5px}.wf-top{height:10px;background:#e2e7ed;border-radius:3px}
.wf-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}.wf-card{background:#fff;border:1px solid #e4e8ec;border-radius:3px;padding:4px;font-size:8px;color:#7b8590;display:flex;flex-direction:column;gap:2px}
.wf-card b{font-size:11px;color:#2f5cf6}.wf-rows{display:flex;flex-direction:column;gap:4px;flex:1}.wf-rows span{display:block;flex:1;background:#eceff2;border-radius:2px}
.doc-foot{margin-top:40px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}
@media print{.toc{display:none}.wrap{box-shadow:none;max-width:none}.content{padding:0}body{background:#fff}h2{break-after:avoid}.page-card{break-inside:avoid}}
@media(max-width:900px){.toc{display:none}.content{padding:20px}.meta-grid,.page-grid{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<nav class="toc"><div class="doc">需求分析说明书</div><div class="sub">${esc(req.code || '未编号')} · V${version}</div>${toc}</nav>
<main class="content"><div class="title"><h1>${esc(req.title)}</h1>
<div class="doc-meta">${esc(project.name)}（${esc(project.code)}） · 需求编号 ${esc(req.code || '—')} · 版本 V${version} · ${new Date().toLocaleDateString('zh-CN')}</div></div>
${sections.join('\n')}
<div class="doc-foot">本文档由需求管理工作台生成，内容与需求分析版本 V${version} 对应。</div>
</main></div></body></html>`
}
