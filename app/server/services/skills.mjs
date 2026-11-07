import JSZip from 'jszip'
import path from 'node:path'
import { all, get, run, tx, now, uid, parseJson } from '../db.mjs'
import { DEFAULT_SPEC_TEMPLATE, MAX_SPEC_HTML_BYTES } from './spec-template.mjs'

export const SKILL_STAGES = ['clarify', 'analysis', 'prototype', 'review', 'change', 'spec']
export const DOCUMENT_STAGE = 'spec'
const STAGE_ALIASES = { clarification: 'clarify' }
const MAX_FILES = 200
const MAX_BYTES = 20 * 1024 * 1024
const TEXT_EXT = new Set(['.json', '.md', '.html', '.htm', '.txt', '.yml', '.yaml'])
const BLOCKED_EXT = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.ps1', '.sh', '.js', '.mjs', '.cjs', '.py',
  '.com', '.scr', '.msi', '.vbs', '.jar', '.bin', '.so', '.dylib'
])

function fail(message, statusCode = 400, code = '') {
  const e = new Error(message)
  e.statusCode = statusCode
  if (code) e.code = code
  return e
}

export function normalizeStages(value) {
  if (value === undefined || value === null || value === '') return []
  const source = Array.isArray(value) ? value : String(value).split(/[、,，]/)
  const stages = []
  for (const raw of source) {
    const key = STAGE_ALIASES[String(raw).trim()] || String(raw).trim()
    if (!key) continue
    if (!SKILL_STAGES.includes(key)) {
      throw fail(`未知的需求环节：${raw}；允许的环节为 ${SKILL_STAGES.join('、')}`)
    }
    if (!stages.includes(key)) stages.push(key)
  }
  return stages
}

export function sameStages(a = [], b = []) {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every(x => setB.has(x))
}

export const BUILTIN_SKILL_PACK = {
  name: 'qoder-prd-skill-pack',
  version: '1.3.1',
  expected: 13
}

const ASSEMBLE_DEF = {
  slug: 'prd-assemble',
  name: '说明书组装',
  version: BUILTIN_SKILL_PACK.version,
  description: '聚合分析与原型产物，按模板组装 Markdown、HTML 与 Word 说明书',
  stages: [DOCUMENT_STAGE],
  inputSchema: {
    type: 'object',
    properties: {
      iterationId: { type: 'string' },
      mode: { enum: ['draft', 'formal'] },
      requirementCount: { type: 'integer' }
    },
    required: ['iterationId']
  },
  outputSchema: {
    type: 'object',
    properties: { html: { type: 'string' }, markdown: { type: 'string' }, missing: { type: 'array' } }
  },
  promptTemplate: '',
  artifactTemplate: DEFAULT_SPEC_TEMPLATE,
  validation: {
    placeholders: ['{{docTitle}}', '{{docSubtitle}}', '{{toc}}', '{{content}}', '{{footer}}'],
    required: ['{{content}}'],
    requiredSections: ['overview', 'appendix-a'],
    maxBytes: MAX_SPEC_HTML_BYTES
  }
}

