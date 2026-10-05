// 微信桥接核心：getUpdates 长轮询 → DSH prompt → mux 收回复 → 发回微信
// 独立可测（node lib/bridge.js 直接跑）；插件 apply() 中通过 startBridge() 启动
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { registerWeixinAccountId, loadWeixinAccount, CDN_BASE_URL } from '../vendor/weixin-dist/src/auth/accounts.js'
import { getUpdates, notifyStart, notifyStop } from '../vendor/weixin-dist/src/api/api.js'
import { sendMessageWeixin } from '../vendor/weixin-dist/src/messaging/send.js'
import { downloadMediaFromItem } from '../vendor/weixin-dist/src/media/media-download.js'
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from '../vendor/weixin-dist/src/storage/sync-buf.js'
import { restoreContextTokens, setContextToken, getContextToken } from '../vendor/weixin-dist/src/messaging/inbound.js'
import { MessageItemType, MessageType } from '../vendor/weixin-dist/src/api/types.js'
import { deliverReply } from './media.js'
import { saveInboundMedia } from './inbox.js'
import { sendWeixinMediaFile } from '../vendor/weixin-dist/src/messaging/send-media.js'
import { dshCall, dshMux } from './dsh-client.js'

const LONG_POLL_MS = 35_000
const REPLY_TIMEOUT_MS = 300_000
const DEFAULT_MAX_MEDIA_BYTES = 100 * 1024 * 1024 // 与腾讯端接收上限一致

// agent 能力提示：首条消息注入一次，让 agent 知道可以发图片/文件
const MEDIA_HINT = [
  '[系统提示] 你可以通过微信向用户发送图片或文件：',
  '在回复中独占一行输出 MEDIA:<文件绝对路径>（如 MEDIA:C:\\Users\\me\\photo.png 或 MEDIA:/tmp/report.pdf），或 MEDIA:<https图片链接>。',
  '该指令行不会显示给用户；发送前确保文件真实存在，不要编造路径。',
  '仅当你确实需要发送文件/图片时才使用。'
].join('\n')

function stateFile() {
  return path.join(os.homedir(), '.openclaw', 'openclaw-weixin', 'dsh-bridge-state.json')
}

function loadBridgeState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch { return null }
}

function saveBridgeState(state, statePath) {
  try { fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8') } catch {}
}

// 账号发现：读索引，缺失时扫描目录并补注册
function discoverAccounts() {
  const stateDir = path.join(os.homedir(), '.openclaw', 'openclaw-weixin')
  const indexFile = path.join(stateDir, 'accounts.json')
  try {
    if (fs.existsSync(indexFile)) {
      const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.filter((x) => typeof x === 'string')
    }
  } catch {}
  const dir = path.join(stateDir, 'accounts')
  const found = []
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json') && !f.endsWith('.sync.json') && !f.endsWith('.context-tokens.json')) {
        const id = f.slice(0, -5)
        try { registerWeixinAccountId(id) } catch {}
        found.push(id)
      }
    }
  }
  return found
}

/**
 * 挑出「当前生效」的那个账号 —— 不是索引里的第一个。
 *
 * 为什么不能用 accountIds[0]：重新扫码登录会**注册一个全新的 bot id**，
 * 而 registerWeixinAccountId() 是 `[...existing, accountId]` —— **往索引末尾追加**。
 * 一个微信号同时只能绑一个 bot，所以应该用的是**最近扫码登录的那个**，
 * 也就是永远排在后面的那个。取 [0] 会一直加载旧账号，表现是**收不到任何消息**
 * （通道在服务端已经归新 bot 了，旧 token 轮询永远空转）。
 * —— 2026-10-05 实测踩到，见 README「Known limitations」。
 *
 * 判据：凭据文件 accounts/<id>.json 的 mtime 最新的那个。
 * 拿不到就用索引末位（索引本身是追加顺序，末位＝最新注册）。
 *
 * @param accountIds - discoverAccounts() 给出的候选，按索引顺序。
 * @returns 应该使用的 accountId。
 */
export function pickActiveAccount(accountIds) {
  if (accountIds.length <= 1) return accountIds[0]
  const dir = path.join(os.homedir(), '.openclaw', 'openclaw-weixin', 'accounts')
  let best
  let bestMs = -1
  for (const id of accountIds) {
    try {
      const ms = fs.statSync(path.join(dir, id + '.json')).mtimeMs
      if (ms > bestMs) { bestMs = ms; best = id }
    } catch {}
  }
  return best ?? accountIds[accountIds.length - 1]
}

