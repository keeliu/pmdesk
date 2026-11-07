import React, { useEffect, useState } from 'react'
import { downloadUrl, fmtTime, get, post } from '../../api'
import { Empty, ErrorBox, Field, Loading, Modal, Tag, useAsync, useToast } from '../../ui'

type Props = { reqId: string; detail: any; onRefresh: () => Promise<void> }

export default function PrototypePanel({ reqId, detail, onRefresh }: Props) {
  const toast = useToast()
  const protos = useAsync<any[]>(() => get(`/api/requirements/${reqId}/prototypes`), [reqId, detail.updated_at])
  const specs = useAsync<any[]>(() => get(`/api/requirements/${reqId}/specs`), [reqId, detail.updated_at])
  const [protoId, setProtoId] = useState('')
  const [specId, setSpecId] = useState('')
  const [pageId, setPageId] = useState('')
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop')
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState('')
  const [compare, setCompare] = useState<any>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const list = protos.data || []
  const specList = specs.data || []
  const proto = list.find(p => p.id === protoId) || list[0]
  const spec = specList.find(s => s.id === specId) || specList[0]

  useEffect(() => {
    if (proto && !proto.pages.some((pg: any) => pg.id === pageId)) setPageId(proto.pages[0]?.id || '')
  }, [proto?.id])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'proto-nav' && e.data.id) setPageId(e.data.id)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const page = proto?.pages.find((pg: any) => pg.id === pageId) || proto?.pages[0]

  const generate = async () => {
    setBusy('generate')
    try {
      const r = await post<any>(`/api/requirements/${reqId}/prototypes/generate`, {})
      toast.push(`已生成原型 V${r.version}`, 'success')
      await onRefresh()
      await protos.reload()
      setProtoId(r.id)
      setPageId(r.pages?.[0]?.id || '')
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const revise = async () => {
    if (!instruction.trim() || !proto) return
    setBusy('revise')
    try {
      const r = await post<any>(`/api/prototypes/${proto.id}/revise`, { instruction, pageId: page?.id })
      toast.push(`已生成改稿 V${r.version}：${(r.changes || []).join('；')}`, 'success')
      setInstruction('')
      await onRefresh()
      await protos.reload()
      setProtoId(r.id)
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const confirmProto = async () => {
    if (!proto) return
    setBusy('confirm')
    try {
      await post(`/api/prototypes/${proto.id}/confirm`, {})
      toast.push(`原型 V${proto.version} 已确认定稿`, 'success')
      setConfirmOpen(false)
      await onRefresh()
      await protos.reload()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const doCompare = async () => {
    if (!proto || proto.version <= 1) { toast.push('当前已是首个版本，无对比基线', 'warn'); return }
    setBusy('compare')
    try { setCompare(await get(`/api/prototypes/${proto.id}/compare`)) }
    catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const generateSpec = async () => {
    setBusy('spec')
    try {
      const r = await post<any>(`/api/requirements/${reqId}/specs/generate`, {})
      toast.push(`已生成说明书 V${r.version}（${r.skill?.slug ? `${r.skill.slug}@${r.skill.version}` : '内置渲染'}${r.skillFallbackFrom ? '，已降级' : ''}）`, 'success')
      await onRefresh()
      await specs.reload()
      setSpecId(r.id)
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const publishSpec = async () => {
    if (!spec) return
    setBusy('publish')
    try {
      await post(`/api/specs/${spec.id}/publish`, {})
      toast.push(`说明书 V${spec.version} 已发布`, 'success')
      await onRefresh()
      await specs.reload()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  if (protos.loading && !protos.data) return <Loading label="加载原型…" />
  if (protos.error) return <ErrorBox message={protos.error} onRetry={protos.reload} />

  return (
    <div className="stack">
      <div className="card">
        <div className="card-body stack">
          <div className="row wrap" style={{ justifyContent: 'space-between' }}>
            <div className="row wrap">
              {list.length > 1 ? (
                <select style={{ width: 150 }} value={proto?.id} onChange={e => setProtoId(e.target.value)}>
                  {list.map(p => <option key={p.id} value={p.id}>原型 V{p.version}</option>)}
                </select>
              ) : <strong>{proto ? `原型 V${proto.version}` : '尚未生成原型'}</strong>}
              {proto && <Tag tone={proto.status === 'confirmed' ? 'green' : 'gray'}>{proto.status === 'confirmed' ? '已确认' : '草稿'}</Tag>}
              {proto && <span className="muted tiny">基于分析 V{proto.analysis_version}</span>}
            </div>
            <div className="row">
              {proto && <button className="btn sm" disabled={busy !== ''} onClick={doCompare}>版本对比</button>}
              {proto && proto.status !== 'confirmed' && (
                <button className="btn sm" disabled={busy !== ''} onClick={() => setConfirmOpen(true)}>确认定稿</button>
              )}
              <button className="btn sm primary" disabled={busy !== ''} onClick={generate}>
                {list.length ? '重新生成' : '生成原型'}
              </button>
            </div>
          </div>

          {proto ? (
            <>
              <div className="proto-toolbar">
                <div className="proto-tabs">
                  {proto.pages.map((pg: any) => (
                    <button key={pg.id} className={`proto-tab ${page?.id === pg.id ? 'active' : ''}`} onClick={() => setPageId(pg.id)}>
                      {pg.kind === 'overview' ? '◇ ' : ''}{pg.name}
                    </button>
                  ))}
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <button className={`btn sm ${viewport === 'desktop' ? 'primary' : ''}`} onClick={() => setViewport('desktop')}>桌面</button>
                  <button className={`btn sm ${viewport === 'mobile' ? 'primary' : ''}`} onClick={() => setViewport('mobile')}>移动</button>
                </div>
              </div>
              <div className={`proto-frame-wrap ${viewport === 'mobile' ? 'mobile' : ''}`}>
                <div className="frame-bar">
                  <span className="dots"><i /><i /><i /></span>
                  <span className="grow truncate">{detail.code || '未编号'} · {page?.name || '—'}</span>
                  <span>{page?.layout || 'list'}</span>
                </div>
                <iframe key={`${proto.id}-${page?.id}-${viewport}`} title="原型预览"
                  src={`/api/prototypes/${proto.id}/page/${page?.id}`} />
              </div>
              <p className="tiny muted">页面内可直接切换状态（默认 / 空 / 加载 / 错误 / 无权限）；点击页面内导航可在上方页签间联动。</p>
              <div className="mini-form">
                <Field label="描述要调整的内容" hint="调整会同步生成新分析版本与新原型版本">
                  <textarea value={instruction} onChange={e => setInstruction(e.target.value)}
                    placeholder="例如：新增页面「审批详情」；页面改为表格布局；标题改为「需求受理」" style={{ minHeight: 62 }} />
                </Field>
                <div className="row">
                  <span className="tiny muted">作用页面：{page?.name || '—'}</span>
                  <button className="btn primary sm" style={{ marginLeft: 'auto' }} disabled={busy !== '' || !instruction.trim()} onClick={revise}>提交调整</button>
                </div>
              </div>
            </>
          ) : (
            <Empty icon="◧" title="还没有原型" desc="原型从已提交的需求分析生成，覆盖功能页面、默认/空/错误/无权限等状态。生成前请确保分析已通过一致性校验。"
              action={<button className="btn primary" disabled={busy !== ''} onClick={generate}>生成界面原型</button>} />
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div><h3>需求分析说明书</h3><p>原型确认后写入说明书，发布后可进入需求评审中</p></div>
          <div className="row">
            {spec && <button className="btn sm" onClick={() => downloadUrl(`/api/specs/${spec.id}/docx`)}>导出 Word</button>}
            {spec && spec.status !== 'published' && <button className="btn sm" disabled={busy !== ''} onClick={publishSpec}>发布 V{spec.version}</button>}
            <button className="btn sm primary" disabled={busy !== ''} onClick={generateSpec}>生成说明书</button>
          </div>
        </div>
        <div className="card-body stack">
          {!specList.length && <p className="muted small">尚未生成说明书。说明书写入澄清结论、四段分析、原型页面与评审变更记录。</p>}
          {specList.length > 0 && (
            <div className="row wrap">
              {specList.map(s => (
                <button key={s.id} className={`proto-tab ${spec?.id === s.id ? 'active' : ''}`} onClick={() => setSpecId(s.id)}>
                  V{s.version} · {s.status === 'published' ? '已发布' : s.status === 'superseded' ? '已被替代' : '草稿'}
                </button>
              ))}
            </div>
          )}
          {spec && (
            <>
              <div className="row wrap small muted">
                <span>分析 V{spec.analysis_version}</span><span>原型 V{spec.prototype_version}</span>
                <span>生成于 {fmtTime(spec.created_at)}</span>
                {spec.created_by_name && <span>{spec.created_by_name}</span>}
              </div>
              <iframe className="spec-frame" title="说明书预览" src={`/api/specs/${spec.id}/preview`} />
            </>
          )}
        </div>
      </div>

      {confirmOpen && (
        <Modal title="确认原型定稿" subtitle={`原型 V${proto?.version} · ${proto?.pages.length} 个页面`} onClose={() => setConfirmOpen(false)}
          footer={<>
            <button className="btn" onClick={() => setConfirmOpen(false)}>取消</button>
            <button className="btn primary" disabled={busy === 'confirm'} onClick={confirmProto}>确认定稿</button>
          </>}>
          <div className="stack">
            <div className="notice">确认后原型锁定为评审基线，后续调整需通过会话改稿生成新版本。</div>
            <div className="row wrap">{proto?.pages.map((pg: any) => <Tag key={pg.id} tone="violet">{pg.name}</Tag>)}</div>
          </div>
        </Modal>
      )}

      {compare && (
        <Modal title={`原型版本对比 V${compare.from} → V${compare.to}`} onClose={() => setCompare(null)}
          footer={<button className="btn" onClick={() => setCompare(null)}>关闭</button>}>
          <div className="stack">
            <div><div className="section-title">新增页面</div><div className="row wrap">{compare.added.length ? compare.added.map((n: string) => <Tag key={n} tone="green">{n}</Tag>) : <span className="muted small">无</span>}</div></div>
            <div><div className="section-title">删除页面</div><div className="row wrap">{compare.removed.length ? compare.removed.map((n: string) => <Tag key={n} tone="red">{n}</Tag>) : <span className="muted small">无</span>}</div></div>
            <div><div className="section-title">内容变更</div><div className="row wrap">{compare.changed.length ? compare.changed.map((n: string) => <Tag key={n} tone="amber">{n}</Tag>) : <span className="muted small">无</span>}</div></div>
            <p className="small muted">未变更 {compare.unchanged} 个页面</p>
          </div>
        </Modal>
      )}
    </div>
  )
}
