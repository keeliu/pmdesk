import React, { useState } from 'react'
import { fmtTime, get, post } from '../api'
import { ErrorBox, Field, Loading, StatusTag, useAsync } from '../ui'

export default function PublicForm({ token }: { token: string }) {
  const info = useAsync<any>(() => get(`/api/public/forms/${token}`), [token])
  const [form, setForm] = useState({ title: '', content: '', submitter: '', contact: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<any>(null)
  const [receipt, setReceipt] = useState('')
  const [lookup, setLookup] = useState<any>(null)
  const [lookupError, setLookupError] = useState('')

  const submit = async () => {
    setError('')
    if (!form.title.trim() || !form.content.trim() || !form.submitter.trim()) {
      setError('请填写提交人、需求标题与需求内容'); return
    }
    setBusy(true)
    try {
      const res = await post<any>(`/api/public/forms/${token}/submissions`, form)
      setResult(res)
      setForm({ title: '', content: '', submitter: form.submitter, contact: form.contact })
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  const query = async () => {
    setLookupError(''); setLookup(null)
    if (!receipt.trim()) { setLookupError('请输入回执编号'); return }
    try { setLookup(await get<any>(`/api/public/forms/${token}/submissions/${encodeURIComponent(receipt.trim())}`)) }
    catch (e: any) { setLookupError(e.message) }
  }

  if (info.loading) return <div style={{ padding: 60 }}><Loading label="正在加载表单…" /></div>
  if (info.error) return <div className="shared-page"><ErrorBox message={info.error} /></div>

  return (
    <div className="shared-page">
      <div className="shared-head">
        <div className="row between">
          <div className="brand"><span className="brand-mark">需</span>{info.data.project.name} · 需求登记</div>
          <span className="shared-badge">对外表单 · 有效期至 {fmtTime(info.data.expiresAt)}</span>
        </div>
        <h1 style={{ marginTop: 18, fontSize: 24 }}>提交一条需求</h1>
        <p className="muted mt8">提交后进入对方的待澄清箱，由产品经理补齐澄清信息后确认入池。请保存回执编号，用于查询自己提交的进度。</p>
      </div>

      <div className="card mb12">
        <div className="card-head"><div><h3>需求信息</h3><p>带 * 为必填，内容仅用于需求分析</p></div></div>
        <div className="card-body stack">
          <div className="grid c2">
            <Field label="提交人" required><input value={form.submitter} maxLength={40} onChange={e => setForm({ ...form, submitter: e.target.value })} placeholder="姓名或部门" /></Field>
            <Field label="联系方式" hint="选填，便于澄清时联系"><input value={form.contact} maxLength={80} onChange={e => setForm({ ...form, contact: e.target.value })} placeholder="邮箱 / 电话" /></Field>
          </div>
          <Field label="需求标题" required><input value={form.title} maxLength={120} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="一句话说明需要什么" /></Field>
          <Field label="需求内容" required hint="背景、涉及角色、期望结果、时间要求等">
            <textarea style={{ minHeight: 160 }} value={form.content} maxLength={20000} onChange={e => setForm({ ...form, content: e.target.value })} placeholder="例如：门店督导需要在移动端查看门店分级结果……" />
          </Field>
          {error && <div className="notice danger">{error}</div>}
          <div className="row end"><button className="btn primary" disabled={busy} onClick={submit}>{busy ? '提交中…' : '提交需求'}</button></div>
        </div>
      </div>

      {result && (
        <div className="card mb12">
          <div className="card-head"><div><h3>提交成功</h3><p>请保存回执编号，后续可凭回执查询进度</p></div></div>
          <div className="card-body stack">
            <div className="notice success">「{result.title}」已提交，登记时间 {fmtTime(result.submittedAt)}。</div>
            <Field label="回执编号"><input readOnly value={result.receipt} onFocus={e => e.currentTarget.select()} /></Field>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><div><h3>查询我的提交</h3><p>输入回执编号只能查看本次提交的内容与状态</p></div></div>
        <div className="card-body stack">
          <div className="row">
            <input style={{ maxWidth: 360 }} value={receipt} onChange={e => setReceipt(e.target.value)} placeholder="RC-…" />
            <button className="btn" onClick={query}>查询</button>
          </div>
          {lookupError && <div className="notice danger">{lookupError}</div>}
          {lookup && (
            <div className="section-block">
              <h4>{lookup.title}</h4>
              <div className="inner stack">
                <div className="row wrap"><StatusTag status={lookup.status} /><span className="tiny muted">{fmtTime(lookup.submittedAt)}</span></div>
                <p className="muted">{lookup.excerpt}</p>
              </div>
            </div>
          )}
        </div>
      </div>
      <p className="muted small" style={{ textAlign: 'center', marginTop: 24 }}>此页面为对外需求登记表单，提交内容仅对提交人与项目成员可见。</p>
    </div>
  )
}
