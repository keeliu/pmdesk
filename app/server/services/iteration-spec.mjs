import { all, get, run, uid, now, parseJson } from '../db.mjs'
import { normalizeAnalysis, checkAnalysis, specHtml, specMarkdown } from './render.mjs'
import { normalizeMilestones, milestoneView, MILESTONE_FIELDS } from './milestones.mjs'
import { DEFAULT_SPEC_TEMPLATE, renderSpecTemplate, templateHash } from './spec-template.mjs'
import { STATES, statusLabel } from '../core.mjs'

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const STATUS_ORDER = STATES.filter(s => s !== '已丢弃')
const PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3']

function latestAnalysisRow(requirementId) {
  return get('SELECT * FROM requirement_versions WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', requirementId)
}

export function collectIterationSources({ project, requirements }) {
  return requirements.map(req => {
    const analysisRow = latestAnalysisRow(req.id)
    const analysis = analysisRow ? parseJson(analysisRow.analysis_json, {}) : null
    const quality = analysisRow ? checkAnalysis(analysis, req, project) : { ok: false, issues: [{ level: 'error', field: 'meta', message: '缺少分析版本' }] }
    const proto = get('SELECT * FROM prototypes WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', req.id)
    const spec = get('SELECT * FROM specs WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', req.id)
    const pages = proto ? parseJson(proto.pages_json, []) : []
    const reviews = all('SELECT * FROM reviews WHERE requirement_id = ? ORDER BY round', req.id)
    const changes = all('SELECT * FROM changes WHERE requirement_id = ? ORDER BY seq', req.id)
    const missing = []
    if (!analysisRow) missing.push('缺少分析版本')
    else if (!quality.ok) missing.push(`分析未通过一致性核查（${quality.issues.filter(i => i.level === 'error').length} 项必须修复）`)
    if (!proto || proto.status !== 'confirmed') missing.push('原型未确认')
    if (!spec || spec.status !== 'published') missing.push('说明书未发布')
    return {
      req, analysisRow, analysis, quality, proto, spec, pages, reviews, changes, missing,
      milestones: milestoneView(req.milestones_json || {})
    }
  })
}

function requirementFragment({ item, project, idPrefix }) {
  const { req, analysis, pages, reviews, changes, proto } = item
  const html = specHtml({
    req, project, analysis, pages,
    version: item.analysisRow?.version || 0,
    reviews, changes, protoId: proto?.id || null
  })
  const start = html.indexOf('<main class="content">')
  const end = html.indexOf('<div class="doc-foot">')
  if (start < 0 || end < 0) return ''
  let body = html.slice(start + '<main class="content">'.length, end)
  body = body.replace(/<div class="title">[\s\S]*?<\/div><\/div>/, '')
  body = body.replace(/<a class="proto-link"[\s\S]*?<\/a>/g, '')
  body = body.replace(/id="s(\d+)"/g, `id="${idPrefix}s$1"`)
  body = body.replace(/href="#s(\d+)"/g, `href="#${idPrefix}s$1"`)
  return body
}

function statusCounts(items) {
  return STATUS_ORDER.map(status => ({ status, count: items.filter(x => x.req.status === status).length })).filter(x => x.count > 0)
}

function priorityCounts(items) {
  return PRIORITY_ORDER.map(grade => ({
    grade,
    label: grade === 'P0' ? 'P0-极高' : grade === 'P1' ? 'P1-高' : grade === 'P2' ? 'P2-中' : 'P3-低',
    count: items.filter(x => parseJson(x.req.priority_json, {})?.grade === grade).length
  }))
}

