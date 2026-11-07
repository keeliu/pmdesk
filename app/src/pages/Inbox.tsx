import React, { useEffect, useRef, useState } from 'react'
import { fmtTime, get, navigate, post, readFile } from '../api'
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader, Tag, useAsync, useToast } from '../ui'

const GAP_LABEL: Record<string, string> = { roles: '角色', goal: '目标', scope: '范围', boundary: '边界', acceptance: '验收', involvedApps: '应用' }
const PAGE_SIZE = 10

function gapsOf(r: any) {
  const a = r.clarification?.answers || {}
  const gaps = ['roles', 'goal', 'scope', 'boundary', 'acceptance'].filter(k => !a[k]?.value)
  if (!(r.involvedApps || []).length) gaps.push('involvedApps')
  return gaps
}

export default function Inbox({ projectId }: any) {
  const toast = useToast()
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useAsync<any>(
    () => get(`/api/projects/${projectId}/requirements?inbox=1&page=${page}&pageSize=${PAGE_SIZE}`),
    [projectId, page])
  const items: any[] = data?.items || []
  const total: number = data?.total ?? 0
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<any[]>([])
  const [autoSplit, setAutoSplit] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [drag, setDrag] = useState(false)
  const [mergeTarget, setMergeTarget] = useState<any>(null)
  const [discardTargets, setDiscardTargets] = useState<any[]>([])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setSelected(new Set()) }, [page, projectId])

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return
    const reads = await Promise.all([...list].slice(0, 5).map(readFile))
    setFiles(prev => [...prev, ...reads].slice(0, 5))
  }

  const submit = async () => {
    if (!text.trim() && !files.length) { toast.push('请输入需求内容或上传文件', 'warn'); return }
    setSubmitting(true)
    try {
      const payload: any = { text, autoSplit, submitter: '登记人' }
      if (files[0]) payload.file = files[0]
      const res = await post<any>(`/api/projects/${projectId}/requirements/intake`, payload)
      setResult(res)
      setText(''); setFiles([])
      toast.push(`已登记 ${res.created.length} 条需求到待澄清箱`, 'success')
      setPage(1)
      await reload()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setSubmitting(false) }
  }

  const merge = async () => {
    if (!mergeTarget) return
    setBusy('merge')
    try {
      await post(`/api/requirements/${mergeTarget.id}/merge`, { targetId: mergeTarget.targetId })
      toast.push('已合并，来源需求标记为已丢弃', 'success')
      setMergeTarget(null)
      await reload()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const discard = async () => {
    if (!discardTargets.length) return
    setBusy('discard')
    try {
      if (discardTargets.length === 1) {
        await post(`/api/requirements/${discardTargets[0].id}/discard`, { reason })
      } else {
        await post(`/api/projects/${projectId}/requirements/batch-discard`, { ids: discardTargets.map(r => r.id), reason })
      }
      toast.push(`已丢弃 ${discardTargets.length} 条需求`, 'success')
      setDiscardTargets([]); setReason(''); setSelected(new Set())
      const remainingOnPage = items.filter(r => !discardTargets.some(d => d.id === r.id)).length
      if (remainingOnPage === 0 && page > 1) setPage(page - 1)
      else await reload()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const allChecked = items.length > 0 && items.every(r => selected.has(r.id))
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(items.map(r => r.id)))
  const toggleOne = (id: string) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  return (
    <>
      <PageHeader title="待澄清箱" desc="尚未确认的需求没有编号，不进入需求池。补齐角色、目标、范围、边界、验收口径与涉及应用后才能确认入池。"
        actions={<Tag tone="gray">{total} 条待澄清</Tag>} />

      <div className="intake-grid">
        <div className="card">
          <div className="card-head">
            <div><h3>待确认清单</h3><p>按登记时间倒序，点击进入五阶段工作台</p></div>
            <button className="btn sm" onClick={() => reload()}>刷新</button>
          </div>
          {selected.size > 0 && (
            <div className="batch-bar">
              <span>已选 {selected.size} 条</span>
              <button className="btn sm danger" onClick={() => {
                setDiscardTargets(items.filter(r => selected.has(r.id)))
                setReason('')
              }}>批量丢弃</button>
              <button className="link-btn" onClick={() => setSelected(new Set())}>取消选择</button>
            </div>
          )}
          <div className="card-body tight">
            {loading && <Loading />}
            {error && <ErrorBox message={error} onRetry={reload} />}
            {!loading && !error && !items.length && <Empty title="待澄清箱是空的" desc="新登记的需求会先进入这里，确认后才分配编号。" />}
            {items.map(r => {
              const gaps = gapsOf(r)
              return (
                <div key={r.id} className={`inbox-item ${selected.has(r.id) ? 'selected' : ''}`}>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} aria-label={`选择 ${r.title}`} />
                  <div className="body">
                    <h4 className="clickable" onClick={() => navigate(`/p/${projectId}/req/${r.id}/clarify`)}>{r.title}</h4>
                    <div className="excerpt">{(r.source?.excerpt || '').slice(0, 180)}</div>
                    <div className="meta">
                      <Tag tone="gray">未编号</Tag>
                      <span>{r.source?.submitter || '登记人'}</span>
                      <span>{fmtTime(r.created_at)}</span>
                      {r.source?.fileName && <span>文件：{r.source.fileName}</span>}
                      {r.source?.distilled && <Tag tone="violet">大模型提炼</Tag>}
                    </div>
                    <div className="gap-list mt8">
                      {gaps.length ? gaps.map((g: string) => <Tag key={g} tone="amber">缺{GAP_LABEL[g] || g}</Tag>) : <Tag tone="green">澄清齐备</Tag>}
                      {(r.involvedApps || []).map((a: any) => <Tag key={a.name} tone="blue">{a.name}</Tag>)}
                    </div>
                  </div>
                  <div className="stack" style={{ alignItems: 'flex-end' }}>
                    <button className="btn sm primary" onClick={() => navigate(`/p/${projectId}/req/${r.id}/clarify`)}>进入澄清</button>
                    <button className="btn sm" onClick={() => setMergeTarget({ ...r, targetId: '' })}>合并</button>
                    <button className="btn sm danger" onClick={() => { setDiscardTargets([r]); setReason('') }}>丢弃</button>
                  </div>
                </div>
              )
            })}
            {pageCount > 1 && (
              <div className="pager">
                <label className="checkline"><input type="checkbox" checked={allChecked} onChange={toggleAll} />全选本页</label>
                <span className="muted small">共 {total} 条 · 第 {page}/{pageCount} 页</span>
                <span className="row">
                  <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
                  <button className="btn sm" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>下一页</button>
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div><h3>登记需求</h3><p>支持文本、Markdown、Word、PDF、Excel、PPT 与图片；文档上传时优先由大模型提炼需求</p></div></div>
          <div className="card-body stack">
            <Field label="需求内容" hint="可粘贴会议纪要、聊天记录或需求原文">
              <textarea style={{ minHeight: 150 }} value={text} onChange={e => setText(e.target.value)}
                placeholder="例如：客户经理需要在客户详情页一键发起合同变更申请，审批通过后同步到合同中心……" />
            </Field>
            <div className={`dropzone ${drag ? 'drag' : ''}`}
              onDragOver={e => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files) }}
              onClick={() => fileRef.current?.click()}>
              <input ref={fileRef} type="file" hidden multiple accept=".txt,.md,.markdown,.csv,.docx,.xlsx,.pptx,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp"
                onChange={e => addFiles(e.target.files)} />
              {files.length ? <div className="row wrap" style={{ justifyContent: 'center' }}>{files.map((f, i) => (
                <span key={i} className="file-pill">{f.name}
                  <button className="link-btn" onClick={e => { e.stopPropagation(); setFiles(files.filter((_, j) => j !== i)) }}>×</button>
                </span>))}</div> : <>拖入文件或点击选择 · 单次最多 5 个</>}
            </div>
            <label className="checkline"><input type="checkbox" checked={autoSplit} onChange={e => setAutoSplit(e.target.checked)} />
              按段落自动拆分为多条需求（关闭后整段作为一条）</label>
            <div className="row end">
              <button className="btn primary" disabled={submitting} onClick={submit}>{submitting ? '登记中…' : '登记到待澄清箱'}</button>
            </div>

            {result && (
              <div className="section-block">
                <h4>本次登记结果</h4>
                <div className="inner">
                  {result.parseNote && <div className="notice danger mb8">文件解析提示：{result.parseNote}</div>}
                  {result.created.map((c: any) => (
                    <div key={c.id} className="row between mb8">
                      <span className="truncate">{c.title}</span>
                      <span className="row">
                        {c.duplicate && <Tag tone="amber">疑似重复 {c.duplicate.code || c.duplicate.title}（{c.duplicate.score}%）</Tag>}
                        {c.duplicate && <button className="link-btn" onClick={async () => {
                          try {
                            await post(`/api/requirements/${c.id}/similarity-ignore`, { similarId: c.duplicate.id })
                            setResult({ ...result, created: result.created.map((x: any) => x.id === c.id ? { ...x, duplicate: null } : x) })
                            toast.push('已忽略该相似提示', 'success')
                          } catch (e: any) { toast.push(e.message, 'error') }
                        }}>忽略</button>}
                        <button className="btn sm" onClick={() => navigate(`/p/${projectId}/req/${c.id}/clarify`)}>去澄清</button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {mergeTarget && (
        <Modal title="合并重复需求" subtitle="合并后来源需求将被标记为已丢弃，正文并入目标需求。"
          onClose={() => setMergeTarget(null)}
          footer={<><button className="btn" onClick={() => setMergeTarget(null)}>取消</button>
            <button className="btn primary" disabled={!mergeTarget.targetId || busy === 'merge'} onClick={merge}>确认合并</button></>}>
          <Field label="目标需求" required>
            <select value={mergeTarget.targetId} onChange={e => setMergeTarget({ ...mergeTarget, targetId: e.target.value })}>
              <option value="">请选择并入的需求</option>
              {items.filter(x => x.id !== mergeTarget.id).map(x => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </Field>
          <div className="notice mt12">将保留目标需求的全部内容，并追加来源需求的正文与来源记录。</div>
        </Modal>
      )}

      {discardTargets.length > 0 && (
        <Modal title={discardTargets.length > 1 ? `批量丢弃需求（${discardTargets.length} 条）` : '丢弃需求'}
          subtitle={discardTargets.length > 1 ? discardTargets.slice(0, 3).map((r: any) => r.title).join('、') + (discardTargets.length > 3 ? ` 等 ${discardTargets.length} 条` : '') : discardTargets[0].title}
          onClose={() => setDiscardTargets([])}
          footer={<><button className="btn" onClick={() => setDiscardTargets([])}>取消</button>
            <button className="btn danger" disabled={!reason.trim() || busy === 'discard'} onClick={discard}>确认丢弃</button></>}>
          <Field label="丢弃原因" required><textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="重复、无价值、范围外……" /></Field>
        </Modal>
      )}
    </>
  )
}