export const BUILTIN_SKILL_DEFS = [
  {
    slug: 'prd-pipeline', name: '需求流水线编排', version: BUILTIN_SKILL_PACK.version,
    description: '编排需求澄清至交付的九个阶段，按产物与门禁调度各环节技能', stages: []
  },
  {
    slug: 'prd-profile', name: '项目画像', version: BUILTIN_SKILL_PACK.version,
    description: '收集项目基本信息、干系人与系统范围，锁定可继承的项目画像', stages: ['clarify']
  },
  {
    slug: 'prd-discovery', name: '需求澄清', version: BUILTIN_SKILL_PACK.version,
    description: '通过连续追问澄清角色、目标、范围、边界与验收口径', stages: ['clarify']
  },
  {
    slug: 'grill-me', name: '深度追问', version: BUILTIN_SKILL_PACK.version,
    description: '以持续具体的问题压力测试计划与设计，直至关键未知项收敛', stages: ['clarify']
  },
  {
    slug: 'grilling', name: '结构化访谈', version: BUILTIN_SKILL_PACK.version,
    description: '按角色、目标、规则、异常、数据与验收维度输出结构化访谈记录', stages: ['clarify']
  },
  {
    slug: 'prd-context', name: '需求上下文', version: BUILTIN_SKILL_PACK.version,
    description: '整理材料、既有系统与历史方案，形成带来源的事实与集成清单', stages: ['analysis']
  },
  {
    slug: 'prd-design-spec', name: '设计规范', version: BUILTIN_SKILL_PACK.version,
    description: '判定设计基线并从截图或既有样式提炼设计与令牌规范', stages: ['analysis', 'prototype']
  },
  {
    slug: 'prd-analysis', name: '结构化分析', version: BUILTIN_SKILL_PACK.version,
    description: '按业务与领域建模方法输出分析正文、功能清单与图表计划', stages: ['analysis']
  },
  {
    slug: 'prd-visuals', name: '图表生成', version: BUILTIN_SKILL_PACK.version,
    description: '生成业务、功能、时序、状态与架构图表并校验图文一致', stages: ['analysis', 'prototype']
  },
  {
    slug: 'prd-prototype', name: '界面原型', version: BUILTIN_SKILL_PACK.version,
    description: '按分析与设计规范生成自包含页面原型并覆盖关键状态', stages: ['prototype']
  },
  {
    slug: 'archify', name: '架构图', version: BUILTIN_SKILL_PACK.version,
    description: '生成可交互的架构、流程与状态图，支持多格式导出', stages: ['analysis', 'prototype']
  },
  ASSEMBLE_DEF,
  {
    slug: 'prd-quality', name: '全链路质检', version: BUILTIN_SKILL_PACK.version,
    description: '对澄清至成品的全链路做确定性检查并输出问题台账与回退路由', stages: ['review']
  }
].map(def => ({
  id: `SK-${def.slug}`,
  stage: def.stages.join(','),
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  promptTemplate: '',
  artifactTemplate: '',
  validation: {},
  ...def
}))

const RETIRED_BUILTIN_SLUGS = ['spec-assemble']

export function ensureBuiltinSkills() {
  let changed = 0
  for (const def of BUILTIN_SKILL_DEFS) {
    const existing = get('SELECT * FROM skills WHERE slug = ? AND version = ?', def.slug, def.version)
    if (!existing) {
      run(`INSERT INTO skills (id, slug, name, version, description, stage, input_schema_json, output_schema_json,
           prompt_template, artifact_template, validation_json, enabled, is_builtin, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        def.id, def.slug, def.name, def.version, def.description, def.stage,
        JSON.stringify(def.inputSchema), JSON.stringify(def.outputSchema),
        def.promptTemplate, def.artifactTemplate, JSON.stringify(def.validation), 1, 1, now())
      changed += 1
      continue
    }
    if (!existing.is_builtin) continue
    const nextValidation = JSON.stringify(def.validation)
    if (existing.name !== def.name || existing.description !== def.description || existing.stage !== def.stage ||
        existing.artifact_template !== def.artifactTemplate || existing.validation_json !== nextValidation ||
        !existing.enabled) {
      run(`UPDATE skills SET name = ?, description = ?, stage = ?, artifact_template = ?, validation_json = ?, enabled = 1
           WHERE id = ?`,
        def.name, def.description, def.stage, def.artifactTemplate, nextValidation, existing.id)
      changed += 1
    }
  }
  for (const slug of RETIRED_BUILTIN_SLUGS) {
    const retired = get('SELECT id FROM skills WHERE slug = ? AND is_builtin = 1', slug)
    if (!retired) continue
    run('UPDATE skills SET is_builtin = 0, enabled = 0 WHERE id = ?', retired.id)
    changed += 1
  }
  return changed
}

export function migrateSpecAssembleBindings() {
  const old = get("SELECT id FROM skills WHERE slug = 'spec-assemble'")
  const target = get('SELECT id FROM skills WHERE slug = ? AND version = ?', ASSEMBLE_DEF.slug, ASSEMBLE_DEF.version)
  if (!old || !target) return 0
  const bindings = all("SELECT * FROM project_skills WHERE skill_id = ? AND source_type = 'builtin'", old.id)
  let moved = 0
  tx(() => {
    for (const binding of bindings) {
      const duplicate = get('SELECT id FROM project_skills WHERE project_id = ? AND skill_id = ?', binding.project_id, target.id)
      if (duplicate) {
        run('DELETE FROM project_skills WHERE id = ?', binding.id)
      } else {
        run('UPDATE project_skills SET skill_id = ? WHERE id = ?', target.id, binding.id)
      }
      moved += 1
    }
  })
  return moved
}

function packDefOf(slug) {
  return BUILTIN_SKILL_DEFS.find(def => def.slug === slug) || null
}

export function ensureBuiltinBindings(projectId = null) {
  const slugs = BUILTIN_SKILL_DEFS.map(def => def.slug)
  const builtins = all(
    `SELECT id, slug FROM skills WHERE is_builtin = 1 AND version = ? AND slug IN (${slugs.map(() => '?').join(',')})`,
    BUILTIN_SKILL_PACK.version, ...slugs
  )
  if (!builtins.length) return 0
  const projects = projectId
    ? all('SELECT id FROM projects WHERE id = ?', projectId)
    : all('SELECT id FROM projects')
  let created = 0
  tx(() => {
    for (const project of projects) {
      for (const skill of builtins) {
        const exists = get('SELECT id FROM project_skills WHERE project_id = ? AND skill_id = ?', project.id, skill.id)
        if (exists) continue
        const def = packDefOf(skill.slug)
        run(`INSERT INTO project_skills (id, project_id, skill_id, source_type, source_project_id, stages_json, enabled, created_by, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          uid('PSK-'), project.id, skill.id, 'builtin', project.id,
          JSON.stringify(def ? def.stages : []), 1, 'system', now())
        created += 1
      }
    }
  })
  return created
}