function overviewHtml({ project, iteration, items, version, mode, missing }) {
  const total = items.length
  const scoped = items.filter(x => x.req.status !== '需求调研中')
  const used = Math.round(scoped.reduce((s, x) => s + (parseJson(x.req.priority_json, {})?.estimateDays || 0), 0) * 10) / 10
  const statuses = statusCounts(items)
  const priorities = priorityCounts(items)
  const analysisDone = items.filter(x => x.analysisRow).length
  const protoDone = items.filter(x => x.proto?.status === 'confirmed').length
  const specDone = items.filter(x => x.spec?.status === 'published').length
  const pct = n => (total ? Math.round(n / total * 100) : 0)
  const overdue = items.flatMap(x => x.milestones.overdue.map(o => ({ ...o, req: x.req })))
  const upcoming = items.flatMap(x => x.milestones.fields
    .filter(f => f.plan && !f.actual && Date.parse(f.plan) >= Date.now())
    .map(f => ({ ...f, req: x.req })))
    .sort((a, b) => Date.parse(a.plan) - Date.parse(b.plan)).slice(0, 8)

  const reqRows = items.map(x => {
    const pr = parseJson(x.req.priority_json, {})
    return `<tr><td>${esc(x.req.code || '未编号')}</td><td>${esc(x.req.title)}</td><td>${esc(pr.gradeLabel || pr.grade || '未定')}</td>
      <td>${esc(x.milestones.productManager || '—')}</td><td>${esc(statusLabel(x.req.status))}</td>
      <td>${x.analysisRow ? 'V' + x.analysisRow.version : '待补'}</td>
      <td>${x.proto ? 'V' + x.proto.version + '（' + (x.proto.status === 'confirmed' ? '已确认' : '草稿') + '）' : '待补'}</td>
      <td>${x.spec ? 'V' + x.spec.version + '（' + (x.spec.status === 'published' ? '已发布' : '草稿') + '）' : '待补'}</td></tr>`
  }).join('')

  const missingBlock = missing.length
    ? `<div class="notice"><b>本版为${mode === 'formal' ? '正式版' : '草稿版'}，存在 ${missing.length} 条需求内容待补</b>
       <ul>${missing.map(m => `<li>${esc(m.code || '未编号')} ${esc(m.title)}：${m.items.map(esc).join('、')}</li>`).join('')}</ul></div>`
    : '<p class="ok-note">全部纳入需求的分析、原型与说明书均已完成。</p>'

  return `<section id="overview"><h2>迭代总览</h2>
    <div class="meta-grid">
      <div><span>迭代目标</span><p>${esc(iteration.goal || '—')}</p></div>
      <div><span>起止时间</span><p>${esc(iteration.start_date || '—')} 至 ${esc(iteration.end_date || '—')}</p></div>
      <div><span>容量占用</span><p>${used} / ${iteration.capacity_days || 0} 人日${iteration.capacity_days > 0 && used > iteration.capacity_days ? '（超限）' : ''}</p></div>
      <div><span>需求数量</span><p>${total} 条</p></div>
    </div>
    <h3>状态分布</h3>
    <table class="grid"><thead><tr><th>状态</th><th>数量</th><th>需求</th></tr></thead><tbody>
      ${statuses.map(s => `<tr><td>${esc(s.status)}</td><td>${s.count}</td><td>${esc(items.filter(x => x.req.status === s.status).map(x => x.req.title).join('、'))}</td></tr>`).join('')}
    </tbody></table>
    <h3>优先级分布</h3>
    <table class="grid"><thead><tr>${priorities.map(p => `<th>${p.label}</th>`).join('')}</tr></thead>
      <tbody><tr>${priorities.map(p => `<td>${p.count}</td>`).join('')}</tr></tbody></table>
    <h3>产物覆盖</h3>
    <table class="grid"><thead><tr><th>产物</th><th>已完成</th><th>覆盖率</th></tr></thead><tbody>
      <tr><td>分析版本</td><td>${analysisDone} / ${total}</td><td>${pct(analysisDone)}%</td></tr>
      <tr><td>已确认原型</td><td>${protoDone} / ${total}</td><td>${pct(protoDone)}%</td></tr>
      <tr><td>已发布说明书</td><td>${specDone} / ${total}</td><td>${pct(specDone)}%</td></tr>
    </tbody></table>
    <h3>纳入需求</h3>
    <table class="grid"><thead><tr><th>需求编号</th><th>需求标题</th><th>优先级</th><th>产品经理</th><th>状态</th><th>分析</th><th>原型</th><th>说明书</th></tr></thead>
      <tbody>${reqRows}</tbody></table>
    <h3>里程碑</h3>
    ${overdue.length ? `<p class="warn">逾期 ${overdue.length} 项：${overdue.map(o => `${esc(o.req.code || o.req.title)} ${esc(o.label)}（计划 ${esc(String(o.plan).slice(0, 10))}）`).join('；')}</p>` : '<p>暂无逾期里程碑。</p>'}
    ${upcoming.length ? `<table class="grid"><thead><tr><th>需求</th><th>里程碑</th><th>计划时间</th></tr></thead><tbody>
      ${upcoming.map(u => `<tr><td>${esc(u.req.code || u.req.title)}</td><td>${esc(u.label)}</td><td>${esc(String(u.plan).slice(0, 10))}</td></tr>`).join('')}
    </tbody></table>` : ''}
    ${missingBlock}
  </section>`
}

