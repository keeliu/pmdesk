import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
fs.mkdirSync(dataDir, { recursive: true })

export const db = new DatabaseSync(process.env.WORKBENCH_DB || path.join(dataDir, 'workbench.db'))

db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT,
  role TEXT NOT NULL,
  avatar TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  background TEXT,
  goals_json TEXT,
  owner_org TEXT,
  owner_id TEXT,
  system_scope_json TEXT,
  enterprise_scope_json TEXT,
  conventions_json TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS iterations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  goal TEXT,
  start_date TEXT,
  end_date TEXT,
  capacity_days REAL DEFAULT 0,
  status TEXT DEFAULT 'planning',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  code TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  origin_type TEXT,
  source_json TEXT,
  clarification_json TEXT,
  involved_apps_json TEXT,
  snapshot_json TEXT,
  iteration_id TEXT,
  owner_id TEXT,
  priority_json TEXT,
  confirmed_at TEXT,
  confirmed_by TEXT,
  reject_reason TEXT,
  reject_count INTEGER DEFAULT 0,
  merged_into TEXT,
  discard_reason TEXT,
  suspended_from TEXT,
  stall_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirement_versions (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  analysis_json TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prototypes (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  pages_json TEXT,
  status TEXT DEFAULT 'draft',
  analysis_version INTEGER,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS specs (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  markdown TEXT,
  html TEXT,
  analysis_version INTEGER,
  prototype_version INTEGER,
  status TEXT DEFAULT 'draft',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS flowcharts (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  analysis_version INTEGER NOT NULL,
  renderer TEXT NOT NULL,
  skill_binding_id TEXT,
  skill_slug TEXT,
  skill_version TEXT,
  source_json TEXT,
  html TEXT NOT NULL,
  html_size INTEGER,
  html_sha256 TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (requirement_id, analysis_version)
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  reviewers_json TEXT,
  deadline TEXT,
  status TEXT NOT NULL,
  conclusion TEXT,
  summary TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  section TEXT,
  quote TEXT,
  content TEXT,
  author_id TEXT,
  stale INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  expected TEXT,
  status TEXT NOT NULL,
  annotation_ids_json TEXT,
  resolution_version INTEGER,
  resolution_note TEXT,
  reject_reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  reason TEXT,
  content TEXT,
  grade TEXT,
  impact_json TEXT,
  handling TEXT,
  status TEXT,
  before_spec TEXT,
  after_spec TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  requirement_id TEXT,
  type TEXT NOT NULL,
  message TEXT,
  payload_json TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  type TEXT,
  title TEXT,
  body TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  proposal_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT,
  diff_json TEXT,
  status TEXT DEFAULT 'pending',
  created_by TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  stage TEXT,
  input_schema_json TEXT,
  output_schema_json TEXT,
  prompt_template TEXT,
  artifact_template TEXT,
  validation_json TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (slug, version)
);
CREATE TABLE IF NOT EXISTS project_skills (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_project_id TEXT,
  stages_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, skill_id)
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  requirement_id TEXT,
  skill_slug TEXT,
  provider TEXT,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  status TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  project_id TEXT,
  object_type TEXT,
  object_id TEXT,
  expires_at TEXT,
  created_by TEXT,
  revoked INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  user_id TEXT,
  type TEXT,
  format TEXT,
  scope_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS counters (
  scope TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  from_req TEXT NOT NULL,
  to_req TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS similarity_ignores (
  requirement_id TEXT NOT NULL,
  similar_id TEXT NOT NULL,
  project_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (requirement_id, similar_id)
);
CREATE TABLE IF NOT EXISTS iteration_specs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  iteration_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  mode TEXT DEFAULT 'draft',
  status TEXT DEFAULT 'draft',
  html TEXT,
  markdown TEXT,
  source_json TEXT,
  requirement_count INTEGER DEFAULT 0,
  missing_json TEXT,
  stale INTEGER DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS batch_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  iteration_id TEXT,
  target_status TEXT NOT NULL,
  effective_at TEXT,
  scope_json TEXT,
  success_json TEXT,
  failed_json TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  proposal_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT,
  diff_json TEXT,
  status TEXT DEFAULT 'pending',
  created_by TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_req_project ON requirements(project_id, status);
CREATE INDEX IF NOT EXISTS idx_events_req ON events(requirement_id, created_at);
CREATE INDEX IF NOT EXISTS idx_versions_req ON requirement_versions(requirement_id, version);
CREATE INDEX IF NOT EXISTS idx_proto_req ON prototypes(requirement_id, version);
CREATE INDEX IF NOT EXISTS idx_spec_req ON specs(requirement_id, version);
CREATE INDEX IF NOT EXISTS idx_sugg_review ON suggestions(review_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_req ON chat_messages(requirement_id, created_at);
CREATE INDEX IF NOT EXISTS idx_project_skills_project ON project_skills(project_id);
CREATE INDEX IF NOT EXISTS idx_project_skills_skill ON project_skills(skill_id);
`)

try { db.exec('ALTER TABLE suggestions ADD COLUMN annotation_ids_json TEXT') } catch { /* 已存在 */ }
for (const ddl of [
  'ALTER TABLE requirements ADD COLUMN requester_json TEXT',
  'ALTER TABLE requirements ADD COLUMN milestones_json TEXT',
  'ALTER TABLE requirements ADD COLUMN description TEXT',
  'ALTER TABLE requirements ADD COLUMN leads_json TEXT',
  'ALTER TABLE iterations ADD COLUMN code TEXT',
  'ALTER TABLE events ADD COLUMN effective_at TEXT',
  'ALTER TABLE events ADD COLUMN batch_id TEXT',
  'ALTER TABLE project_messages ADD COLUMN created_by TEXT',
  'ALTER TABLE skills ADD COLUMN is_builtin INTEGER DEFAULT 1',
  'ALTER TABLE llm_calls ADD COLUMN stage TEXT',
  'ALTER TABLE llm_calls ADD COLUMN trigger_type TEXT',
  'ALTER TABLE iteration_specs ADD COLUMN skill_binding_id TEXT',
  'ALTER TABLE iteration_specs ADD COLUMN skill_slug TEXT',
  'ALTER TABLE iteration_specs ADD COLUMN skill_version TEXT',
  'ALTER TABLE iteration_specs ADD COLUMN template_hash TEXT',
  'ALTER TABLE iteration_specs ADD COLUMN docx_file TEXT',
  'ALTER TABLE iteration_specs ADD COLUMN docx_size INTEGER',
  'ALTER TABLE iteration_specs ADD COLUMN docx_sha256 TEXT',
  'ALTER TABLE prototypes ADD COLUMN updated_at TEXT',
  'ALTER TABLE specs ADD COLUMN updated_at TEXT',
  'ALTER TABLE iteration_specs ADD COLUMN updated_at TEXT',
  'ALTER TABLE batch_operations ADD COLUMN kind TEXT',
  'ALTER TABLE batch_operations ADD COLUMN changes_json TEXT',
  'ALTER TABLE specs ADD COLUMN skill_binding_id TEXT',
  'ALTER TABLE specs ADD COLUMN skill_slug TEXT',
  'ALTER TABLE specs ADD COLUMN skill_version TEXT',
  'ALTER TABLE specs ADD COLUMN template_hash TEXT'
]) {
  try { db.exec(ddl) } catch { /* 已存在 */ }
}

db.exec(`
UPDATE prototypes SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE specs SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE iteration_specs SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE batch_operations SET kind = 'status' WHERE kind IS NULL OR kind = '';
`)

export const now = () => new Date().toISOString()
export const uid = (prefix = '') => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 20)

export function get(sql, ...params) {
  return db.prepare(sql).get(...params)
}
export function all(sql, ...params) {
  return db.prepare(sql).all(...params)
}
export function run(sql, ...params) {
  return db.prepare(sql).run(...params)
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function parseJson(value, fallback = null) {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

export function nextCounter(scope) {
  const row = get('SELECT value FROM counters WHERE scope = ?', scope)
  const value = (row?.value || 0) + 1
  if (row) run('UPDATE counters SET value = ? WHERE scope = ?', value, scope)
  else run('INSERT INTO counters (scope, value) VALUES (?, ?)', scope, value)
  return value
}

export function logEvent({ projectId, requirementId, type, message, payload, actorId, effectiveAt, batchId }) {
  run(
    'INSERT INTO events (id, project_id, requirement_id, type, message, payload_json, actor_id, effective_at, batch_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    uid('EV-'), projectId || null, requirementId || null, type, message || '', JSON.stringify(payload || {}),
    actorId || null, effectiveAt || null, batchId || null, now()
  )
}

export function audit({ projectId, userId, action, objectType, objectId, before, after, ip }) {
  run(
    'INSERT INTO audits (id, project_id, user_id, action, object_type, object_id, before_json, after_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    uid('AUD-'), projectId || null, userId || null, action, objectType || '', objectId || '',
    JSON.stringify(before ?? null), JSON.stringify(after ?? null), ip || '', now()
  )
}

export function notify({ userId, projectId, type, title, body }) {
  run('INSERT INTO notifications (id, user_id, project_id, type, title, body, read, created_at) VALUES (?,?,?,?,?,?,0,?)',
    uid('NTF-'), userId, projectId || null, type || 'info', title, body || '', now())
}