const SKILL_COLUMNS = `ps.*, s.slug, s.name, s.version, s.description, s.stage,
  s.enabled AS package_enabled, s.is_builtin, s.input_schema_json, s.output_schema_json,
  s.prompt_template, s.artifact_template, s.validation_json`

function sourceStatus(row) {
  if (row.source_type !== 'reference') return { available: true, reason: '' }
  const src = get(`SELECT ps.enabled AS binding_enabled, s.enabled AS package_enabled
    FROM project_skills ps JOIN skills s ON s.id = ps.skill_id
    WHERE ps.project_id = ? AND ps.skill_id = ?`, row.source_project_id, row.skill_id)
  if (!src) return { available: false, reason: '来源项目已移除该技能' }
  if (!src.binding_enabled) return { available: false, reason: '来源项目已停用该技能' }
  if (!src.package_enabled) return { available: false, reason: '来源技能包已停用' }
  return { available: true, reason: '' }
}

export function projectSkillView(row, includePrompt = false) {
  const source = sourceStatus(row)
  const sourceProject = row.source_project_id
    ? get('SELECT id, name FROM projects WHERE id = ?', row.source_project_id)
    : null
  const view = {
    id: row.id,
    projectId: row.project_id,
    skillId: row.skill_id,
    sourceType: row.source_type,
    sourceProject,
    stages: parseJson(row.stages_json, []),
    bindingEnabled: Boolean(row.enabled),
    packageEnabled: Boolean(row.package_enabled),
    sourceAvailable: source.available,
    sourceReason: source.reason,
    enabled: Boolean(row.enabled && row.package_enabled && source.available),
    isBuiltin: row.source_type === 'builtin' || Boolean(row.is_builtin),
    slug: row.slug,
    name: row.name,
    version: row.version,
    description: row.description,
    stage: row.stage
  }
  if (includePrompt) {
    view.inputSchema = parseJson(row.input_schema_json, {})
    view.outputSchema = parseJson(row.output_schema_json, {})
    view.promptTemplate = row.prompt_template || ''
    view.artifactTemplate = row.artifact_template || ''
    view.validation = parseJson(row.validation_json, {})
  }
  return view
}

export function listProjectSkills(projectId) {
  return all(`SELECT ${SKILL_COLUMNS}
    FROM project_skills ps JOIN skills s ON s.id = ps.skill_id
    WHERE ps.project_id = ?
    ORDER BY CASE ps.source_type WHEN 'builtin' THEN 0 WHEN 'import' THEN 1 ELSE 2 END, s.name`,
    projectId).map(row => projectSkillView(row))
}

