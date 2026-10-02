// 0.2.0 原生 transport —— 替代旧版的 apiProxy。
//
// 旧版（0.1.x）通过 ctx.apiProxy 走一层 RPC 信封；0.2.0 把它拿掉了，
// 但进程内有更直接的 API：
//   投消息  → ctx.agents.get(id).followup(createUserMessage({ content, source }))
//   收回复  → ctx.on('session/event', (session, event) => …)
//
// bridge.js 只依赖 transport 的四个约定，所以只需要这一层适配：
//   call('session.list')   → { items: [{ sessionId }] }
//   call('session.create') → { sessionId }
//   call('session.prompt') → 把 content 投给该会话
//   frames(onFrame, sig)   → 推 { type:'server-request', method:'session/event', payload:{ sessionId, event } }
//
// 作者：小鲸  2026-10-01

import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * @param ctx - DSH 插件上下文
 * @param options.pinnedSessionId - 钉死的会话 id（来自桥的状态文件）。
 *   ★ 为什么必须钉：ctx.sessions.list() 是「All LIVE sessions」—— 只列活着的会话。
 *   而桥是在 DSH 启动瞬间跑的，那时用户还没打开浏览器，目标会话还不是 live 的，
 *   列表就是空的 → 桥会以为会话不存在、退到 session.create → 启动失败。
 *   钉死之后就不依赖列表和启动时序了。
 */
export function makeNativeTransport(ctx, options = {}) {
  const pinnedSessionId = typeof options.pinnedSessionId === 'string' ? options.pinnedSessionId : undefined

  /**
   * 拿到某个会话的 agent。
   *
   * ★ 只在 agent【活着】的时候用它。绝不裸 resume —— 这是 2026-10-01 踩的坑：
   *   `ctx.systemPrompt.variable("model", c => c.agent?.options.model)`，
   *   而裸 `resume({ resumeSessionId })` 建出来的 agent 没有 model → `{{model}}` 取不到值
   *   → 严格插值直接抛 “prompt variable "{{model}}" has no value”，整轮报错。
   *
   *   正确做法（Web 控制器 dsh-api-session-controller 的 resumeObserved 就是这么干的）：
   *     const presets = ctx.get('agentPresets')
   *     const setup = async (agentCtx, agent) => {
   *       installSelection(agent)                       // 把会话的模型选择装回 agent.options
   *       await presets.mount(agentCtx, resolvedPresetId)
   *     }
   *     await ctx.agents.resume({ resumeSessionId, agentOptions, setup })
   *   还要先从会话里读出它用的 presetId。等有把握了再补；在那之前宁可拒绝。
   */
  async function agentFor(sessionId) {
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const err = new Error(
      '会话 ' + sessionId + ' 现在没有活着的 agent。冷恢复需要预设组合（agentOptions + ' +
      'agentPresets.mount），本轮先拒绝，免得建出一个没有模型的坏 agent（会让 {{model}} 取不到值）。' +
      '请先在 DSH Web 里打开这个会话，然后再发微信。'
    )
    err.code = 'NO_LIVE_AGENT'
    throw err
  }

  return {
    async call(method, payload) {
      switch (method) {
        case 'session.list': {
          // 注意：ctx.sessions.list() 只给【活着的】会话。启动瞬间可能一个都没有，
          // 所以把钉死的那个会话补进去 —— 让 ensureSession 能认出「它还在」。
          const items = ctx.sessions.list().map((s) => ({
            sessionId: s.id,
            cwd: s.header.cwd,
          }))
          if (pinnedSessionId !== undefined && !items.some((it) => it.sessionId === pinnedSessionId)) {
            items.unshift({ sessionId: pinnedSessionId, cwd: options.cwd, pinned: true })
          }
          return { items }
        }

        case 'session.prompt': {
          const sessionId = payload?.sessionId
          if (!sessionId) throw new Error('session.prompt 缺少 sessionId')
          const agent = await agentFor(sessionId)
          const message = createUserMessage({
            content: payload.content ?? [{ type: 'text', text: '' }],
            source: { kind: 'user' },
          })
          agent.followup(message)
          return { messageId: message.id, sessionId }
        }

        case 'session.create':
          // 阶段二再做：现在桥接固定接进一个已有会话，不新建。
          throw new Error('session.create 暂未实现（桥接接进已有会话即可）')

        default:
          throw new Error('native-transport 不认识的方法: ' + method)
      }
    },

    async frames(onFrame, signal) {
      const off = ctx.on('session/event', (session, event) => {
        try {
          onFrame({
            type: 'server-request',
            method: 'session/event',
            payload: { sessionId: session.header.id, event },
          })
        } catch (err) {
          /* 单帧失败不该拖垮事件流 */
        }
      })
      if (signal !== undefined) {
        signal.addEventListener('abort', () => { try { off?.() } catch {} }, { once: true })
      }
      return off
    },
  }
}