function appendixHtml({ items, version, mode }) {
  const matrix = items.map(x => {
    const pr = parseJson(x.req.priority_json, {})
    return `<tr><td>${esc(x.req.code || '未编号')}</td><td>${esc(x.req.title)}</td><td>${esc(statusLabel(x.req.status))}</td>
      <td>${esc(pr.gradeLabel || pr.grade || '未定')}</td><td>${esc(x.milestones.productManager || '—')}</td>
      <td>${x.analysisRow ? 'V' + x.analysisRow.version : '—'}</td><td>${x.proto ? 'V' + x.proto.version : '—'}</td>
      <td>${x.spec ? 'V' + x.spec.version : '—'}</td><td>${x.quality.ok ? '通过' : '待修复'}</td></tr>`
  }).join('')
  const fields = ['productManager', ...MILESTONE_FIELDS.map(f => f.key)]
  const labels = { productManager: '产品经理', ...Object.fromEntries(MILESTONE_FIELDS.map(f => [f.key, f.short])) }
  const msRows = items.map(x => `<tr><td>${esc(x.req.code || '未编号')}</td>${fields.map(f => {
    if (f === 'productManager') return `<td>${esc(x.milestones.productManager || '—')}</td>`
    const actual = x.milestones[f] ? String(x.milestones[f]).slice(0, 10) : ''
    const plan = x.milestones.plan?.[f] ? String(x.milestones.plan[f]).slice(0, 10) : ''
    return `<td>${actual ? '实 ' + esc(actual) : '—'}${plan ? ' / 计 ' + esc(plan) : ''}</td>`
  }).join('')}</tr>`).join('')
  const consistency = items.map(x => {
    const errs = x.quality.issues.filter(i => i.level === 'error')
    return `<tr><td>${esc(x.req.code || '未编号')}</td><td>${esc(x.req.title)}</td><td>${x.quality.ok ? '通过' : '不通过'}</td>
      <td>${errs.length ? errs.map(i => esc(i.message)).join('；') : '—'}</td><td>${x.missing.length ? x.missing.map(esc).join('；') : '—'}</td></tr>`
  }).join('')
  const refs = items.map(x => `<tr><td>${esc(x.req.code || '未编号')}</td><td>${esc(x.req.title)}</td>
    <td>${x.analysisRow ? 'V' + x.analysisRow.version : '—'}</td><td>${x.spec ? x.spec.id + '（V' + x.spec.version + '，' + esc(x.spec.status) + '）' : '—'}</td></tr>`).join('')

  return `<section id="appendix-a"><h2>附录 A 需求追踪矩阵</h2>
    <table class="grid"><thead><tr><th>需求编号</th><th>需求标题</th><th>状态</th><th>优先级</th><th>产品经理</th><th>分析版本</th><th>原型版本</th><th>说明书版本</th><th>分析质量</th></tr></thead><tbody>${matrix}</tbody></table></section>
  <section id="appendix-b"><h2>附录 B 里程碑汇总</h2>
    <table class="grid"><thead><tr><th>需求编号</th>${fields.map(f => `<th>${labels[f]}</th>`).join('')}</tr></thead><tbody>${msRows}</tbody></table></section>
  <section id="appendix-c"><h2>附录 C 一致性核查</h2>
    <table class="grid"><thead><tr><th>需求编号</th><th>需求标题</th><th>核查结论</th><th>不通过项</th><th>内容待补</th></tr></thead><tbody>${consistency}</tbody></table></section>
  <section id="appendix-d"><h2>附录 D 生成参数与版本引用</h2>
    <table class="grid"><thead><tr><th>项目</th><th>内容</th></tr></thead><tbody>
      <tr><td>生成方式</td><td>按迭代聚合单需求分析内容</td></tr>
      <tr><td>版本模式</td><td>V${version}（${mode === 'formal' ? '正式版' : '草稿版'}）</td></tr>
      <tr><td>生成时间</td><td>${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td></tr>
      <tr><td>纳入需求数</td><td>${items.length}</td></tr>
    </tbody></table>
    <table class="grid"><thead><tr><th>需求编号</th><th>需求标题</th><th>引用分析版本</th><th>引用说明书版本</th></tr></thead><tbody>${refs}</tbody></table></section>`
}