export function projectSkillRow(projectId, bindingId) {
  return get(`SELECT ${SKILL_COLUMNS}
    FROM project_skills ps JOIN skills s ON s.id = ps.skill_id
    WHERE ps.project_id = ? AND ps.id = ?`, projectId, bindingId)
}

export function applicableSkills(projectId, stage) {
  return listProjectSkills(projectId).filter(s => s.enabled && (!s.stages.length || s.stages.includes(stage)))
}

export function executableSkill(projectId, bindingId, stage) {
  const row = projectSkillRow(projectId, bindingId)
  if (!row) throw fail('项目技能不存在', 404)
  const view = projectSkillView(row, true)
  if (!view.enabled) throw fail(`技能不可用：${view.sourceReason || '技能已停用'}`, 403)
  if (view.stages.length && !view.stages.includes(stage)) {
    throw fail(`该技能仅适用于：${view.stages.join('、')}`, 403)
  }
  return view
}

function documentSkillOption(view) {
  return {
    id: view.id,
    slug: view.slug,
    name: view.name,
    version: view.version,
    sourceType: view.sourceType,
    sourceProject: view.sourceProject,
    stages: view.stages,
    isBuiltin: view.isBuiltin,
    description: view.description
  }
}

export function documentSkillCandidates(projectId) {
  return all(`SELECT ${SKILL_COLUMNS}
    FROM project_skills ps JOIN skills s ON s.id = ps.skill_id
    WHERE ps.project_id = ?`, projectId)
    .map(row => projectSkillView(row, true))
    .filter(view => view.enabled && view.stages.includes(DOCUMENT_STAGE))
}

export function documentSkillOptions(projectId) {
  return documentSkillCandidates(projectId).map(documentSkillOption)
}

function documentSkillProblem(view) {
  if (!view.bindingEnabled) return '技能已停用'
  if (!view.packageEnabled) return '技能包已停用'
  if (!view.sourceAvailable) return view.sourceReason || '来源不可用'
  if (!view.stages.includes(DOCUMENT_STAGE)) return '该技能未声明说明书环节'
  return ''
}

function isUsableDocumentSkill(view) {
  return view.enabled && view.stages.includes(DOCUMENT_STAGE)
}

export function resolveDocumentSkill({ projectId, bindingId, previousBindingId }) {
  if (bindingId) {
    const row = projectSkillRow(projectId, bindingId)
    if (!row) throw fail('所选说明书技能不存在或不在当前项目', 403, 'SPEC_SKILL_UNAVAILABLE')
    const view = projectSkillView(row, true)
    if (!view.enabled) {
      throw fail(`所选说明书技能不可用：${documentSkillProblem(view)}`, 403, 'SPEC_SKILL_UNAVAILABLE')
    }
    if (!view.stages.includes(DOCUMENT_STAGE)) {
      throw fail('所选技能未声明说明书环节，不能用于文档组装', 400, 'SPEC_SKILL_STAGE_MISMATCH')
    }
    return { view, option: documentSkillOption(view), fallbackFrom: null }
  }

  let previous = null
  if (previousBindingId) {
    const row = projectSkillRow(projectId, previousBindingId)
    if (row) {
      const view = projectSkillView(row, true)
      if (isUsableDocumentSkill(view)) return { view, option: documentSkillOption(view), fallbackFrom: null }
      previous = documentSkillOption(view)
    }
  }

  const candidates = documentSkillCandidates(projectId)
  const builtin = candidates.find(view => view.isBuiltin && view.slug === 'prd-assemble')
  if (builtin) {
    return { view: builtin, option: documentSkillOption(builtin), fallbackFrom: previous }
  }
  if (candidates.length === 1) {
    return { view: candidates[0], option: documentSkillOption(candidates[0]), fallbackFrom: previous }
  }
  const message = candidates.length
    ? '当前项目存在多个可用说明书技能，请先选择要使用的技能'
    : '当前项目没有可用的说明书技能，请先在技能管理中添加并启用将「说明书」环节纳入的技能'
  const err = fail(message, 400, 'SPEC_SKILL_REQUIRED')
  err.details = { candidates: candidates.map(documentSkillOption), previous }
  throw err
}

