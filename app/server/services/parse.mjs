import JSZip from 'jszip'

function xmlText(xml) {
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<a:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodeBase64(base64) {
  return Buffer.from(base64.includes(',') ? base64.split(',')[1] : base64, 'base64')
}

export async function parseUpload(file) {
  const name = (file.name || 'upload').toLowerCase()
  const buf = decodeBase64(file.base64 || '')
  if (!buf.length) return { ok: false, text: '', reason: '文件内容为空' }

  if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt') || name.endsWith('.csv')) {
    return { ok: true, text: buf.toString('utf8') }
  }

  if (name.endsWith('.docx')) {
    try {
      const zip = await JSZip.loadAsync(buf)
      const doc = await zip.file('word/document.xml')?.async('string')
      if (!doc) return { ok: false, text: '', reason: '未找到文档正文' }
      return { ok: true, text: xmlText(doc) }
    } catch (e) { return { ok: false, text: '', reason: 'Word 解析失败：' + e.message } }
  }

  if (name.endsWith('.xlsx')) {
    try {
      const zip = await JSZip.loadAsync(buf)
      const shared = zip.file('xl/sharedStrings.xml')
      const sharedXml = shared ? await shared.async('string') : ''
      const values = [...sharedXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1])
      const sheets = Object.keys(zip.files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
      const out = []
      for (const s of sheets) {
        const xml = await zip.file(s).async('string')
        for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
          const cells = [...row[1].matchAll(/<c[^>]*?(?:t="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g)]
          const line = cells.map(c => {
            const v = c[2].match(/<v>([\s\S]*?)<\/v>/)
            const inline = c[2].match(/<t[^>]*>([\s\S]*?)<\/t>/)
            if (c[1] === 's' && v) return values[Number(v[1])] || ''
            return inline ? inline[1] : (v ? v[1] : '')
          }).filter(Boolean).join('\t')
          if (line.trim()) out.push(line)
        }
      }
      return { ok: true, text: out.join('\n') }
    } catch (e) { return { ok: false, text: '', reason: 'Excel 解析失败：' + e.message } }
  }

  if (name.endsWith('.pptx')) {
    try {
      const zip = await JSZip.loadAsync(buf)
      const slides = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort()
      const texts = []
      for (const [i, s] of slides.entries()) {
        const xml = await zip.file(s).async('string')
        texts.push(`【第 ${i + 1} 页】\n` + xmlText(xml))
      }
      return { ok: true, text: texts.join('\n\n') }
    } catch (e) { return { ok: false, text: '', reason: 'PPT 解析失败：' + e.message } }
  }

  if (name.endsWith('.pdf')) {
    const raw = buf.toString('latin1')
    const chunks = []
    for (const m of raw.matchAll(/\(([^()\\]{3,})\)\s*Tj/g)) chunks.push(m[1])
    for (const m of raw.matchAll(/\[((?:\([^)]*\)|-?\d+[.\d]*\s*)+)\]\s*TJ/g)) {
      const parts = [...m[1].matchAll(/\(([^)]*)\)/g)].map(x => x[1])
      if (parts.length) chunks.push(parts.join(''))
    }
    const text = chunks.join(' ').replace(/\s+/g, ' ').trim()
    if (text.length > 30) return { ok: true, text }
    return { ok: false, text: '', reason: 'PDF 无可提取文本（可能为扫描件），请人工录入' }
  }

  return { ok: false, text: '', reason: '暂不支持该格式，已保留原文件，请人工录入' }
}

export function splitText(text) {
  const cleaned = text.replace(/\r/g, '').trim()
  if (!cleaned) return []
  let blocks = cleaned.split(/\n\s*\n+/).map(s => s.trim()).filter(s => s.length >= 8)
  if (blocks.length <= 1) {
    blocks = cleaned.split(/\n(?=\s*(?:\d+[.、)]|[-*•]|需求[一二三四五六七八九十\d]+))/).map(s => s.trim()).filter(s => s.length >= 8)
  }
  if (blocks.length <= 1) {
    const sentences = cleaned.split(/(?<=[。！？；])\s*/).filter(s => s.length >= 8)
    if (sentences.length > 3) {
      const merged = []
      for (let i = 0; i < sentences.length; i += 2) merged.push((sentences[i] || '') + (sentences[i + 1] || ''))
      blocks = merged
    }
  }
  return blocks.map((text, index) => {
    const firstLine = text.split('\n')[0].replace(/^[#>*\-\d.、\s]+/, '').trim()
    const title = firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine || `需求 ${index + 1}`
    return { title, text }
  })
}

export function similarity(a = '', b = '') {
  const norm = s => s.toLowerCase().replace(/[\s\p{P}]/gu, '')
  const A = norm(a), B = norm(b)
  if (!A || !B) return 0
  const grams = s => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const ga = grams(A), gb = grams(B)
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return (2 * inter) / (ga.size + gb.size || 1)
}
