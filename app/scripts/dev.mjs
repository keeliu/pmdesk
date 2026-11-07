import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const children = []

function start(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
  children.push(child)
  child.on('exit', code => {
    if (code && code !== 0) console.error(`[${name}] 退出，代码 ${code}`)
    shutdown(code || 0)
  })
}

let stopping = false
function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  for (const c of children) { try { c.kill() } catch { /* 已退出 */ } }
  setTimeout(() => process.exit(code), 150)
}

process.on('SIGINT', () => shutdown())
process.on('SIGTERM', () => shutdown())

start('api', process.execPath, ['--watch', 'server/index.mjs'], { PORT: process.env.PORT || '4310' })
start('web', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')])