export function resolveVisualSkill({ projectId, bindingId } = {}) {
  const reasonOf = view => {
    if (!view.bindingEnabled) return '项目绑定已停用'
    if (!view.packageEnabled) return '技能包已停用'
    if (!view.sourceAvailable) return view.sourceReason || '来源不可用'
    return view.stages.length ? '' : '技能未声明适用环节'
  }
  if (bindingId) {
    const row = projectSkillRow(projectId, bindingId)
    if (!row) throw fail('所选图表技能不存在或不在当前项目', 403, 'VISUAL_SKILL_UNAVAILABLE')
    const view = projectSkillView(row, true)
    if (!view.enabled) throw fail(`所选图表技能不可用：${reasonOf(view)}`, 403, 'VISUAL_SKILL_UNAVAILABLE')
    return { view, renderer: view.slug === 'archify' ? 'archify' : 'builtin', fallback: null }
  }
  const candidates = listProjectSkills(projectId).filter(view => {
    if (!view.enabled) return false
    return !view.stages.length || view.stages.includes('analysis') || view.stages.includes('prototype')
  })
  const archify = candidates.find(view => view.slug === 'archify')
  if (archify) return { view: archify, renderer: 'archify', fallback: null }
  const visuals = candidates.find(view => view.slug === 'prd-visuals')
  if (visuals) return { view: visuals, renderer: 'builtin', fallback: { reason: 'archify 技能未绑定或已停用，降级为内置渲染器' } }
  return { view: null, renderer: 'builtin', fallback: { reason: '未绑定图表技能（prd-visuals / archify），降级为内置渲染器' } }
}

function assertSlugAvailable(projectId, slug) {
  const exists = get(`SELECT ps.id FROM project_skills ps JOIN skills s ON s.id = ps.skill_id
    WHERE ps.project_id = ? AND s.slug = ?`, projectId, slug)
  if (exists) throw fail(`当前项目已存在技能「${slug}」，请先移除后再添加`, 409)
}

function safeEntryPath(raw) {
  const value = String(raw || '').replace(/\\/g, '/')
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw fail(`技能包包含非法路径：${raw}`)
  }
  const parts = value.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..')) throw fail(`技能包包含非法路径：${raw}`)
  const normalized = parts.join('/')
  if (!normalized) throw fail(`技能包包含非法路径：${raw}`)
  return normalized
}

function parseManifest(entries) {
  const paths = [...entries.keys()]
  const roots = paths.filter(p => p === 'skill.json')
  const nested = paths.filter(p => p.endsWith('/skill.json') && p.split('/').length === 2)
  const manifestPaths = [...roots, ...nested]
  if (!manifestPaths.length) throw fail('技能包缺少根目录清单文件 skill.json')
  if (manifestPaths.length > 1) throw fail('技能包存在多个 skill.json，无法确定根目录')
  const manifestPath = manifestPaths[0]
  const prefix = manifestPath === 'skill.json' ? '' : manifestPath.slice(0, -'skill.json'.length)
  let manifest
  try {
    manifest = JSON.parse(entries.get(manifestPath).toString('utf8'))
  } catch {
    throw fail('skill.json 不是合法的 JSON')
  }
  if (!manifest || typeof manifest !== 'object') throw fail('skill.json 内容为空或格式不正确')
  const slug = String(manifest.slug || '').trim()
  const name = String(manifest.name || '').trim()
  const version = String(manifest.version || '').trim()
  if (!slug) throw fail('技能清单缺少 slug')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(slug)) throw fail('技能 slug 只允许字母、数字、连字符与下划线，且不超过 64 位')
  if (!name) throw fail('技能清单缺少 name')
  if (!version) throw fail('技能清单缺少 version')
  const stages = normalizeStages(manifest.stages ?? [])

  const relative = new Map()
  for (const [entryPath, buffer] of entries) {
    if (prefix && !entryPath.startsWith(prefix)) continue
    relative.set(entryPath.slice(prefix.length), buffer)
  }
  const readText = file => {
    const buffer = relative.get(file)
    return buffer ? buffer.toString('utf8').trim() : ''
  }
  const readJson = (file, fallback) => {
    const text = readText(file)
    if (!text) return fallback
    try { return JSON.parse(text) } catch { throw fail(`${file} 不是合法的 JSON`) }
  }

  return {
    slug,
    name,
    version,
    description: String(manifest.description || ''),
    stages,
    inputSchema: manifest.inputSchema ?? readJson('input.schema.json', {}),
    outputSchema: manifest.outputSchema ?? readJson('output.schema.json', {}),
    promptTemplate: manifest.promptTemplate || readText('prompt.md'),
    artifactTemplate: manifest.artifactTemplate || readText('artifact.html'),
    validation: manifest.validation ?? readJson('validation.json', {})
  }
}

