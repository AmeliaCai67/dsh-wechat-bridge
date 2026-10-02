// 接收媒体保存：downloadMediaFromItem 的 saveMedia 实现
// 微信发来的图片/文件/视频下载解密后落盘到 inbox 目录，供 agent 读取。
import fs from 'node:fs/promises'
import path from 'node:path'

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/wav': '.wav',
  'audio/silk': '.silk',
  'text/plain': '.txt',
  'application/pdf': '.pdf'
}

const FALLBACK_EXT = {
  image: '.img',
  video: '.mp4',
  audio: '.audio',
  file: '.bin'
}

function extFromMime(mime) {
  const m = String(mime ?? '').toLowerCase()
  if (EXT_BY_MIME[m]) return EXT_BY_MIME[m]
  const kind = m.split('/')[0]
  return FALLBACK_EXT[kind] ?? '.bin'
}

/**
 * 按【文件头魔数】嗅探真实类型 —— 比信任调用方给的 mime 可靠得多。
 *
 * 为什么需要它（2026-10-02 实测踩到）：腾讯对图片经常【不给 contentType】，
 * 而 vendor 的 saveMedia 签名是 `(buf, contentType, subdir, maxBytes, originalFilename)`——
 * 第 3 个参数是 subdir 不是 kind。于是 mime 为空 → extFromMime('') → 落到 `.bin`。
 * 一张好好的 JPEG 存成 media-xxx.bin，后续按扩展名判类型的环节就认不出来了。
 */
function sniffExt(buf) {
  const b = buf
  const ascii = (s, e) => b.slice(s, e).toString('latin1')
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg'
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG') return '.png'
  if (b.length >= 6 && (ascii(0, 3) === 'GIF')) return '.gif'
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return '.bmp'
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') return '.mp4'
  if (b.length >= 4 && ascii(0, 4) === '%PDF') return '.pdf'
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return '.zip'
  if (b.length >= 4 && ascii(0, 4) === 'fLaC') return '.flac'
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return '.wav'
  if (b.length >= 3 && ascii(0, 3) === 'ID3') return '.mp3'
  return undefined
}

/** 文件名安全化：先按 win32 分隔符取 basename（防目录穿越），再剔除非法字符，防空/前导点。 */
export function sanitizeFileName(name) {
  const base = path.win32.basename(String(name ?? '').replace(/[/\\]+/g, '/')).trim()
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim()
  return cleaned || undefined
}

/**
 * 保存接收到的媒体字节到 inboxDir。
 * 签名对齐 vendor 的 saveMedia 约定：(buf, mimeType, kind, maxBytes, fileName) → { path }。
 * @throws 超过 maxBytes 时抛出；调用方（downloadMediaFromItem）会捕获并记录。
 */
export async function saveInboundMedia(buf, mime, kind, maxBytes, fileName, inboxDir) {
  const limit = maxBytes && maxBytes > 0 ? maxBytes : Infinity
  if (buf.length > limit) {
    throw new Error(`media too large: ${buf.length} bytes > ${limit} bytes`)
  }
  await fs.mkdir(inboxDir, { recursive: true })
  let name = sanitizeFileName(fileName)
  if (!name) {
    // 扩展名按可靠性排序：魔数 > 调用方给的 mime > 第 3 个参数（vendor 传的是 subdir）> .bin
    const ext =
      sniffExt(buf) ??
      extFromMime(mime) ??
      FALLBACK_EXT[String(kind ?? '').toLowerCase()] ??
      '.bin'
    name = 'media-' + Date.now() + ext
  }
  const target = path.join(inboxDir, name)
  const finalPath = await uniquePath(target)
  await fs.writeFile(finalPath, buf)
  return { path: finalPath }
}

async function uniquePath(target) {
  try {
    await fs.access(target)
    const ext = path.extname(target)
    const base = path.basename(target, ext)
    return path.join(path.dirname(target), `${Date.now()}-${base}${ext}`)
  } catch {
    return target
  }
}
