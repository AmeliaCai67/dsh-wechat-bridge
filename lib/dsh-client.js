// DSH HTTP RPC + WebSocket mux 客户端（已在 dsh-weixin-bridge 实测通过）
const DEFAULT_BASE = 'http://127.0.0.1:3080'

export async function dshCall(method, payload, base = DEFAULT_BASE) {
  const rpcId = crypto.randomUUID()
  const res = await fetch(base + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload })
  })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + method)
  const full = await res.json()
  if (!full.result?.ok) {
    const e = full.result?.error ?? {}
    throw new Error(method + ' 失败: ' + (e.code ?? '') + ' ' + (e.message ?? JSON.stringify(full.result)))
  }
  return full.result.value
}

// 订阅全局事件流（WebSocket 升级端点，帧为纯 JSON），断线自动重连
export async function dshMux(onFrame, { base = DEFAULT_BASE, signal } = {}) {
  const wsUrl = base.replace(/^http/, 'ws') + '/api/events.mux'
  while (!signal?.aborted) {
    const ws = new WebSocket(wsUrl)
    try {
      await new Promise((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('WebSocket 连接失败'))
      })
      ws.onmessage = (ev) => {
        try { onFrame(JSON.parse(String(ev.data))) } catch { /* 非 JSON 帧跳过 */ }
      }
      await new Promise((resolve) => {
        ws.onclose = () => resolve()
        signal?.addEventListener('abort', () => ws.close(), { once: true })
      })
      if (signal?.aborted) return
      await new Promise(r => setTimeout(r, 3000))
    } catch (e) {
      if (signal?.aborted) return
      await new Promise(r => setTimeout(r, 3000))
    }
  }
}
