import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean)

export function findBrowser() {
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}

export function renderPdf(html, { timeoutMs = 60000 } = {}) {
  const browser = findBrowser()
  if (!browser) {
    const err = new Error('导出失败：运行环境缺少可用的无头浏览器（Chrome 或 Edge），未生成 PDF')
    err.statusCode = 501
    throw err
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-spec-pdf-'))
  const htmlFile = path.join(dir, 'spec.html')
  const pdfFile = path.join(dir, 'spec.pdf')
  try {
    fs.writeFileSync(htmlFile, html, 'utf8')
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--no-pdf-header-footer', `--print-to-pdf=${pdfFile}`,
      pathToFileURL(htmlFile).href
    ]
    const res = spawnSync(browser, args, { timeout: timeoutMs, windowsHide: true })
    if (res.error) {
      const err = new Error(`导出失败：无头浏览器无法启动（${res.error.message}），未生成 PDF`)
      err.statusCode = 501
      throw err
    }
    if (!fs.existsSync(pdfFile)) {
      const err = new Error(`导出失败：无头浏览器未产出 PDF 文件（退出码 ${res.status}），未生成 PDF`)
      err.statusCode = 502
      throw err
    }
    const buf = fs.readFileSync(pdfFile)
    if (buf.subarray(0, 5).toString() !== '%PDF-') {
      const err = new Error('导出失败：浏览器产出的文件不是有效 PDF，已丢弃')
      err.statusCode = 502
      throw err
    }
    return buf
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
