// 媒体发送：MEDIA: 指令解析 + 路径解析 + 上传发送编排
// agent 回复中独占一行的 `MEDIA:<路径|URL>` 会被解析为媒体指令，
// 指令行从用户可见文本中剔除，媒体按 MIME 自动路由（图片/视频/文件）。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CDN_BASE_URL } from '../vendor/weixin-dist/src/auth/accounts.js'
import { downloadRemoteImageToTemp } from '../vendor/weixin-dist/src/cdn/upload.js'
import { sendWeixinMediaFile } from '../vendor/weixin-dist/src/messaging/send-media.js'

const MEDIA_DIRECTIVE_RE = /(^|\n)MEDIA:([^\n]*)(?:\n|$)/gm

/**
 * 解析回复文本中的 MEDIA: 指令。
 * 指令必须独占一行（行首 MEDIA: 到行尾），否则视为普通文本。
 * @returns {{ text: string, directives: Array<{ target: string }> }}
 *   text 为剔除指令行后的剩余文本（连续空行折叠、首尾去空白）
 */
export function parseMediaDirectives(text) {
  const directives = []
  const cleaned = String(text ?? '').replace(MEDIA_DIRECTIVE_RE, (_, lead, target) => {
    const t = String(target).trim()
    if (t) directives.push({ target: t })
    return lead
  })
  return {
    text: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    directives
  }
}

/** http/https 远程 URL 判断。 */
export function isRemoteUrl(target) {
  return /^https?:\/\//i.test(target)
}

/**
 * 把 MEDIA: 目标解析为本地文件路径：
 *   - http(s)://    → 下载到 tempDir 的临时文件
 *   - file://       → 文件 URL 转路径
 *   - 绝对路径       → 原样使用
 *   - 相对路径       → 基于 cwd resolve
 * @param deps.downloadRemoteImageToTemp 可注入的下载函数（测试用），默认 vendor 实现
 * @throws 下载失败 / 路径为空时抛出
 */
export async function resolveMediaTarget(target, cwd, tempDir, deps = {}) {
  const raw = String(target ?? '').trim()
  if (!raw) throw new Error('media target is empty')
  if (isRemoteUrl(raw)) {
    const download = deps.downloadRemoteImageToTemp ?? downloadRemoteImageToTemp
    return download(raw, tempDir)
  }
  if (raw.startsWith('file://')) {
    const p = fileURLToPath(raw)
    if (!path.isAbsolute(p)) throw new Error('media target is not an absolute path: ' + raw)
    return p
  }
  if (path.isAbsolute(raw)) return raw
  return path.resolve(cwd, raw)
}

/**
 * 投递 agent 回复：解析 MEDIA: 指令并发送媒体，返回剩余文本与发送结果。
 * - 无媒体指令：原样返回文本，由调用方按纯文本发送。
 * - 有媒体指令：逐条上传发送；文本只随第一个成功发送的媒体作为 caption。
 * - 单个媒体失败不中断其余媒体，失败详情收集在 failures。
 * @param deps.sendWeixinMediaFile 可注入的发送函数（测试用），默认 vendor 实现
 * @returns {{ text: string, mediaSent: number, failures: Array<{ target: string, error: string }> }}
 */
export async function deliverReply({ to, text, account, contextToken, cwd, tempDir, log, deps = {} }) {
  const { text: cleanText, directives } = parseMediaDirectives(text)
  if (directives.length === 0) {
    return { text: cleanText, mediaSent: 0, failures: [] }
  }
  const opts = {
    baseUrl: account.baseUrl,
    token: account.token,
    contextToken,
    timeoutMs: 120_000
  }
  const cdnBaseUrl = account.cdnBaseUrl || CDN_BASE_URL
  const send = deps.sendWeixinMediaFile ?? sendWeixinMediaFile
  let mediaSent = 0
  let caption = cleanText
  const failures = []
  for (const d of directives) {
    try {
      const filePath = await resolveMediaTarget(d.target, cwd, tempDir, deps)
      await send({ filePath, to, text: caption, opts, cdnBaseUrl })
      mediaSent += 1
      caption = ''
      log('✅ 已发送媒体到微信: ' + path.basename(filePath))
    } catch (e) {
      failures.push({ target: d.target, error: e.message })
      log('❌ 媒体发送失败 [' + d.target.slice(0, 100) + ']: ' + e.message)
    }
  }
  return { text: caption, mediaSent, failures }
}
