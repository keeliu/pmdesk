import React, { useEffect, useState } from 'react'
import { fmtTime, get, post } from '../../api'
import { Empty, ErrorBox, Field, Loading, Modal, Tag, useAsync, useToast } from '../../ui'
import { STATUS_INDEX } from '../../status'

type Props = { reqId: string; detail: any; onRefresh: () => Promise<void> }

const SECTIONS = ['全文', '需求描述', '业务流程说明', '功能设计', '集成说明']
const SG_TONE: Record<string, string> = {
  '待处理': 'amber', '处理中': 'orange', '不采纳待确认': 'red', '已消除': 'green',
  '已关闭': 'slate', '已合并': 'violet', '已重新评审': 'blue'
}

export default function ReviewPanel({ reqId, detail, onRefresh }: Props) {
  const toast = useToast()
  const reviews = useAsync<any[]>(() => get(`/api/requirements/${reqId}/reviews`), [reqId, detail.updated_at])
  const specs = useAsync<any[]>(() => get(`/api/requirements/${reqId}/specs`), [reqId, detail.updated_at])
  const members = useAsync<any[]>(() => get(`/api/projects/${detail.project.id}/members`), [detail.project.id])
  const [openReviewId, setOpenReviewId] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [reviewerIds, setReviewerIds] = useState<string[]>([])
  const [deadline, setDeadline] = useState('')
  const [annotation, setAnnotation] = useState({ section: '全文', quote: '', content: '', expected: '' })
  const [rejectFor, setRejectFor] = useState<any>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [closeFor, setCloseFor] = useState<any>(null)
  const [closeForm, setCloseForm] = useState({ version: '', note: '' })
  const [concludeOpen, setConcludeOpen] = useState(false)
  const [conclusion, setConclusion] = useState({ conclusion: '通过', summary: '' })
  const [busy, setBusy] = useState('')

  const list = reviews.data || []
  const review = list.find(r => r.id === openReviewId) || list[0]
  const specList = specs.data || []
  const newerSpecs = review ? specList.filter(s => s.version > (review.spec?.version || 0)) : []

  useEffect(() => {
    if (review && !openReviewId) setOpenReviewId(review.id)
  }, [review?.id])

  const refresh = async () => {
    await onRefresh()
    await reviews.reload()
    await specs.reload()
  }

  const reviewerChoices = (members.data || []).filter(m => ['reviewer', 'pm', 'admin'].includes(m.project_role || m.role))

  const toggleReviewer = (id: string) => {
    setReviewerIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
  }

  const createReview = async () => {
    if (reviewerIds.length < 2) { toast.push('评审人不得少于两人', 'warn'); return }
    setBusy('create')
    try {
      const r = await post<any>(`/api/requirements/${reqId}/reviews`, { reviewerIds, deadline })
      toast.push(`已发起第 ${r.round} 轮评审`, 'success')
      setCreateOpen(false); setReviewerIds([]); setDeadline('')
      await refresh()
      setOpenReviewId(r.id)
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const startReview = async () => {
    if (!review) return
    setBusy('start')
    try {
      await post(`/api/reviews/${review.id}/start`, {})
      toast.push('评审已开始', 'success')
      await refresh()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const addAnnotation = async () => {
    if (!review || !annotation.content.trim()) { toast.push('批注内容不能为空', 'warn'); return }
    setBusy('annotation')
    try {
      await post(`/api/reviews/${review.id}/annotations`, annotation)
      toast.push('批注已记录，并汇总为改进建议', 'success')
      setAnnotation({ section: '全文', quote: '', content: '', expected: '' })
      await refresh()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const suggestAction = async (s: any, action: string, body: any = {}) => {
    setBusy(s.id + action)
    try {
      await post(`/api/suggestions/${s.id}/${action}`, body)
      const label: Record<string, string> = { start: '已开始处理', reject: '已标记不采纳，等待评审人确认', 'confirm-reject': '已确认关闭', reopen: '已重新打开' }
      toast.push(label[action] || '操作成功', 'success')
      if (action === 'reject') { setRejectFor(null); setRejectReason('') }
      await refresh()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const generateSpec = async () => {
    setBusy('spec')
    try {
      const r = await post<any>(`/api/requirements/${reqId}/specs/generate`, {})
      toast.push(`已生成说明书 V${r.version}（${r.skill?.slug ? `${r.skill.slug}@${r.skill.version}` : '内置渲染'}），可关联关闭建议`, 'success')
      await refresh()
      setCloseForm(f => ({ ...f, version: String(r.version) }))
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const closeSuggestion = async () => {
    if (!closeFor) return
    setBusy('close')
    try {
      const r = await post<any>(`/api/suggestions/${closeFor.id}/close`, { version: Number(closeForm.version), note: closeForm.note })
      toast.push(`建议已关联说明书 V${r.version} 关闭`, 'success')
      setCloseFor(null); setCloseForm({ version: '', note: '' })
      await refresh()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const conclude = async () => {
    if (!review) return
    setBusy('conclude')
    try {
      await post(`/api/reviews/${review.id}/conclude`, conclusion)
      toast.push(`已登记评审结论：${conclusion.conclusion}`, 'success')
      setConcludeOpen(false); setConclusion({ conclusion: '通过', summary: '' })
      await refresh()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  if (reviews.loading && !reviews.data) return <Loading label="加载评审…" />
  if (reviews.error) return <ErrorBox message={reviews.error} onRetry={reviews.reload} />

  const openCount = (review?.suggestions || []).filter((s: any) => ['待处理', '处理中', '不采纳待确认'].includes(s.status)).length
  const canCreate = ['需求分析中', '需求评审中'].includes(detail.status) && specList.some(s => s.status === 'published')

  return (
    <div className="stack">
      <div className="card">
        <div className="card-body row wrap" style={{ justifyContent: 'space-between' }}>
          <div className="row wrap">
            {list.length > 1 ? (
              <select style={{ width: 200 }} value={review?.id} onChange={e => setOpenReviewId(e.target.value)}>
                {list.map(r => <option key={r.id} value={r.id}>第 {r.round} 轮 · {r.status}</option>)}
              </select>
            ) : <strong>{review ? `第 ${review.round} 轮评审` : '尚未发起评审'}</strong>}
            {review && <Tag tone={review.status === '已完成' ? 'green' : review.status === '进行中' ? 'orange' : 'gray'}>{review.status}</Tag>}
            {review?.conclusion && <Tag tone={review.conclusion === '通过' ? 'green' : 'red'}>{review.conclusion}</Tag>}
            {review?.deadline && <span className="tiny muted">截止 {review.deadline}</span>}
          </div>
          <div className="row">
            {review && review.status === '待开始' && <button className="btn sm" disabled={busy !== ''} onClick={startReview}>开始评审</button>}
            {review && review.status === '进行中' && <button className="btn sm primary" onClick={() => setConcludeOpen(true)}>登记结论</button>}
            <button className="btn sm" disabled={!canCreate} onClick={() => setCreateOpen(true)}>发起新一轮</button>
          </div>
        </div>
      </div>

      {!review ? (
        <Empty icon="◇" title="还没有评审记录"
          desc="发起评审需要已发布说明书，且评审人不少于两人。评审意见会汇总为改进建议，产品经理逐条闭环后才能进入开发。"
          action={<button className="btn primary" disabled={!canCreate} onClick={() => setCreateOpen(true)}>发起评审</button>} />
      ) : (
        <>
          <div className="card">
            <div className="card-body stack">
              <div className="review-meta">
                <span className="tiny muted">评审版本：说明书 V{review.spec?.version ?? '—'}</span>
                <span className="tiny muted">评审人：{(review.reviewerNames || []).join('、') || '—'}</span>
                <span className="tiny muted">发起于 {fmtTime(review.created_at)}</span>
              </div>
              {review.summary && <div className={`notice ${review.conclusion === '不通过' ? '' : 'info'}`}>结论摘要：{review.summary}</div>}
              {review.status === '已完成' && review.conclusion === '通过' && openCount === 0 && (
                <div className="notice info">{(STATUS_INDEX[detail.status] ?? -1) >= STATUS_INDEX['开发中'] || detail.status === '已关闭'
                  ? '评审已通过且建议全部闭环，需求已进入开发流程。'
                  : '评审已通过且建议全部闭环，可在右上角通过「状态推进」进入开发中。'}</div>
              )}
            </div>
          </div>

          {review.status !== '已完成' && (
            <div className="analysis-section">
              <header><h4>添加批注</h4><span>批注自动汇总为改进建议</span></header>
              <div className="body">
                <div className="mini-form">
                  <div className="row">
                    <select value={annotation.section} onChange={e => setAnnotation(a => ({ ...a, section: e.target.value }))}>
                      {SECTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <Field label="引用原文" hint="可选">
                    <input type="text" value={annotation.quote} onChange={e => setAnnotation(a => ({ ...a, quote: e.target.value }))} placeholder="粘贴要评论的原文片段" />
                  </Field>
                  <Field label="批注意见" required>
                    <textarea value={annotation.content} onChange={e => setAnnotation(a => ({ ...a, content: e.target.value }))} placeholder="例如：异常分支缺少提示口径，建议补充" style={{ minHeight: 62 }} />
                  </Field>
                  <Field label="期望处理方式" hint="可选">
                    <input type="text" value={annotation.expected} onChange={e => setAnnotation(a => ({ ...a, expected: e.target.value }))} placeholder="默认：按批注意见修改并重新发布说明书" />
                  </Field>
                  <div className="row end">
                    <button className="btn primary sm" disabled={busy !== ''} onClick={addAnnotation}>提交批注</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="section-block">
            <h4>改进建议 <span className="tag tone-amber">{openCount} 条待闭环</span></h4>
            <div className="inner">
              {(review.suggestions || []).length === 0 && <p className="muted small">本轮暂无建议。评审人通过批注提出意见后会自动生成建议。</p>}
              {(review.suggestions || []).map((s: any) => (
                <div key={s.id} className={`suggestion-item ${['已消除', '已关闭', '已合并'].includes(s.status) ? 'closed' : ''}`}>
                  <div className="sg-head">
                    <div>
                      <div className="sg-title">#{s.seq} {s.title}</div>
                      <div className="row wrap mt8"><Tag tone={SG_TONE[s.status] || 'gray'}>{s.status}</Tag>
                        {s.resolution_version && <span className="tiny muted">关联说明书 V{s.resolution_version}</span>}
                      </div>
                    </div>
                    <span className="tiny muted nowrap">{fmtTime(s.created_at)}</span>
                  </div>
                  <div className="sg-detail">{s.detail}</div>
                  {s.reject_reason && <div className="err-text mt8">不采纳理由：{s.reject_reason}</div>}
                  <div className="sg-actions">
                    {s.status === '待处理' && <button className="btn sm" disabled={busy !== ''} onClick={() => suggestAction(s, 'start')}>开始处理</button>}
                    {['待处理', '处理中'].includes(s.status) && (
                      <button className="btn sm primary" onClick={() => {
                        setCloseFor(s); setCloseForm({ version: newerSpecs[0] ? String(newerSpecs[0].version) : '', note: '' })
                      }}>关闭建议</button>
                    )}
                    {['待处理', '处理中'].includes(s.status) && <button className="btn sm" onClick={() => setRejectFor(s)}>不采纳</button>}
                    {s.status === '不采纳待确认' && <button className="btn sm" disabled={busy !== ''} onClick={() => suggestAction(s, 'confirm-reject')}>确认不采纳</button>}
                    {['已消除', '已关闭'].includes(s.status) && <button className="btn sm ghost" disabled={busy !== ''} onClick={() => suggestAction(s, 'reopen')}>重新打开</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="section-block">
            <h4>评审批注</h4>
            <div className="inner">
              {(review.annotations || []).length === 0 && <p className="muted small">暂无批注</p>}
              {(review.annotations || []).map((a: any) => (
                <div key={a.id} className="dep-row" style={{ alignItems: 'flex-start' }}>
                  <span className="tag tone-gray nowrap">{a.section}</span>
                  <div className="grow">
                    <div className="small">{a.content}</div>
                    {a.quote && <div className="tiny muted mt8">引用：{a.quote}</div>}
                    <div className="tiny muted mt8">{a.author_name} · {fmtTime(a.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {createOpen && (
        <Modal title="发起需求评审" subtitle="评审人不少于两人，需已发布说明书" onClose={() => setCreateOpen(false)}
          footer={<>
            <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="btn primary" disabled={busy === 'create'} onClick={createReview}>发起评审</button>
          </>}>
          <div className="stack">
            <Field label="评审人" required hint={`已选 ${reviewerIds.length} 人`}>
              <div className="stack" style={{ gap: 6 }}>
                {reviewerChoices.map(m => (
                  <label key={m.id} className="checkline">
                    <input type="checkbox" checked={reviewerIds.includes(m.id)} onChange={() => toggleReviewer(m.id)} />
                    <span>{m.name} <span className="muted tiny">（{m.project_role === 'reviewer' ? '评审人' : m.project_role === 'pm' ? '产品经理' : '管理员'}）</span></span>
                  </label>
                ))}
                {!reviewerChoices.length && <p className="muted small">项目中还没有可担任评审人的成员，请先在设置中添加。</p>}
              </div>
            </Field>
            <Field label="评审截止" hint="可选">
              <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} />
            </Field>
            {!canCreate && <div className="notice">当前状态为「{detail.status}」，需已有已发布说明书才能发起评审。</div>}
          </div>
        </Modal>
      )}

      {rejectFor && (
        <Modal title="不采纳建议" subtitle={rejectFor.title} onClose={() => setRejectFor(null)}
          footer={<>
            <button className="btn" onClick={() => setRejectFor(null)}>取消</button>
            <button className="btn danger" disabled={busy !== '' || !rejectReason.trim()} onClick={() => suggestAction(rejectFor, 'reject', { reason: rejectReason })}>提交不采纳</button>
          </>}>
          <Field label="不采纳理由" required>
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="说明为什么本轮不改，并注明替代方案" />
          </Field>
          <p className="hint mt8">提交后状态为「不采纳待确认」，需提出意见的评审人确认后才关闭。</p>
        </Modal>
      )}

      {closeFor && (
        <Modal title="关闭改进建议" subtitle={closeFor.title} onClose={() => setCloseFor(null)}
          footer={<>
            <button className="btn" onClick={() => setCloseFor(null)}>取消</button>
            <button className="btn primary" disabled={busy !== '' || !closeForm.version} onClick={closeSuggestion}>关联并关闭</button>
          </>}>
          <div className="stack">
            <div className="notice">必须关联评审之后的新说明书版本，且内容相对评审版本有实际变化。</div>
            <Field label="目标说明书版本" required>
              {newerSpecs.length ? (
                <select value={closeForm.version} onChange={e => setCloseForm(f => ({ ...f, version: e.target.value }))}>
                  {newerSpecs.map(s => <option key={s.id} value={s.version}>V{s.version} · {s.status === 'published' ? '已发布' : '草稿'}</option>)}
                </select>
              ) : <input type="text" value={closeForm.version} onChange={e => setCloseForm(f => ({ ...f, version: e.target.value }))} placeholder="尚无更新版本，请先生成" />}
            </Field>
            <div className="row">
              <button className="btn sm" disabled={busy !== ''} onClick={generateSpec}>按当前分析生成新版说明书</button>
              <span className="tiny muted">如内容无变化，需先在左侧会话中调整分析或原型。</span>
            </div>
            <Field label="处理说明" hint="可选">
              <textarea value={closeForm.note} onChange={e => setCloseForm(f => ({ ...f, note: e.target.value }))} placeholder="说明如何消除该建议" style={{ minHeight: 60 }} />
            </Field>
          </div>
        </Modal>
      )}

      {concludeOpen && (
        <Modal title="登记评审结论" subtitle={`第 ${review?.round} 轮 · 待闭环建议 ${openCount} 条`} onClose={() => setConcludeOpen(false)}
          footer={<>
            <button className="btn" onClick={() => setConcludeOpen(false)}>取消</button>
            <button className="btn primary" disabled={busy === 'conclude'} onClick={conclude}>提交结论</button>
          </>}>
          <div className="stack">
            <Field label="结论" required>
              <select value={conclusion.conclusion} onChange={e => setConclusion(c => ({ ...c, conclusion: e.target.value }))}>
                <option value="通过">通过</option>
                <option value="不通过">不通过</option>
              </select>
            </Field>
            <Field label="结论摘要" hint="不通过时建议写明退回原因">
              <textarea value={conclusion.summary} onChange={e => setConclusion(c => ({ ...c, summary: e.target.value }))} />
            </Field>
            {conclusion.conclusion === '通过' && openCount > 0 && (
              <div className="notice danger">仍有 {openCount} 条建议未闭环，通过评审会被拒绝。</div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
