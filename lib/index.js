// dsh-wechat-bridge — 自己的微信桥（host half），替代已停更的 @ccchase/dsh-plugin-wechat。
//
// 组成：
//   vendor/weixin-dist/   腾讯官方 @tencent-weixin/openclaw-weixin@2.4.9 的编译产物（原样 vendor）
//   node_modules/openclaw/  OpenClaw 宿主的极简替身（8 个 stub，腾讯代码只用到那几个符号）
//   lib/native-transport.js 0.2.0 原生传输：agent.followup 投递 + session/event 收回复
//   lib/bridge.js           主循环：getUpdates 长轮询 → DSH → 发回微信（移植自旧壳子）
//
// 组合行（~/.dsh/profiles/web/cordis.patch.yml）：
//   - insert:
//       - id: wechat-bridge
//         name: '../../plugins/dsh-wechat-bridge/lib/index.js'
//         config:
//           sessionId: <要接进的 DSH 会话 id>     # 省略则读状态文件 / 新建
//
// 作者：小鲸  2026-10-01

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { startBridge } from './bridge.js'
import { makeNativeTransport } from './native-transport.js'
import { installCompletionNotify } from './notify.js'

/** 桥的状态文件（和 bridge.js 用的是同一个）：里面记着要接进哪个 DSH 会话。 */
function readBridgeState() {
  try {
    const p = path.join(os.homedir(), '.openclaw', 'openclaw-weixin', 'dsh-bridge-state.json')
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

export const name = 'wechat-bridge'
export const inject = ['agents', 'sessions']

const DEFAULTS = {
  /** 桥接落在哪个工作目录（收发的媒体文件放这儿）。默认主目录。 */
  cwd: os.homedir(),
  /** 是否随插件启动自动跑桥。 */
  autoStart: true,
  /** 接收媒体保存目录；默认 <cwd>/.wechat-inbox */
  mediaInboxDir: undefined,
  /** 媒体收发总开关。 */
  mediaEnabled: true,
  /** 单条接收媒体大小上限（字节）；默认 100MB（腾讯端上限）。 */
  maxMediaBytes: 100 * 1024 * 1024,
  /** 会话干完活时推一条微信（需要用户最近给 bot 发过消息，否则 context_token 已过期）。 */
  notifyOnComplete: true,
  /** 这个 turn 里调用过几次工具才推（「真干了活」的判据）。0 = 只要结束就推。 */
  notifyMinToolCalls: 1,
  /** 兜底：没用工具但耗时超过这个数（长时间思考）也推。 */
  notifyMinDurationMs: 120_000,
  /** 本会话要不要也推 —— 默认不推，你一般就在看着它。 */
  notifyBoundSession: false,
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  if (!config.autoStart) {
    console.log('[wechat-bridge] autoStart=false，不启动')
    return
  }

  const log = (...args) => {
    const line = '[wechat-bridge] ' + args.map(String).join(' ')
    try { ctx.logger?.info?.(line) } catch { /* 没有 logger 就算了 */ }
    console.log(line)
  }

  ctx.effect(() => {
    let handle
    // ★ 钉死会话：桥可能在 DSH 启动瞬间跑，那时目标会话还不是 live 的，
    //   ctx.sessions.list() 会是空的 —— 必须从状态文件把 sessionId 直接喂给 transport。
    // ⚠️ 这两个声明必须在 try【外面】：notify 那段也要用 pinnedSessionId，
    //    写在 try 里会 ReferenceError 把整个 apply 打挂（2026-10-02 踩过，桥整个没起来）。
    const state = readBridgeState()
    const pinnedSessionId = config.sessionId ?? state.sessionId
    try {
      log('钉住的会话: ' + (pinnedSessionId ?? '(无，将由 bridge 自行决定)'))

      handle = startBridge({
        cwd: config.cwd,
        log,
        transport: makeNativeTransport(ctx, { pinnedSessionId, cwd: config.cwd }),
        media: {
          enabled: config.mediaEnabled,
          inboxDir: config.mediaInboxDir,
          maxBytes: config.maxMediaBytes,
        },
      })
    } catch (err) {
      log('启动失败: ' + (err && err.message))
      return () => {}
    }
    // 「会话干完活 → 推微信」。放在桥里而不是装第三方通知插件：
    // 第三方要自己扫码登录 iLink bot，一个微信只能连一个 bot，会跟本桥抢通道。
    const offNotify = installCompletionNotify(ctx, {
      handle,
      log,
      config: {
        enabled: config.notifyOnComplete,
        minToolCalls: config.notifyMinToolCalls,
        minDurationMs: config.notifyMinDurationMs,
        notifyBoundSession: config.notifyBoundSession,
        boundSessionId: pinnedSessionId,
      },
    })

    return () => { try { offNotify?.() } catch {}; try { handle?.stop?.() } catch {} }
  }, 'wechat-bridge')

  console.log('[wechat-bridge] 已加载（自己写的桥；vendor 腾讯 2.4.9）')
}

export default { name, inject, apply }