function collectEntries(rawEntries) {
  if (rawEntries.length > MAX_FILES) throw fail(`技能包文件数量 ${rawEntries.length} 超过上限 ${MAX_FILES}`)
  const entries = new Map()
  let total = 0
  for (const entry of rawEntries) {
    const entryPath = safeEntryPath(entry.path)
    if (entries.has(entryPath)) throw fail(`技能包存在重复文件：${entryPath}`)
    const ext = path.posix.extname(entryPath).toLowerCase()
    if (BLOCKED_EXT.has(ext)) throw fail(`技能包包含可执行或脚本文件：${entryPath}`)
    if (!TEXT_EXT.has(ext)) throw fail(`技能包包含不支持的文件类型：${entryPath}`)
    total += entry.data.length
    if (total > MAX_BYTES) throw fail(`技能包解压后体积超过上限 ${Math.round(MAX_BYTES / 1024 / 1024)} MB`)
    entries.set(entryPath, entry.data)
  }
  if (!entries.size) throw fail('技能包为空')
  return entries
}

async function entriesFromArchive(base64) {
  const raw = String(base64 || '').includes(',') ? String(base64).split(',').pop() : String(base64 || '')
  if (!raw) throw fail('缺少技能压缩包内容')
  let buffer
  try { buffer = Buffer.from(raw, 'base64') } catch { throw fail('技能压缩包内容无法解析') }
  if (!buffer.length) throw fail('技能压缩包为空')
  if (buffer.length > MAX_BYTES) throw fail(`技能压缩包超过上限 ${Math.round(MAX_BYTES / 1024 / 1024)} MB`)
  let zip
  try { zip = await JSZip.loadAsync(buffer) } catch { throw fail('技能压缩包无法解析，请确认是合法的 zip 文件') }
  const files = Object.values(zip.files).filter(file => !file.dir)
  if (files.length > MAX_FILES) throw fail(`技能包文件数量 ${files.length} 超过上限 ${MAX_FILES}`)
  const entries = []
  for (const file of files) {
    const data = await file.async('nodebuffer')
    entries.push({ path: file.name, data })
  }
  return collectEntries(entries)
}

function entriesFromFolder(files) {
  if (!Array.isArray(files) || !files.length) throw fail('缺少技能文件夹内容')
  if (files.length > MAX_FILES) throw fail(`技能包文件数量 ${files.length} 超过上限 ${MAX_FILES}`)
  const entries = files.map(file => {
    const raw = String(file.base64 || '').includes(',') ? String(file.base64).split(',').pop() : String(file.base64 || '')
    if (!raw) throw fail(`文件内容为空：${file.path || '未命名文件'}`)
    return { path: file.path, data: Buffer.from(raw, 'base64') }
  })
  return collectEntries(entries)
}

export async function parseSkillPackage({ archiveBase64, files }) {
  const entries = archiveBase64 ? await entriesFromArchive(archiveBase64) : entriesFromFolder(files)
  return parseManifest(entries)
}