export function buildIterationSpec({ project, iteration, items, version, mode, skill = null }) {
  const missing = items
    .filter(x => x.missing.length)
    .map(x => ({ requirementId: x.req.id, code: x.req.code, title: x.req.title, items: x.missing }))
  if (mode === 'formal' && missing.length) {
    const err = new Error('正式版缺项，无法生成；可先生成草稿版')
    err.statusCode = 400
    err.details = { missing }
    throw err
  }

  const chapters = items.map((item, idx) => {
    const idPrefix = `r${idx + 1}-`
    const pr = parseJson(item.req.priority_json, {})
    const head = `<div class="chapter-head"><h2>${esc(item.req.title)}</h2>
      <table class="grid meta-table"><tbody>
        <tr><th>需求编号</th><td>${esc(item.req.code || '未编号')}</td><th>当前状态</th><td>${esc(statusLabel(item.req.status))}</td></tr>
        <tr><th>优先级</th><td>${esc(pr.gradeLabel || pr.grade || '未定')}</td><th>产品经理</th><td>${esc(item.milestones.productManager || '—')}</td></tr>
        <tr><th>分析版本</th><td>${item.analysisRow ? 'V' + item.analysisRow.version : '待补'}</td><th>更新时间</th><td>${esc(String(item.req.updated_at || '').slice(0, 19).replace('T', ' '))}</td></tr>
      </tbody></table></div>`
    if (!item.analysisRow) {
      return `<section class="req-chapter" id="req-${esc(item.req.id)}" data-req-id="${esc(item.req.id)}">${head}
        <div class="notice">本节待补：该需求尚未提交分析版本。${item.missing.map(esc).join('；')}</div></section>`
    }
    const errs = item.quality.issues.filter(i => i.level === 'error')
    const banner = item.missing.length || errs.length
      ? `<div class="notice">本节待补：${[...item.missing, ...errs.map(i => i.message)].join('；')}</div>`
      : ''
    return `<section class="req-chapter" id="req-${esc(item.req.id)}" data-req-id="${esc(item.req.id)}">${head}${banner}
      ${requirementFragment({ item, project, idPrefix })}</section>`
  }).join('\n')

  const toc = [['overview', '迭代总览']]
    .concat(items.map(x => [`req-${x.req.id}`, x.req.title]))
    .concat([['appendix-a', '附录 A 需求追踪矩阵'], ['appendix-b', '附录 B 里程碑汇总'], ['appendix-c', '附录 C 一致性核查'], ['appendix-d', '附录 D 生成参数与版本引用']])
    .map(([id, label]) => `<a href="#${esc(id)}">${esc(label)}</a>`).join('')

  const modeLabel = mode === 'formal' ? '正式版' : '草稿版'
  const docTitle = `${iteration.name} 迭代需求分析说明书`
  const docSubtitle = `${project.name}（${project.code}） · ${iteration.start_date || '—'} 至 ${iteration.end_date || '—'} · V${version} · ${modeLabel} · ${new Date().toLocaleDateString('zh-CN')}`
  const content = `${overviewHtml({ project, iteration, items, version, mode, missing })}
${chapters}
${appendixHtml({ items, version, mode })}`
  const footer = '本文档由需求管理工作台按迭代聚合生成，内容与各需求分析版本对应。'
  const template = skill?.artifactTemplate || DEFAULT_SPEC_TEMPLATE
  const html = renderSpecTemplate(template, { docTitle, docSubtitle, toc, content, footer })
  const hash = templateHash(template)

  const markdown = [
    `# ${iteration.name} 迭代需求分析说明书`,
    '',
    `| 项目 | 内容 |`,
    `| --- | --- |`,
    `| 所属项目 | ${project.name}（${project.code}） |`,
    `| 迭代周期 | ${iteration.start_date || '—'} 至 ${iteration.end_date || '—'} |`,
    `| 说明书版本 | V${version}（${mode === 'formal' ? '正式版' : '草稿版'}） |`,
    `| 纳入需求 | ${items.length} 条 |`,
    '',
    ...items.map(x => specMarkdown({
      req: x.req, project, analysis: x.analysis, pages: x.pages,
      version: x.analysisRow?.version || 0, reviews: x.reviews, changes: x.changes
    }).replace(/^(#+)/gm, '#$1')),
    missing.length ? `## 待补清单\n\n${missing.map(m => `- ${m.code || '未编号'} ${m.title}：${m.items.join('、')}`).join('\n')}` : ''
  ].join('\n')

  const source = {
    iterationId: iteration.id,
    iterationName: iteration.name,
    version,
    mode,
    generatedAt: now(),
    requirements: items.map(x => ({
      id: x.req.id, code: x.req.code, title: x.req.title,
      analysisVersion: x.analysisRow?.version || null,
      prototypeVersion: x.proto?.version || null,
      specId: x.spec?.id || null,
      specVersion: x.spec?.version || null,
      specStatus: x.spec?.status || null
    }))
  }

  return { html, markdown, source, missing, requirementCount: items.length, templateHash: hash }
}

export function markIterationSpecsStale(requirementId) {
  const req = get('SELECT iteration_id FROM requirements WHERE id = ?', requirementId)
  if (!req?.iteration_id) return 0
  const rows = all('SELECT id FROM iteration_specs WHERE iteration_id = ? AND stale = 0', req.iteration_id)
  if (!rows.length) return 0
  run('UPDATE iteration_specs SET stale = 1 WHERE iteration_id = ?', req.iteration_id)
  return rows.length
}

export function iterationSpecView(row) {
  return {
    ...row,
    missing: parseJson(row.missing_json, []),
    source: parseJson(row.source_json, {})
  }
}

export function nextIterationSpecVersion(iterationId) {
  const last = get('SELECT version FROM iteration_specs WHERE iteration_id = ? ORDER BY version DESC LIMIT 1', iterationId)
  return (last?.version || 0) + 1
}

export function newIterationSpecId() {
  return uid('ITSPEC-')
}
