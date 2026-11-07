import React, { useState } from 'react'
import { fmtDay, get, navigate, patch, post } from '../api'
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader, Progress, Tag, useAsync, useToast } from '../ui'

const STATUS_LABEL: Record<string, string> = { planning: '规划中', active: '进行中', released: '已发布' }

export default function Iterations({ projectId, projectRole }: any) {
  const toast = useToast()
  const { data, loading, error, reload } = useAsync<any[]>(() => get(`/api/projects/${projectId}/iterations`), [projectId])
  const [editing, setEditing] = useState<any>(null)
  const [busy, setBusy] = useState('')
  const canManage = ['pm', 'admin'].includes(projectRole)

  const release = async (it: any) => {
    setBusy(it.id)
    try {
      await post(`/api/iterations/${it.id}/release`, {})
      toast.push(`迭代「${it.name}」已发布`, 'success')
      await reload()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const start = async (it: any) => {
    setBusy(it.id)
    try {
      await patch(`/api/projects/${projectId}/iterations/${it.id}`, { status: 'active' })
      toast.push('迭代已开始', 'success')
      await reload()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  return (
    <>
      <PageHeader title="迭代" desc="迭代承载规划与容量。已发布迭代不可再排入需求；发布前要求迭代内需求全部上线。"
        actions={canManage && <button className="btn primary" onClick={() => setEditing({ name: '', goal: '', startDate: '', endDate: '', capacityDays: 20, status: 'planning' })}>＋ 新建迭代</button>} />

      {loading && <Loading />}
      {error && <ErrorBox message={error} onRetry={reload} />}
      {data && !data.length && <div className="card"><Empty title="还没有迭代" desc="创建迭代后，在规划页把需求拖入迭代并检查容量。" icon="○"
        action={canManage && <button className="btn primary mt8" onClick={() => setEditing({ name: '', goal: '', startDate: '', endDate: '', capacityDays: 20, status: 'planning' })}>创建迭代</button>} /></div>}

      <div className="grid c2">
        {data?.map(it => (
          <div key={it.id} className="card">
            <div className="card-head">
              <div>
                <h3>{it.name} <Tag tone={it.status === 'active' ? 'teal' : it.status === 'released' ? 'green' : 'gray'}>{STATUS_LABEL[it.status] || it.status}</Tag></h3>
                <p>{it.goal || '未填写迭代目标'}</p>
              </div>
              <span className="muted small nowrap">{fmtDay(it.start_date)} ~ {fmtDay(it.end_date)}</span>
            </div>
            <div className="card-body stack">
              <div>
                <div className="row between small mb8">
                  <span className="muted">容量占用</span>
                  <span className={it.usedDays > it.capacity_days ? 'danger-text' : ''}>{it.usedDays} / {it.capacity_days || '—'} 人日</span>
                </div>
                <Progress value={it.capacity_days ? Math.min(100, it.usedDays / it.capacity_days * 100) : 0} tone={it.usedDays > it.capacity_days ? 'orange' : 'indigo'} />
              </div>
              <div className="row between">
                <div className="row"><Tag tone="blue">{it.requirementCount} 条需求</Tag><span className="muted small">交付进度 {it.progress}%</span></div>
                <div className="row">
                  {it.status === 'planning' && canManage && <button className="btn sm" disabled={busy === it.id} onClick={() => start(it)}>开始迭代</button>}
                  {canManage && it.status !== 'released' && <button className="btn sm" onClick={() => setEditing(it)}>编辑</button>}
                  {canManage && it.status !== 'released' && <button className="btn sm" disabled={busy === it.id} onClick={() => release(it)}>发布</button>}
                  <button className="btn sm" onClick={() => navigate(`/p/${projectId}/planning`)}>规划</button>
                  <button className="btn sm primary" onClick={() => navigate(`/p/${projectId}/iterations/${it.id}`)}>迭代详情</button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing && <IterationModal projectId={projectId} value={editing} onClose={() => setEditing(null)}
        onSaved={async () => { setEditing(null); await reload() }} />}
    </>
  )
}

function IterationModal({ projectId, value, onClose, onSaved }: any) {
  const toast = useToast()
  const [form, setForm] = useState<any>({
    name: value.name || '', goal: value.goal || '', startDate: value.startDate || value.start_date || '',
    endDate: value.endDate || value.end_date || '', capacityDays: value.capacityDays ?? value.capacity_days ?? 20,
    status: value.status || 'planning'
  })
  const [busy, setBusy] = useState(false)
  const isNew = !value.id
  const save = async () => {
    if (!form.name.trim()) { toast.push('请填写迭代名称', 'warn'); return }
    setBusy(true)
    try {
      if (isNew) await post(`/api/projects/${projectId}/iterations`, form)
      else await patch(`/api/projects/${projectId}/iterations/${value.id}`, form)
      toast.push(isNew ? '迭代已创建' : '迭代已更新', 'success')
      await onSaved()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy(false) }
  }
  return (
    <Modal title={isNew ? '新建迭代' : '编辑迭代'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={save}>保存</button></>}>
      <div className="form-grid">
        <div className="wide"><Field label="迭代名称" required><input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例如：2026 Q4 第一期" /></Field></div>
        <div className="wide"><Field label="迭代目标"><textarea value={form.goal} onChange={e => setForm({ ...form, goal: e.target.value })} /></Field></div>
        <Field label="开始日期"><input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></Field>
        <Field label="结束日期"><input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} /></Field>
        <Field label="容量（人日）"><input type="number" min={0} value={form.capacityDays} onChange={e => setForm({ ...form, capacityDays: Number(e.target.value) })} /></Field>
        <Field label="状态"><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
          <option value="planning">规划中</option><option value="active">进行中</option>
          {value.status === 'released' && <option value="released">已发布</option>}
        </select></Field>
      </div>
    </Modal>
  )
}
