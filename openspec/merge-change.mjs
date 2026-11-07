// 一次性合并脚本：把变更增量（MODIFIED 按标题替换 / ADDED 追加）合入 openspec/specs 基线
import fs from 'node:fs'
import path from 'node:path'

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const changeDir = process.argv[2]
if (!changeDir) { console.error('usage: node merge-change.mjs <change-dir>'); process.exit(1) }

function splitRequirements(text) {
  // 返回 { header, blocks: [{ title, body }] }，按 "### Requirement: " 切分；统一 LF 以兼容 CRLF 基线
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const header = []
  const blocks = []
  let current = null
  for (const line of lines) {
    const m = line.match(/^### Requirement: (.+)$/)
    if (m) {
      if (current) blocks.push(current)
      current = { title: m[1].trim(), body: [line] }
    } else if (current) {
      current.body.push(line)
    } else {
      header.push(line)
    }
  }
  if (current) blocks.push(current)
  return { header: header.join('\n').trimEnd(), blocks }
}

function section(text, name) {
  // 提取 "## <name>" 到下一个 "## " 之间的内容
  const re = new RegExp(`^## ${name}\\s*$`, 'm')
  const start = text.match(re)
  if (!start) return ''
  const rest = text.slice(start.index + start[0].length)
  const next = rest.search(/^## /m)
  return next < 0 ? rest : rest.slice(0, next)
}

const deltaDir = path.join(root, 'changes', changeDir, 'specs')
const files = fs.readdirSync(deltaDir).filter(f => f.endsWith('.spec.md'))
for (const file of files) {
  const capability = file.replace(/\.spec\.md$/, '')
  const delta = fs.readFileSync(path.join(deltaDir, file), 'utf8')
  const baselinePath = path.join(root, 'specs', capability, 'spec.md')
  if (!fs.existsSync(baselinePath)) { console.error(`缺少基线 ${baselinePath}`); process.exit(1) }
  let baseline = fs.readFileSync(baselinePath, 'utf8')
  const base = splitRequirements(baseline)

  const modified = splitRequirements(section(delta, 'MODIFIED Requirements'))
  const added = splitRequirements(section(delta, 'ADDED Requirements'))

  const replaced = new Set()
  let blocks = base.blocks.map(b => {
    const m = modified.blocks.find(x => x.title === b.title)
    if (m) { replaced.add(m.title); return { title: m.title, body: m.body } }
    return b
  })
  for (const m of modified.blocks) {
    if (!replaced.has(m.title)) { console.error(`MODIFIED 在基线中未找到：${capability} / ${m.title}`); process.exit(1) }
  }
  const existingTitles = new Set(blocks.map(b => b.title))
  const newOnes = added.blocks.filter(a => {
    if (existingTitles.has(a.title)) { console.log(`  跳过已存在的 ADDED：${a.title}`); return false }
    return true
  })
  blocks = blocks.concat(newOnes)

  const out = [base.header, '', ...blocks.flatMap(b => [b.body.join('\n').trimEnd(), ''])].join('\n').trimEnd() + '\n'
  fs.writeFileSync(baselinePath, out)
  console.log(`${capability}: 替换 ${replaced.size} 条，新增 ${added.blocks.length} 条`)
}
