import { normalizeAnalysis } from './render.mjs'
import { DEFAULT_SPEC_TEMPLATE, renderSpecTemplate, templateHash } from './spec-template.mjs'
import { flowOf, flowCandidateOf, archifyWorkflowSvg } from './flowchart.mjs'

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function parseJson(value, fallback = null) {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function scopeView(project) {
  const scope = parseJson(project.system_scope_json, {}) || {}
  const ent = parseJson(project.enterprise_scope_json, {}) || {}
  const lines = []
  if ((scope.platforms || []).length) lines.push(`平台：${scope.platforms.join('、')}`)
  if ((scope.applications || []).length) lines.push(`应用：${scope.applications.join('、')}`)
  if ((scope.modules || []).length) lines.push(`模块：${scope.modules.join('、')}`)
  if (!lines.length) lines.push('—')
  const entLines = []
  if (ent.mode) entLines.push(`模式：${ent.mode === 'unified' ? '统建' : ent.mode}`)
  if (ent.total) entLines.push(`单位总数：${ent.total}`)
  if ((ent.specialCompanies || []).length) entLines.push(`特别单位：${ent.specialCompanies.join('、')}`)
  if ((ent.provinceCompanies || []).length) entLines.push(`省级单位：${ent.provinceCompanies.join('、')}`)
  if ((ent.personalized || []).length) {
    entLines.push(`个性化单位：${ent.personalized.map(p => `${p.name || p}${p.diff ? `（${p.diff}）` : ''}`).join('、')}`)
  }
  if (!entLines.length) entLines.push('—')
  return { system: lines.join('；'), enterprise: entLines.join('；') }
}

function clarificationAnswers(req) {
  const clar = parseJson(req.clarification_json, {}) || {}
  const answers = clar.answers || {}
  const rows = [
    ['角色与岗位', answers.roles?.value], ['目标与价值', answers.goal?.value], ['范围', answers.scope?.value],
    ['边界', answers.boundary?.value], ['验收口径', answers.acceptance?.value]
  ]
  return rows.map(([label, value]) => ({ label, value: String(value || '—').replace(/\n/g, ' ') }))
}

function gridTable(headers, rows) {
  if (!rows.length) return '<p>—</p>'
  return `<table class="grid"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
}

export function buildRequirementSpec({ req, project, analysis, analysisVersion, pages, reviews, changes, proposals, version, proto, flowchartRows = [], quality, skill }) {
  const a = normalizeAnalysis(analysis)
  const scope = scopeView(project)
  const goals = parseJson(project.goals_json, []) || []
  const clarRows = clarificationAnswers(req)
  const involvedApps = parseJson(req.involved_apps_json, []) || []
  const priority = parseJson(req.priority_json, {}) || {}
  const flow = flowOf(a)
  const flowSvg = flow.length ? archifyWorkflowSvg(flowCandidateOf(flow)) : ''

  const chapters = []
  const md = []
  const push = (html, markdown) => { chapters.push(html); md.push(markdown) }

  push(
    `<section id="overview"><h2>1 项目概述</h2>
      <h3>1.1 项目背景</h3><p>${esc(project.background || project.description || '—')}</p>
      <h3>1.2 项目目标</h3>${goals.length ? `<ul>${goals.map(g => `<li>${esc(g)}</li>`).join('')}</ul>` : '<p>—</p>'}
      <h3>1.3 项目范围</h3><p>${esc(scope.system)}</p><p>${esc(scope.enterprise)}</p></section>`,
    `## 1 项目概述\n\n### 1.1 项目背景\n\n${project.background || project.description || '—'}\n\n### 1.2 项目目标\n\n${goals.map(g => `- ${g}`).join('\n') || '—'}\n\n### 1.3 项目范围\n\n${scope.system}\n${scope.enterprise}`
  )

  const clarTable = gridTable(['维度', '结论'], clarRows.map(r => [esc(r.label), esc(r.value)]))
  const metrics = (a.acceptance.metrics || [])
  push(
    `<section id="need"><h2>2 项目需求说明</h2>
      <div class="meta-grid">
        <div><span>需求背景</span><p>${esc(a.description.background || '—')}</p></div>
        <div><span>需求目标</span><p>${esc(a.description.goal || '—')}</p></div>
        <div><span>价值</span><p>${esc(a.description.value || '—')}</p></div>
        <div><span>使用角色</span><p>${esc((a.description.roles || []).join('、') || '—')}</p></div>
      </div>
      <h3>2.1 澄清结论</h3>${clarTable}
      <h3>2.2 验收口径</h3>
      <p>${esc(a.acceptance.overall || '—')}</p>
      ${(a.acceptance.steps || []).length ? `<ul>${a.acceptance.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      ${metrics.length ? gridTable(['指标', '目标值', '观察周期'], metrics.map(m => [esc(m.name), esc(m.target), esc(m.period || '上线后一个月')])) : ''}
    </section>`,
    `## 2 项目需求说明\n\n**背景**：${a.description.background || '—'}\n\n**目标**：${a.description.goal || '—'}\n\n**价值**：${a.description.value || '—'}\n\n**角色**：${(a.description.roles || []).join('、') || '—'}\n\n### 2.1 澄清结论\n\n${clarRows.map(r => `- ${r.label}：${r.value}`).join('\n')}\n\n### 2.2 验收口径\n\n${a.acceptance.overall || '—'}${(a.acceptance.steps || []).map(s => `\n- ${s}`).join('')}`
  )

  const fnSections = (a.functions.list || []).map(f => `<h4>${esc(f.name)}</h4>
    <table class="grid meta-table"><tbody>
      <tr><th>说明</th><td>${esc(f.description || '—')}</td></tr>
      <tr><th>触发场景</th><td>${esc(f.trigger || '—')}</td></tr>
      <tr><th>处理规则</th><td>${esc(f.rules || '—')}</td></tr>
      <tr><th>处理结果</th><td>${esc(f.result || '—')}</td></tr>
      <tr><th>验收要点</th><td>${esc(f.acceptance || '—')}</td></tr>
      <tr><th>优先级</th><td>${esc(f.priority || 'P1')}</td></tr>
    </tbody></table>`).join('')
  const supportRows = (a.functions.support || []).map(s => [esc(s.name), esc(s.description || '')])
  const appRows = (a.integration.apps || []).map(x => [esc(x.name), x.kind === 'external' ? '外部依赖' : '内部应用', esc(x.note || '')])
  push(
    `<section id="functions"><h2>3 功能说明</h2>
      <h3>3.1 应用系统影响分析</h3>
      ${gridTable(['应用', '类型', '说明'], appRows)}
      ${involvedApps.length ? `<p>关联应用功能点：${esc(involvedApps.map(x => `${x.name || x}${(x.functions || []).length ? `（${x.functions.map(fn => fn.name || fn).join('、')}）` : ''}`).join('；'))}</p>` : ''}
      <h3>3.2 应用整体功能流程说明</h3>
      ${flowSvg ? `<p class="caption">图 功能流程图</p><div class="diagram">${flowSvg}</div>` : '<p>本期无功能流程步骤。</p>'}
      <h3>3.3 功能说明</h3>${fnSections || '<p>—</p>'}
      <h3>3.4 辅助支撑功能</h3>${supportRows.length ? gridTable(['功能', '说明'], supportRows) : '<p>本期无需额外辅助支撑功能。</p>'}
    </section>`,
    `## 3 功能说明\n\n### 3.1 应用系统影响分析\n\n${(a.integration.apps || []).map(x => `- ${x.name}${x.kind === 'external' ? '（外部依赖）' : ''}`).join('\n') || '—'}\n\n### 3.2 应用整体功能流程说明\n\n${flow.length ? flow.map((f, i) => `${i + 1}. ${f.action || ''}（${f.from || '—'} → ${f.to || '—'}${f.condition ? `，条件：${f.condition}` : ''}）`).join('\n') : '本期无功能流程步骤。'}\n\n### 3.3 功能说明\n\n${(a.functions.list || []).map(f => `#### ${f.name}\n\n- 说明：${f.description || '—'}\n- 触发场景：${f.trigger || '—'}\n- 处理规则：${f.rules || '—'}\n- 处理结果：${f.result || '—'}\n- 验收要点：${f.acceptance || '—'}`).join('\n\n') || '—'}`
  )

  const pointRows = (a.integration.points || []).map(p => [esc(p.app || ''), esc(p.direction || ''), esc(p.object || ''), esc(p.trigger || ''), esc(p.note || '')])
  push(
    `<section id="integration"><h2>4 应用集成说明</h2>
      <h3>4.1 涉及应用</h3>${gridTable(['应用', '类型', '说明'], appRows)}
      <h3>4.2 集成点</h3>${gridTable(['应用', '方向', '数据对象', '触发时机', '说明'], pointRows)}
    </section>`,
    `## 4 应用集成说明\n\n${(a.integration.points || []).map(p => `- ${p.app || '—'}：${p.direction || ''} ${p.object || ''}，触发时机：${p.trigger || '—'}`).join('\n') || '—'}`
  )

  const reviewRows = (reviews || []).map(r => [esc(`第 ${r.round} 轮`), esc(parseJson(r.reviewers_json, []).join('、')), esc(r.conclusion || '进行中'), esc(String((r.decided_at || r.created_at) || '').slice(0, 10))])
  push(
    `<section id="approval"><h2>5 审批意见</h2>
      ${reviewRows.length ? gridTable(['轮次', '评审人', '结论', '时间'], reviewRows) : '<p>尚未发起评审，待评审后补充审批意见。</p>'}
    </section>`,
    `## 5 审批意见\n\n${(reviews || []).map(r => `- 第 ${r.round} 轮：${r.conclusion || '进行中'}（${String((r.decided_at || r.created_at) || '').slice(0, 10)}）`).join('\n') || '尚未发起评审。'}`
  )

  const changeRows = (changes || []).map(c => [`CHG-${String(c.seq).padStart(3, '0')}`, esc(c.grade), esc(c.content), esc(c.handling || '—'), esc(c.status)])
  const issues = quality?.issues || []
  const appendices = []
  const appendixMd = []
  const pushAppendix = (id, title, html, markdown) => { appendices.push(`<section id="${id}"><h2>${title}</h2>${html}</section>`); appendixMd.push(`## ${title}\n\n${markdown}`) }

  pushAppendix('appendix-a', '附录 A 需求追踪',
    `<table class="grid meta-table"><tbody>
      <tr><th>需求编号</th><td>${esc(req.code || '未编号')}</td></tr>
      <tr><th>需求标题</th><td>${esc(req.title)}</td></tr>
      <tr><th>阶段状态</th><td>${esc(req.status)}</td></tr>
      <tr><th>优先级</th><td>${esc(priority.gradeLabel || priority.grade || '未定')}</td></tr>
      <tr><th>分析版本</th><td>V${analysisVersion}</td></tr>
      <tr><th>原型版本</th><td>${proto ? `V${proto.version}（${proto.status === 'confirmed' ? '已确认' : '草稿'}）` : '—'}</td></tr>
      <tr><th>说明书版本</th><td>V${version}</td></tr>
    </tbody></table>`,
    `- 需求编号：${req.code || '未编号'}\n- 需求标题：${req.title}\n- 阶段状态：${req.status}\n- 优先级：${priority.gradeLabel || priority.grade || '未定'}\n- 分析版本：V${analysisVersion}\n- 原型版本：${proto ? `V${proto.version}（${proto.status}）` : '—'}\n- 说明书版本：V${version}`)

  const archRows = (a.functions.architecture || []).map(n => [esc(n.parent || '一级模块'), esc(n.name), esc(n.description || ''), esc(n.priority || 'P1')])
  pushAppendix('appendix-b', '附录 B 应用/模块影响',
    `${gridTable(['层级', '功能', '说明', '优先级'], archRows)}
     ${involvedApps.length ? `<p>关联应用：${esc(involvedApps.map(x => x.name || x).join('、'))}</p>` : ''}`,
    (a.functions.architecture || []).map(n => `- ${n.parent ? `${n.parent} / ` : ''}${n.name}：${n.description || '—'}`).join('\n') || '—')

  pushAppendix('appendix-c', '附录 C 非功能需求',
    supportRows.length ? gridTable(['约束项', '说明'], supportRows) : '<p>本期未登记额外非功能约束。</p>',
    supportRows.length ? (a.functions.support || []).map(s => `- ${s.name}：${s.description || '—'}`).join('\n') : '本期未登记额外非功能约束。')

  const riskItems = [
    ...issues.filter(i => i.level === 'warn').map(i => `一致性提示：${i.message}`),
    ...clarRows.filter(r => r.value === '—').map(r => `澄清待确认：${r.label}`)
  ]
  pushAppendix('appendix-d', '附录 D 风险、假设与待确认',
    riskItems.length ? `<ul>${riskItems.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>暂无。</p>',
    riskItems.map(x => `- ${x}`).join('\n') || '暂无。')

  const source = parseJson(req.source_json, {}) || {}
  pushAppendix('appendix-e', '附录 E 来源索引',
    `<table class="grid meta-table"><tbody>
      <tr><th>登记方式</th><td>${esc(req.origin_type || '—')}</td></tr>
      <tr><th>来源说明</th><td>${esc(source.submitter ? `提交人：${source.submitter}` : source.doc || source.text?.slice(0, 80) || '—')}</td></tr>
      <tr><th>登记时间</th><td>${esc(String(req.created_at || '').slice(0, 10))}</td></tr>
    </tbody></table>`,
    `- 登记方式：${req.origin_type || '—'}\n- 来源：${source.submitter || source.doc || '—'}`)

  pushAppendix('appendix-f', '附录 F 设计规范',
    `<p>原型共 ${pages.length} 个页面，覆盖默认、空、加载、错误与无权限五种状态；页面布局遵循项目约定的设计令牌与组件规范。</p>`,
    `原型共 ${pages.length} 个页面，覆盖默认、空、加载、错误与无权限五种状态。`)

  pushAppendix('appendix-g', '附录 G 图表索引',
    flowchartRows.length
      ? gridTable(['分析版本', '渲染器', '生成技能', '更新时间'],
          flowchartRows.map(f => [`V${f.analysis_version}`, esc(f.renderer === 'archify' ? '交互图' : '步骤清单'), esc(f.skill_slug ? `${f.skill_slug}@${f.skill_version}` : '内置渲染器'), esc(String(f.updated_at || '').slice(0, 19).replace('T', ' '))]))
      : '<p>本期无流程图产物。</p>',
    flowchartRows.map(f => `- V${f.analysis_version}：${f.renderer}${f.skill_slug ? `（${f.skill_slug}@${f.skill_version}）` : ''}`).join('\n') || '本期无流程图产物。')

  pushAppendix('appendix-h', '附录 H 原型索引',
    pages.length ? gridTable(['页面', '布局', '覆盖功能'], pages.map(p => [esc(p.name), esc(p.layout), esc((p.functions || []).join('、'))])) : '<p>本期无原型页面。</p>',
    pages.map(p => `- ${p.name}（${p.layout}）`).join('\n') || '本期无原型页面。')

  pushAppendix('appendix-j', '附录 J 过程资产索引',
    `<table class="grid meta-table"><tbody>
      <tr><th>分析版本</th><td>V${analysisVersion}</td></tr>
      <tr><th>原型版本</th><td>${proto ? `V${proto.version}` : '—'}</td></tr>
      <tr><th>说明书版本</th><td>V${version}</td></tr>
    </tbody></table>`,
    `- 分析版本：V${analysisVersion}\n- 原型版本：${proto ? `V${proto.version}` : '—'}\n- 说明书版本：V${version}`)

  pushAppendix('appendix-k', '附录 K 需求澄清单',
    gridTable(['维度', '结论'], clarRows.map(r => [esc(r.label), esc(r.value)])),
    clarRows.map(r => `- ${r.label}：${r.value}`).join('\n'))

  pushAppendix('appendix-l', '附录 L 产品基线与应用架构',
    gridTable(['层级', '功能', '说明', '优先级'], archRows),
    (a.functions.architecture || []).map(n => `- ${n.parent ? `${n.parent} / ` : ''}${n.name}`).join('\n') || '—')

  pushAppendix('appendix-m', '附录 M 设计规范来源与确认',
    `<table class="grid meta-table"><tbody>
      <tr><th>原型版本</th><td>${proto ? `V${proto.version}` : '—'}</td></tr>
      <tr><th>确认状态</th><td>${proto ? (proto.status === 'confirmed' ? '已确认' : '草稿') : '—'}</td></tr>
      <tr><th>页面数</th><td>${pages.length}</td></tr>
    </tbody></table>`,
    `- 原型版本：${proto ? `V${proto.version}` : '—'}\n- 确认状态：${proto ? proto.status : '—'}`)

  pushAppendix('appendix-n', '附录 N 项目画像与范围',
    `<table class="grid meta-table"><tbody>
      <tr><th>项目</th><td>${esc(project.name)}（${esc(project.code)}）</td></tr>
      <tr><th>负责组织</th><td>${esc(project.owner_org || '—')}</td></tr>
      <tr><th>系统范围</th><td>${esc(scope.system)}</td></tr>
      <tr><th>企业范围</th><td>${esc(scope.enterprise)}</td></tr>
    </tbody></table>`,
    `- 项目：${project.name}（${project.code}）\n- 负责组织：${project.owner_org || '—'}\n- 系统范围：${scope.system}\n- 企业范围：${scope.enterprise}`)

  pushAppendix('appendix-o', '附录 O 一致性核对',
    issues.length
      ? gridTable(['级别', '位置', '问题'], issues.map(i => [esc(i.level === 'error' ? '错误' : '提示'), esc(i.field), esc(i.message)]))
      : '<p>一致性核查通过，无问题项。</p>',
    issues.length ? issues.map(i => `- [${i.level}] ${i.field}：${i.message}`).join('\n') : '一致性核查通过。')

  pushAppendix('appendix-q', '附录 Q 交互确认记录',
    (proposals || []).length
      ? gridTable(['动作', '状态', '确认时间'],
          proposals.map(p => [esc(p.action), esc(p.status), esc(p.applied_at ? String(p.applied_at).slice(0, 19).replace('T', ' ') : '—')]))
      : '<p>本期无待追溯的交互确认记录。</p>',
    (proposals || []).map(p => `- ${p.action}：${p.status}`).join('\n') || '本期无待追溯的交互确认记录。')

  const toc = [
    ['overview', '1 项目概述'], ['need', '2 项目需求说明'], ['functions', '3 功能说明'],
    ['integration', '4 应用集成说明'], ['approval', '5 审批意见'],
    ['appendix-a', '附录 A 需求追踪'], ['appendix-b', '附录 B 应用/模块影响'], ['appendix-c', '附录 C 非功能需求'],
    ['appendix-d', '附录 D 风险、假设与待确认'], ['appendix-e', '附录 E 来源索引'], ['appendix-f', '附录 F 设计规范'],
    ['appendix-g', '附录 G 图表索引'], ['appendix-h', '附录 H 原型索引'], ['appendix-j', '附录 J 过程资产索引'],
    ['appendix-k', '附录 K 需求澄清单'], ['appendix-l', '附录 L 产品基线与应用架构'],
    ['appendix-m', '附录 M 设计规范来源与确认'], ['appendix-n', '附录 N 项目画像与范围'],
    ['appendix-o', '附录 O 一致性核对'], ['appendix-q', '附录 Q 交互确认记录']
  ].map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`).join('')

  const generatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  const docTitle = `${req.title} 需求分析说明书`
  const skillNote = skill?.slug ? `按技能 ${skill.slug} V${skill.version} 的说明书组装契约生成` : ''
  const docSubtitle = `${project.name}（${project.code}） · V${version} · ${generatedAt}${skillNote ? ` · ${skillNote}` : ''}`
  const content = `${chapters.join('\n')}\n${appendices.join('\n')}`
  const footer = `本文档由需求管理工作台生成，内容与需求分析版本 V${version} 对应。${skillNote}`
  const template = skill?.artifactTemplate || DEFAULT_SPEC_TEMPLATE
  const html = renderSpecTemplate(template, { docTitle, docSubtitle, toc, content, footer })

  const markdown = [
    `# ${docTitle}`, '',
    `| 项目 | 内容 |`, `| --- | --- |`,
    `| 所属项目 | ${project.name}（${project.code}） |`,
    `| 说明书版本 | V${version} |`,
    `| 生成时间 | ${generatedAt} |`,
    skillNote ? `| 生成技能 | ${skill.slug} V${skill.version} |` : '',
    '', ...md, ...appendixMd
  ].filter((line, i) => !(i === 7 && !line)).join('\n')

  return { html, markdown, templateHash: templateHash(template) }
}

export function assertRequirementSpecStructure(html, { code } = {}) {
  const fail = (message, statusCode = 500, errCode = 'SPEC_RENDER_INCONSISTENT') => {
    const e = new Error(message)
    e.statusCode = statusCode
    e.code = errCode
    return e
  }
  for (const id of ['overview', 'need', 'functions', 'integration', 'approval', 'appendix-a', 'appendix-o']) {
    if (!html.includes(`id="${id}"`)) throw fail(`说明书缺少必需章节：${id}`)
  }
  if (html.includes('{{')) throw fail('说明书存在未替换的占位符', 400, 'SPEC_TEMPLATE_INVALID')
  if (code) {
    const cut = html.indexOf('<section id="appendix-a"')
    const body = cut >= 0 ? html.slice(0, cut) : html
    if (body.includes(code)) {
      throw fail('需求编号不得出现在正文叙述与标题中（仅允许出现在追踪表与附录索引）', 400, 'SPEC_CODE_IN_BODY')
    }
  }
  return { chapters: (html.match(/<section id="/g) || []).length }
}
