import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { all, get } from './db.mjs'
import { authMiddleware, requireUser, signSession, publicUser, parseCookies, verifySession } from './core.mjs'
import { projectsRouter } from './routes/projects.mjs'
import { requirementsRouter } from './routes/requirements.mjs'
import { analysisRouter } from './routes/analysis.mjs'
import { prototypesRouter } from './routes/prototypes.mjs'
import { specsRouter } from './routes/specs.mjs'
import { reviewsRouter } from './routes/reviews.mjs'
import { changesRouter } from './routes/changes.mjs'
import { planningRouter } from './routes/planning.mjs'
import { aiRouter } from './routes/ai.mjs'
import { trackingRouter } from './routes/tracking.mjs'
import { adminRouter, publicRouter } from './routes/admin.mjs'
import { ensureBuiltinBindings, ensureBuiltinSkills, migrateSpecAssembleBindings } from './services/skills.mjs'
import { migrateStatuses } from './services/status-migration.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = Number(process.env.PORT || 4310)

try {
  ensureBuiltinSkills()
  migrateSpecAssembleBindings()
  ensureBuiltinBindings()
} catch (e) { console.error('内置技能初始化失败：', e.message) }
try {
  const migrated = migrateStatuses()
  if (!migrated.ok) {
    console.error('状态迁移中止：存在未知状态', migrated.unknown.slice(0, 20))
  } else if (migrated.migrated) {
    console.log(`状态迁移完成：${migrated.migrated} 条，批次 ${migrated.batchId}`)
  }
} catch (e) { console.error('状态迁移失败：', e.message) }

app.disable('x-powered-by')
app.use(express.json({ limit: '48mb' }))
app.use(authMiddleware)

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }))

app.get('/api/session', (req, res) => {
  const demoUsers = all('SELECT * FROM users ORDER BY role, name')
  res.json({
    user: req.user ? publicUser(req.user) : null,
    demoUsers: demoUsers.map(u => ({ ...publicUser(u), role: u.role })),
    roles: ['pm', 'reviewer', 'developer', 'admin']
  })
})

app.post('/api/session', (req, res) => {
  const userId = req.body?.userId
  const user = get('SELECT * FROM users WHERE id = ?', userId)
  if (!user) return res.status(400).json({ error: '演示账号不存在' })
  const token = signSession(user.id)
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`)
  res.json({ user: publicUser(user) })
})

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  res.json({ ok: true })
})

app.get('/api/users', requireUser, (req, res) => {
  res.json(all('SELECT id, name, title, role FROM users ORDER BY role, name'))
})

app.use('/api/public', publicRouter)

app.use('/api', requireUser)
app.use('/api/projects', projectsRouter)
app.use('/api', requirementsRouter)
app.use('/api', analysisRouter)
app.use('/api', prototypesRouter)
app.use('/api', specsRouter)
app.use('/api', reviewsRouter)
app.use('/api', changesRouter)
app.use('/api', planningRouter)
app.use('/api', aiRouter)
app.use('/api', trackingRouter)
app.use('/api', adminRouter)

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }))

const dist = path.join(__dirname, '..', 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.use((err, req, res, next) => {
  const status = err.statusCode || (err.type === 'entity.too.large' ? 413 : 500)
  if (status >= 500) console.error(err)
  const payload = { error: err.message || '服务异常', details: err.details || null }
  if (err.code) payload.code = err.code
  res.status(status).json(payload)
})

app.listen(PORT, () => {
  console.log(`需求管理工作台 API 已启动：http://localhost:${PORT}`)
})