export async function importSkillPackage({ projectId, userId, archiveBase64, files, stages }) {
  const pkg = await parseSkillPackage({ archiveBase64, files })
  const bindingStages = stages === undefined ? pkg.stages : normalizeStages(stages)
  assertSlugAvailable(projectId, pkg.slug)
  return tx(() => {
    let skill = get('SELECT * FROM skills WHERE slug = ? AND version = ?', pkg.slug, pkg.version)
    if (!skill) {
      const id = uid('SK-')
      run(`INSERT INTO skills (id, slug, name, version, description, stage, input_schema_json, output_schema_json,
           prompt_template, artifact_template, validation_json, enabled, is_builtin, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, pkg.slug, pkg.name, pkg.version, pkg.description, pkg.stages[0] || '',
        JSON.stringify(pkg.inputSchema || {}), JSON.stringify(pkg.outputSchema || {}),
        pkg.promptTemplate || '', pkg.artifactTemplate || '', JSON.stringify(pkg.validation || {}),
        1, 0, now())
      skill = get('SELECT * FROM skills WHERE id = ?', id)
    }
    const bindingId = uid('PSK-')
    run(`INSERT INTO project_skills (id, project_id, skill_id, source_type, source_project_id, stages_json, enabled, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      bindingId, projectId, skill.id, 'import', projectId, JSON.stringify(bindingStages), 1, userId, now())
    return projectSkillView(projectSkillRow(projectId, bindingId))
  })
}

export function referenceCandidates(projectId, userId) {
  const bound = new Set(all(`SELECT s.slug FROM project_skills ps JOIN skills s ON s.id = ps.skill_id
    WHERE ps.project_id = ?`, projectId).map(row => row.slug))
  return all(`SELECT ps.id AS source_binding_id, ps.project_id AS source_project_id, ps.source_type,
      ps.stages_json AS source_stages_json,
      s.id AS skill_id, s.slug, s.name, s.version, s.description, s.enabled AS package_enabled
    FROM project_skills ps
    JOIN skills s ON s.id = ps.skill_id
    JOIN projects p ON p.id = ps.project_id
    JOIN project_members m ON m.project_id = ps.project_id AND m.user_id = ?
    WHERE ps.project_id != ? AND ps.enabled = 1 AND s.enabled = 1
      AND ps.source_type IN ('import', 'reference') AND s.is_builtin = 0
    ORDER BY p.name, s.name`, userId, projectId)
    .filter(row => !bound.has(row.slug))
    .filter(row => sourceStatus({
      source_type: row.source_type, source_project_id: row.source_project_id, skill_id: row.skill_id
    }).available)
    .map(row => {
      const project = get('SELECT id, name FROM projects WHERE id = ?', row.source_project_id)
      return {
        sourceBindingId: row.source_binding_id,
        skillId: row.skill_id,
        slug: row.slug,
        name: row.name,
        version: row.version,
        description: row.description,
        stages: parseJson(row.source_stages_json, []),
        sourceProject: project ? { id: project.id, name: project.name } : null
      }
    })
}

export function referenceSkill({ projectId, userId, sourceBindingId, stages }) {
  const source = get(`SELECT ${SKILL_COLUMNS}
    FROM project_skills ps JOIN skills s ON s.id = ps.skill_id
    WHERE ps.id = ?`, sourceBindingId)
  if (!source) throw fail('来源技能不存在', 404)
  if (source.project_id === projectId) throw fail('不能引用当前项目的技能')
  if (source.source_type === 'builtin' || source.is_builtin) throw fail('内置技能无需引用')
  if (!get('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?', source.project_id, userId)) {
    throw fail('无权引用来源项目的技能', 403)
  }
  if (!source.enabled || !source.package_enabled || !sourceStatus(source).available) {
    throw fail('来源技能不可用，请让来源项目启用后再引用', 400)
  }
  assertSlugAvailable(projectId, source.slug)
  const bindingStages = stages === undefined ? parseJson(source.stages_json, []) : normalizeStages(stages)
  const bindingId = uid('PSK-')
  run(`INSERT INTO project_skills (id, project_id, skill_id, source_type, source_project_id, stages_json, enabled, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    bindingId, projectId, source.skill_id, 'reference', source.project_id, JSON.stringify(bindingStages), 1, userId, now())
  return projectSkillView(projectSkillRow(projectId, bindingId))
}

export function updateProjectSkill({ projectId, bindingId, stages, enabled }) {
  const row = projectSkillRow(projectId, bindingId)
  if (!row) throw fail('项目技能不存在', 404)
  const nextStages = stages === undefined ? parseJson(row.stages_json, []) : normalizeStages(stages)
  const nextEnabled = enabled === undefined ? row.enabled : (enabled ? 1 : 0)
  run('UPDATE project_skills SET stages_json = ?, enabled = ? WHERE id = ? AND project_id = ?',
    JSON.stringify(nextStages), nextEnabled, row.id, projectId)
  return projectSkillView(projectSkillRow(projectId, bindingId))
}

export function removeProjectSkill({ projectId, bindingId }) {
  const row = projectSkillRow(projectId, bindingId)
  if (!row) throw fail('项目技能不存在', 404)
  if (row.source_type === 'builtin') throw fail('内置技能不能移除，只能停用', 400)
  run('DELETE FROM project_skills WHERE id = ? AND project_id = ?', row.id, projectId)
  return projectSkillView(row)
}

export function skillPackCoverage(projectId) {
  const packSlugs = new Set(BUILTIN_SKILL_DEFS.map(def => def.slug))
  const skills = BUILTIN_SKILL_DEFS.map(def => {
    const row = get('SELECT * FROM skills WHERE slug = ? AND version = ?', def.slug, def.version)
    const binding = row
      ? get('SELECT * FROM project_skills WHERE project_id = ? AND skill_id = ?', projectId, row.id)
      : null
    const actualStages = binding ? parseJson(binding.stages_json, []) : []
    const issues = []
    if (!row) {
      issues.push({ code: 'not_loaded', message: '技能未注册', action: 'register' })
    } else if (!row.enabled) {
      issues.push({ code: 'package_disabled', message: '技能包已停用', action: 'enable' })
    }
    if (row && !binding) {
      issues.push({ code: 'not_bound', message: '项目未绑定该技能', action: 'bind' })
    }
    if (binding && !binding.enabled) {
      issues.push({ code: 'binding_disabled', message: '项目绑定已停用', action: 'enable' })
    }
    if (binding && !sameStages(actualStages, def.stages)) {
      issues.push({ code: 'stage_mismatch', message: '环节与标准映射不一致', action: 'reset_stages' })
    }
    return {
      slug: def.slug,
      name: def.name,
      version: def.version,
      description: def.description,
      standardStages: def.stages,
      actualStages,
      loaded: Boolean(row),
      packageEnabled: Boolean(row?.enabled),
      bindingId: binding?.id || null,
      bound: Boolean(binding),
      bindingEnabled: Boolean(binding?.enabled),
      compliant: issues.length === 0,
      issues
    }
  })
  const extras = listProjectSkills(projectId)
    .filter(view => !packSlugs.has(view.slug))
    .map(view => ({
      slug: view.slug,
      name: view.name,
      version: view.version,
      sourceType: view.sourceType,
      isBuiltin: view.isBuiltin,
      enabled: view.enabled
    }))
  return {
    pack: { ...BUILTIN_SKILL_PACK },
    loaded: skills.filter(s => s.loaded).length,
    bound: skills.filter(s => s.bound).length,
    compliant: skills.filter(s => s.compliant).length,
    problems: skills.reduce((n, s) => n + s.issues.length, 0),
    skills,
    extras
  }
}

export function repairSkillPack({ projectId, resetStages = false }) {
  const changes = []
  ensureBuiltinSkills()
  migrateSpecAssembleBindings()
  for (const def of BUILTIN_SKILL_DEFS) {
    const row = get('SELECT * FROM skills WHERE slug = ? AND version = ?', def.slug, def.version)
    if (!row) continue
    const binding = get('SELECT * FROM project_skills WHERE project_id = ? AND skill_id = ?', projectId, row.id)
    if (!binding) {
      run(`INSERT INTO project_skills (id, project_id, skill_id, source_type, source_project_id, stages_json, enabled, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        uid('PSK-'), projectId, row.id, 'builtin', projectId, JSON.stringify(def.stages), 1, 'system', now())
      changes.push({ slug: def.slug, action: 'bind', before: null, after: def.stages })
      continue
    }
    const before = parseJson(binding.stages_json, [])
    const patch = {}
    if (!binding.enabled) patch.enabled = 1
    if (resetStages && !sameStages(before, def.stages)) patch.stages = def.stages
    if (!Object.keys(patch).length) continue
    run('UPDATE project_skills SET stages_json = ?, enabled = ? WHERE id = ?',
      JSON.stringify(patch.stages || before), patch.enabled ?? binding.enabled, binding.id)
    changes.push({
      slug: def.slug,
      action: patch.stages ? 'reset_stages' : 'enable',
      before: { stages: before, enabled: Boolean(binding.enabled) },
      after: { stages: patch.stages || before, enabled: Boolean(patch.enabled ?? binding.enabled) }
    })
  }
  return { changed: changes.length, changes, coverage: skillPackCoverage(projectId) }
}
