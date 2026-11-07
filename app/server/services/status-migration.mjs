import { all, get, run, uid, now, tx } from '../db.mjs'
import { STATES, LEGACY_STATUS_MAP } from '../core.mjs'

export function migrateStatuses() {
  const known = new Set([...STATES, ...Object.keys(LEGACY_STATUS_MAP)])
  const rows = all('SELECT id, project_id, status, suspended_from FROM requirements')
  const unknown = []
  for (const row of rows) {
    if (!known.has(row.status)) unknown.push({ id: row.id, status: row.status })
    if (row.suspended_from && !known.has(row.suspended_from)) {
      unknown.push({ id: row.id, status: `挂起前：${row.suspended_from}` })
    }
  }
  if (unknown.length) {
    return { ok: false, migrated: 0, batchId: null, unknown }
  }
  const pending = rows.filter(row =>
    LEGACY_STATUS_MAP[row.status] || (row.suspended_from && LEGACY_STATUS_MAP[row.suspended_from])
  )
  if (!pending.length) return { ok: true, migrated: 0, batchId: null, unknown: [] }

  const batchId = uid('MIG-')
  const at = now()
  tx(() => {
    for (const row of pending) {
      const next = LEGACY_STATUS_MAP[row.status] || row.status
      const nextSuspended = row.suspended_from
        ? (LEGACY_STATUS_MAP[row.suspended_from] || row.suspended_from)
        : null
      run('UPDATE requirements SET status = ?, suspended_from = ?, stall_since = ?, updated_at = ? WHERE id = ?',
        next, nextSuspended, at, at, row.id)
      run(`INSERT INTO events (id, project_id, requirement_id, type, message, payload_json, actor_id, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        uid('EV-'), row.project_id, row.id, 'status-migration',
        `状态迁移：${row.status} → ${next}`,
        JSON.stringify({
          batchId, at, actor: 'system',
          from: row.status, to: next,
          suspendedFrom: row.suspended_from, suspendedTo: nextSuspended
        }),
        null, at)
      run(`INSERT INTO audits (id, project_id, user_id, action, object_type, object_id, before_json, after_json, ip, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        uid('AUD-'), row.project_id, null, 'requirement.status-migration', 'requirement', row.id,
        JSON.stringify({ status: row.status, suspendedFrom: row.suspended_from }),
        JSON.stringify({ status: next, suspendedFrom: nextSuspended, batchId }),
        '', at)
    }
  })
  return { ok: true, migrated: pending.length, batchId, unknown: [] }
}
