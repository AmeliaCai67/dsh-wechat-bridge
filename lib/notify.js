// lib/notify.js — 会话「干完活」时推微信。
//
// 为什么放在桥里而不是装第三方通知插件：
//   桥已经拿着微信通道（账号凭据 + context_token），复用它是零冲突的。
//   而第三方的微信通知插件要自己扫码登录 iLink bot —— 一个微信只能连一个 bot，会抢通道。
//
// 自检后改过的判据（2026-10-02）：
//   ① 判据从「耗时」改成「这个 turn 【调用过工具】」—— 用耗时是错的：
//      agent 干活快的时候（几秒改完 3 个文件）永远触发不了阈值，通知等于没有。
//      「用过工具」才是「真干了活」的可靠信号。
//   ② 【子代理会话不推】—— 'session/event' 是全局 emit（@dshScopeScan unsupported），
//      子代理的会话事件一样会进来。用 header.delegationDepth > 0 过滤掉，
//      否则每跑一次 subagent 都会往微信推一条。
//   ③ 微信自己发起的 turn 不推 —— 回复已经原路回去了，再推一遍是回声
//   ④ 只在真正结束（completed / blocked / failed / aborted）时推，中途步骤不推
//
// 作者：小鲸  2026-10-02

const ICON = {
  completed: '✅',
  blocked: '⏸',
  aborted: '⏹',
  failed: '❌',
}
const LABEL = {
  completed: '干完了',
  blocked: '停下来等你',
  aborted: '被打断了',
  failed: '出错了',
}

/** 把回复正文压成一句 recap：去掉表情包标记和 MEDIA 指令行，折叠空白，截断。 */
export function makeRecap(text, limit = 120) {
  let s = String(text ?? '')
  s = s.replace(/(^|\n)\s*MEDIA:[^\n]*/g, '\n')          // 去掉媒体指令行
  s = s.replace(/\[表情:[^\]]*\]/g, '')                    // 去掉表情包标记
  s = s.replace(/```[\s\S]*?```/g, '（代码块）')            // 代码块折成占位
  s = s.replace(/\|/g, ' ').replace(/[#*>`_~]/g, '')       // 去掉 markdown 记号
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > limit) s = s.slice(0, limit - 1) + '…'
  return s
}

function humanMs(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + ' 秒'
  const m = Math.floor(s / 60)
  return m + ' 分 ' + (s % 60) + ' 秒'
}

/**
 * 挂上「完成即推微信」。
 * @param ctx - DSH 插件上下文
 * @param options.handle - startBridge() 的返回值（要有 notify / isAwaiting）
 * @param options.log - 日志函数
 * @param options.config - { enabled, minDurationMs, boundSessionId }
 * @returns 卸载函数
 */
export function installCompletionNotify(ctx, { handle, log, config }) {
  if (!config?.enabled) return () => {}

  const minMs = Number(config.minDurationMs ?? 120_000)
  const minTools = Number(config.minToolCalls ?? 1)
  const titles = new Map()
  const startedAt = new Map()
  const lastText = new Map()
  const toolCalls = new Map()
  const MAX_TRACKED = 400 // 顺手修：别让这些表随时间无限长

  const off = ctx.on('session/event', (session, event) => {
    const sid = session?.id
    if (typeof sid !== 'string') return
    const data = event?.data ?? {}

    if (event.type === 'session/title') {
      if (typeof data.title === 'string' && data.title !== '') titles.set(sid, data.title)
      return
    }

    if (event.type === 'turn/start') {
      startedAt.set(sid, Date.now())
      lastText.set(sid, '')
      toolCalls.set(sid, 0)
      if (titles.size > MAX_TRACKED) titles.clear()
      if (lastText.size > MAX_TRACKED) lastText.clear()
      return
    }

    // 这个 turn 里调用过几次工具 —— 「真干了活」的判据
    if (event.type === 'tool/call') {
      toolCalls.set(sid, (toolCalls.get(sid) ?? 0) + 1)
      return
    }

    if (event.type === 'assistant/message') {
      const blocks = data.message?.content
      if (!Array.isArray(blocks)) return
      const text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text !== '')
        .map((b) => b.text)
        .join('\n')
      if (text !== '') lastText.set(sid, text)
      return
    }

    if (event.type !== 'turn/end') return

    // 子代理不推 —— 'session/event' 是全局的，subagent 的事件也会到这里。
    // 不过滤的话，每跑一次 subagent 都会往微信推一条。
    const depth = session.header?.delegationDepth
    const isSubagent = typeof depth === 'number' && depth > 0

    // 微信自己发起的 turn —— 回复会原路回去，别再推（回声）
    const fromWechat = handle.isAwaiting(sid)

    // 本会话默认不推 —— 你一般就在看着它
    const isBound = config.boundSessionId !== undefined && sid === config.boundSessionId

    const t0 = startedAt.get(sid)
    startedAt.delete(sid)
    const elapsed = typeof t0 === 'number' ? Date.now() - t0 : 0
    const tools = toolCalls.get(sid) ?? 0
    toolCalls.delete(sid)

    const kind = data.reason?.kind ?? 'completed'

    if (isSubagent) { log('跳过通知（子代理会话）'); return }
    if (fromWechat) { log('跳过通知（微信发起的 turn，回复已原路返回）'); return }
    if (isBound && config.notifyBoundSession !== true) { log('跳过通知（本会话，默认不推）'); return }
    // 判据：调用过工具 = 真干了活；或者长时间思考（兜底）
    if (tools < minTools && elapsed < minMs) return
    // 只在有意义的终态推
    if (!(kind in ICON)) return

    const title = titles.get(sid) ?? sid
    const recap = makeRecap(lastText.get(sid) ?? '')
    const lines = [
      `${ICON[kind]} ${title} ${LABEL[kind]}`,
      `⏱ ${humanMs(elapsed)}` + (tools > 0 ? ` ｜ 🔧 ${tools} 步` : ''),
    ]
    if (recap !== '') lines.push('💬 ' + recap)
    // 非本会话的，把 session id 附上，方便回 DSH 里找
    if (sid !== config.boundSessionId) lines.push('🔗 ' + sid)

    const body = lines.join('\n')
    handle.notify(body).then((ok) => {
      log(ok ? `📤 已推送完成通知：${title}` : `⚠️ 完成通知没发出去：${title}`)
    })
  })

  log(`完成通知已开启（用过工具或 ≥ ${humanMs(minMs)} 的 turn 才推；子代理 / 微信发起的 / 本会话都不推）`)
  return off
}