async function ensureSession(cwd, log, call, statePath) {
  let saved = loadBridgeState(statePath)
  if (saved?.sessionId) {
    try {
      const list = await call('session.list', {})
      for (const it of list.items ?? []) {
        if (it.sessionId === saved.sessionId) return saved.sessionId
      }
    } catch {}
  }
  const created = await call('session.create', { cwd, agentPreset: 'standard' })
  saveBridgeState({ ...(saved ?? {}), sessionId: created.sessionId }, statePath)
  log('🆕 创建专用 DSH 会话: ' + created.sessionId)
  return created.sessionId
}


// DSH 就绪等待：启动早期 apiProxy 可能未完全就绪，退避重试（最多约 1 分钟）
async function ensureDshReady(call, log, signal) {
  const MAX_ATTEMPTS = 12
  for (let attempt = 1; ; attempt++) {
    try {
      await call('session.list', {})
      return
    } catch (e) {
      if (signal.aborted) return
      if (attempt >= MAX_ATTEMPTS) throw e
      log('⏳ DSH 未就绪 (' + e.message + ')，5 秒后重试 (' + attempt + '/' + MAX_ATTEMPTS + ')')
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

// 从 item_list 中挑出可下载的媒体项，优先级 IMAGE > FILE > VIDEO（语音暂不处理）
function pickMediaItem(itemList) {
  const hasMedia = (m) => m?.media && (m.media.encrypt_query_param || m.media.full_url)
  return (itemList ?? []).find(
    (i) => i.type === MessageItemType.IMAGE && hasMedia(i.image_item)
  ) ?? (itemList ?? []).find(
    (i) => i.type === MessageItemType.FILE && hasMedia(i.file_item)
  ) ?? (itemList ?? []).find(
    (i) => i.type === MessageItemType.VIDEO && hasMedia(i.video_item)
  )
}

const MEDIA_TYPE_LABEL = {
  [MessageItemType.IMAGE]: '图片',
  [MessageItemType.FILE]: '文件',
  [MessageItemType.VIDEO]: '视频'
}

// 启动桥接；返回 { stop }
// transport: { call(method, payload) → value, frames(onFrame, signal) → Promise }
// 不传 transport 时使用 HTTP/WebSocket（standalone 模式）
// stateFilePath 可注入（测试用），默认 ~/.openclaw/openclaw-weixin/dsh-bridge-state.json
// deps 可注入 vendor 网络函数（测试用），默认使用 vendor 实现
export function startBridge({ cwd, dshBase = 'http://127.0.0.1:3080', log = console.log, transport, media = {}, stateFilePath, deps = {} } = {}) {
  const abort = new AbortController()
  const workCwd = cwd ?? os.homedir()
  const statePath = stateFilePath ?? stateFile()
  const getUpdatesFn = deps.getUpdates ?? getUpdates
  const notifyStartFn = deps.notifyStart ?? notifyStart
  const notifyStopFn = deps.notifyStop ?? notifyStop
  const sendMessageWeixinFn = deps.sendMessageWeixin ?? sendMessageWeixin
  const downloadMediaFromItemFn = deps.downloadMediaFromItem ?? downloadMediaFromItem
  const sendWeixinMediaFileFn = deps.sendWeixinMediaFile ?? sendWeixinMediaFile
  const mediaEnabled = media.enabled !== false
  const maxMediaBytes = media.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES
  const inboxDir = media.inboxDir ?? path.join(workCwd, '.wechat-inbox')
  const outboxTempDir = path.join(workCwd, '.wechat-outbox')
  const call = transport?.call ?? ((method, payload) => dshCall(method, payload, dshBase))
  const frames = transport?.frames ?? ((cb, signal) => dshMux(cb, { base: dshBase, signal }))

  // 账号检查（同步）
  const accountIds = discoverAccounts()
  if (accountIds.length === 0) {
    throw new Error('没有已登录的微信账号，请先运行: npx dsh-plugin-weixin login（或 node scripts/login.mjs）')
  }
  const accountId = pickActiveAccount(accountIds)
  const account = loadWeixinAccount(accountId)
  if (!account?.token) throw new Error('账号凭据缺失，请重新登录')
  restoreContextTokens(accountId)
  if (accountIds.length > 1) {
    log('ℹ️ 发现 ' + accountIds.length + ' 个已登录账号，选最近扫码的那个: ' + accountId)
  }
  log('✅ 微信账号已加载: ' + accountId)
  log('✅ DSH: ' + dshBase + ' | 会话工作目录: ' + workCwd)
  log('✅ 媒体: ' + (mediaEnabled ? '开（接收目录 ' + inboxDir + '）' : '关'))

  // 回复收集状态
  let awaiting = null
  // 最近一个给 bot 发过消息的微信用户 —— 主动通知就发给他。
  // 兜底用凭据里的 userId（= 当初扫码登录的那个人，也就是机主本人）。
  let lastUserId = typeof account.userId === 'string' && account.userId !== '' ? account.userId : null

  function onMuxFrame(frame) {
    if (!awaiting || frame.type !== 'server-request' || frame.method !== 'session/event') return
    const payload = frame.payload
    if (!payload || payload.sessionId !== awaiting.sessionId) return
    const event = payload.event
    if (!event) return
    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? []
      for (const b of blocks) {
        if (b?.type === 'text' && b.text) awaiting.texts.push(b.text)
      }
    } else if (event.type === 'turn/end') {
      const t = awaiting
      awaiting = null
      if (t) t.done(t.texts.join('\n').trim() || '(无文本回复)')
    }
  }

  function askDsh(sessionId, text, call) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const t = awaiting
        awaiting = null
        if (t) resolve(t.texts.join('\n').trim() || '(超时无回复)')
      }, REPLY_TIMEOUT_MS)
      awaiting = {
        sessionId,
        texts: [],
        done: (reply) => { clearTimeout(timeout); resolve(reply) }
      }
      call('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: 'Asia/Shanghai'
      }).catch((e) => {
        const t = awaiting
        awaiting = null
        clearTimeout(timeout)
        if (t) t.done('(DSH 调用失败: ' + e.message + ')')
      })
    })
  }

  function sendText(to, text, contextToken) {
    return sendMessageWeixinFn({
      to,
      text,
      opts: {
        contextToken: contextToken ?? getContextToken(accountId, to),
        baseUrl: account.baseUrl,
        token: account.token,
        timeoutMs: 60_000
      }
    })
  }

  // 把微信发送错误映射为可操作的提示文案
  // （context_token 有次数/时效限制，超出后服务端返回 ret=-2，需用户发新消息刷新）
  function friendlySendError(err) {
    const m = String(err?.message ?? err ?? '')
    if (m.includes('ret=-2')) {
      return '微信会话上下文已过期（ret=-2）：请先给 bot 发一条新消息刷新会话，再重试发送'
    }
    if (m.includes('ret=')) return '微信发送被拒绝：' + m
    return m
  }

  // 串行消息队列
  let queue = Promise.resolve()

  async function handleMessage(full) {
    const from = full.from_user_id ?? ''
    if (!from) return
    const token = full.context_token
    if (token) setContextToken(accountId, from, token)
    if (typeof from === 'string' && from !== '') lastUserId = from

    const texts = []
    for (const item of full.item_list ?? []) {
      if (item?.type === MessageItemType.TEXT && item.text_item?.text != null) {
        texts.push(String(item.text_item.text))
      }
    }
    const text = texts.join('\n').trim()

    // 接收媒体：下载解密并保存到 inbox，路径注入 agent 上下文
    let mediaNote = ''
    if (mediaEnabled) {
      const mediaItem = pickMediaItem(full.item_list)
      if (mediaItem) {
        try {
          const downloaded = await downloadMediaFromItemFn(mediaItem, {
            cdnBaseUrl: CDN_BASE_URL,
            saveMedia: (buf, mime, kind, maxBytes, fileName) =>
              saveInboundMedia(buf, mime, kind, Math.min(maxBytes ?? Infinity, maxMediaBytes), fileName, inboxDir),
            log,
            errLog: log,
            label: 'inbound'
          })
          const savedPath = downloaded.decryptedPicPath ?? downloaded.decryptedFilePath ?? downloaded.decryptedVideoPath
          if (savedPath) {
            const label = MEDIA_TYPE_LABEL[mediaItem.type] ?? '媒体'
            mediaNote = '[微信媒体] 用户发来' + label + '，已保存至 ' + savedPath + '\n'
            log('📎 接收' + label + '已保存: ' + savedPath)
          }
        } catch (e) {
          log('❌ 接收媒体失败: ' + e.message)
        }
      }
    }

    if (!text && !mediaNote) return
    log('📩 微信 [' + from + ']: ' + (text || '[仅媒体]').slice(0, 120))

    let sessionId
    try {
      sessionId = await ensureSession(workCwd, log, call, statePath)
    } catch (e) {
      log('❌ 获取 DSH 会话失败: ' + e.message)
      return
    }

    // 首条消息注入能力提示（持久化标记，避免每次浪费 token）
    let promptText = mediaNote + text
    const state = loadBridgeState(statePath)
    if (mediaEnabled && !state?.mediaHinted) {
      promptText = MEDIA_HINT + '\n\n' + promptText
      saveBridgeState({ ...(state ?? {}), mediaHinted: true }, statePath)
      log('💡 已注入媒体发送能力提示')
    }

    const reply = await askDsh(sessionId, promptText, call)
    log('📤 回复: ' + reply.slice(0, 150))

    const sendOpts = { contextToken: getContextToken(accountId, from) ?? token }
    try {
      const res = await deliverReply({
        to: from,
        text: reply,
        account,
        contextToken: sendOpts.contextToken,
        cwd: workCwd,
        tempDir: outboxTempDir,
        log,
        deps: { sendWeixinMediaFile: sendWeixinMediaFileFn }
      })
      // 无媒体成功发送时，剩余文本作为普通文本回复
      if (res.mediaSent === 0 && res.text) {
        await sendText(from, res.text, sendOpts.contextToken)
      }
      // 媒体发送失败的逐条通知
      for (const f of res.failures) {
        try {
          await sendText(from, '⚠️ 文件发送失败：' + friendlySendError(f.error), sendOpts.contextToken)
        } catch (e) { log('❌ 失败通知发送失败: ' + e.message) }
      }
      log('✅ 已发送回微信')
    } catch (e) {
      log('❌ 发送到微信失败: ' + e.message)
    }
  }

  // 主循环
  ;(async () => {
    try {
      await ensureDshReady(call, log, abort.signal)
      const sessionId = await ensureSession(workCwd, log, call, statePath)
      log('📌 微信消息将进入会话: ' + sessionId)
      log('🚀 桥接已启动，等待微信消息...')
      frames(onMuxFrame, abort.signal).catch(() => {})
      let getUpdatesBuf = loadGetUpdatesBuf(getSyncBufFilePath(accountId)) ?? ''
      try { await notifyStartFn({ baseUrl: account.baseUrl, token: account.token }) } catch {}
      while (!abort.signal.aborted) {
        try {
          const resp = await getUpdatesFn({
            baseUrl: account.baseUrl,
            token: account.token,
            get_updates_buf: getUpdatesBuf,
            timeoutMs: LONG_POLL_MS,
            abortSignal: abort.signal
          })
          if (resp.ret != null && resp.ret !== 0) {
            log('⚠️ getUpdates ret=' + resp.ret + ' ' + (resp.errmsg ?? ''))
            await new Promise(r => setTimeout(r, 5000))
            continue
          }
          if (resp.get_updates_buf != null && resp.get_updates_buf !== '') {
            getUpdatesBuf = resp.get_updates_buf
            saveGetUpdatesBuf(getSyncBufFilePath(accountId), resp.get_updates_buf)
          }
          for (const full of resp.msgs ?? []) {
            if (full.type === MessageType.BOT) continue
            queue = queue.then(() => handleMessage(full).catch((e) => log('消息处理异常: ' + e.message)))
          }
        } catch (e) {
          if (abort.signal.aborted) break
          log('⚠️ getUpdates 异常: ' + e.message)
          await new Promise(r => setTimeout(r, 5000))
        }
      }
    } catch (e) {
      log('❌ 桥接运行失败: ' + e.message)
    }
  })()

  return {
    stop: () => {
      abort.abort()
      try { notifyStopFn({ baseUrl: account.baseUrl, token: account.token }) } catch {}
    },
    /**
     * 主动推一条文本到微信（给「会话干完活」这类通知用）。
     * @returns {Promise<boolean>} 是否发出去了
     */
    async notify(text) {
      const to = lastUserId
      if (to === null) {
        log('⚠️ 还没有任何微信用户发过消息，不知道该通知谁（先随便发一条给 bot 即可）')
        return false
      }
      try {
        await sendText(to, text, getContextToken(accountId, to))
        return true
      } catch (err) {
        // context_token 有次数/时效限制，过期会 ret=-2 —— 需要用户发条新消息刷新
        log('⚠️ 推送失败（多半是 context_token 过期，让用户随便发条微信刷新一下）: ' + (err && err.message))
        return false
      }
    },
    /** 这条会话的 turn 是不是由微信发起的（是的话回复会原路回去，别再推一遍）*/
    isAwaiting(sessionId) {
      return awaiting !== null && awaiting.sessionId === sessionId
    },
    get accountId() { return accountId },
    get notifiedUser() { return lastUserId },
  }
}

// 独立运行入口（node lib/bridge.js）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = startBridge({ cwd: process.env.BRIDGE_CWD })
  process.on('SIGINT', () => { handle.stop(); process.exit(0) })
}
