#!/usr/bin/env node
// 自检：确认 vendor 的腾讯代码还能加载、8 个 stub 齐全、接口没变。
// 升级 vendor 之后请跑一次 —— 上游改名/删除导出会在这里被抓住。
//
//   node scripts/selftest.mjs
//
// 作者：小鲸  2026-10-01

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const NEEDED = {
  '../vendor/weixin-dist/src/auth/accounts.js': ['registerWeixinAccountId', 'loadWeixinAccount', 'CDN_BASE_URL', 'listIndexedWeixinAccountIds', 'resolveWeixinAccount'],
  '../vendor/weixin-dist/src/api/api.js': ['getUpdates', 'notifyStart', 'notifyStop'],
  '../vendor/weixin-dist/src/messaging/send.js': ['sendMessageWeixin'],
  '../vendor/weixin-dist/src/media/media-download.js': ['downloadMediaFromItem'],
  '../vendor/weixin-dist/src/storage/sync-buf.js': ['getSyncBufFilePath', 'loadGetUpdatesBuf', 'saveGetUpdatesBuf'],
  '../vendor/weixin-dist/src/messaging/inbound.js': ['restoreContextTokens', 'setContextToken', 'getContextToken'],
  '../vendor/weixin-dist/src/api/types.js': ['MessageItemType', 'MessageType'],
  '../vendor/weixin-dist/src/messaging/send-media.js': ['sendWeixinMediaFile'],
  '../vendor/weixin-dist/src/cdn/upload.js': ['downloadRemoteImageToTemp'],
  '../vendor/weixin-dist/src/auth/login-qr.js': ['startWeixinLoginWithQr', 'waitForWeixinLogin', 'displayQRCode'],
  '../lib/native-transport.js': ['makeNativeTransport'],
  '../lib/bridge.js': ['startBridge'],
}

let fail = 0
const ok = (m) => console.log('  ✅ ' + m)
const bad = (m) => { fail++; console.log('  ❌ ' + m) }

console.log('\n── 模块与导出 ──')
for (const [path, names] of Object.entries(NEEDED)) {
  try {
    const m = await import(path)
    const missing = names.filter((n) => !(n in m))
    if (missing.length === 0) ok(`${path.replace('../vendor/weixin-dist/src/', '')}  ${names.length} 个导出齐全`)
    else bad(`${path} 缺少导出：${missing.join(', ')}`)
  } catch (err) {
    bad(`${path} 加载失败：${(err.message || '').split('\n')[0]}`)
  }
}

console.log('\n── OpenClaw 宿主 stub ──')
const STUBS = {
  'account-id': ['normalizeAccountId'],
  'channel-config-schema': ['buildChannelConfigSchema'],
  'channel-message': ['createTypingCallbacks'],
  'command-auth': ['resolveSenderCommandAuthorizationWithRuntime', 'resolveDirectDmAuthorizationOutcome'],
  'config-runtime': ['loadConfig', 'writeConfigFile'],
  'hook-runtime': ['fireAndForgetHook', 'buildCanonicalSentMessageHookContext', 'toPluginMessageContext', 'toPluginMessageSentEvent'],
  'infra-runtime': ['resolvePreferredOpenClawTmpDir', 'withFileLock'],
  'plugin-runtime': ['getGlobalHookRunner'],
}
for (const [sub, names] of Object.entries(STUBS)) {
  try {
    const m = await import(`../node_modules/openclaw/plugin-sdk/${sub}.js`)
    const missing = names.filter((n) => !(n in m))
    if (missing.length) bad(`${sub} 缺少：${missing.join(', ')}`)
    else ok(sub)
  } catch (err) {
    bad(`${sub} 加载失败：${(err.message || '').split('\n')[0]}`)
  }
}

console.log('\n── 三个必须成立的契约 ──')
try {
  const { normalizeAccountId } = await import('../node_modules/openclaw/plugin-sdk/account-id.js')
  normalizeAccountId('a@im.bot') === 'a@im.bot'
    ? ok('normalizeAccountId 恒等（改了会让 sync 游标另存一份，出两套状态）')
    : bad('normalizeAccountId 不是恒等 —— 必须原样返回！')
} catch (e) { bad('normalizeAccountId 检查失败：' + e.message) }

try {
  const { getGlobalHookRunner } = await import('../node_modules/openclaw/plugin-sdk/plugin-runtime.js')
  const r = getGlobalHookRunner()
  ;(typeof r?.hasHooks === 'undefined')
    ? ok('getGlobalHookRunner 没有 hasHooks（有了上游会去跑不存在的 hook）')
    : bad('getGlobalHookRunner 返回了 hasHooks —— 上游会误判')
} catch (e) { bad('getGlobalHookRunner 检查失败：' + e.message) }

try {
  const { withFileLock } = await import('../node_modules/openclaw/plugin-sdk/infra-runtime.js')
  const v = await withFileLock('/tmp/x', { timeoutMs: 1 }, async () => 'ok')
  v === 'ok' ? ok('withFileLock 支持三参数 (path, options, fn)') : bad('withFileLock 返回值不对')
} catch (e) { bad('withFileLock 三参数调用失败：' + e.message) }

console.log('\n── vendor 包装信息（App-Id 依赖它）──')
// api.js 的 readPackageJsonFromDir 会从 import.meta.url 向上 walk 找带 ilink_appid 的 package.json；
// 找不到的话请求头里的 iLink-App-Id 会是空串。这里直接读文件确认，不走那个 walk（它有 cwd 前提）。
try {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const pkgPath = path.join(root, 'vendor', 'weixin-dist', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.ilink_appid
    ? ok(`vendor/weixin-dist/package.json → ilink_appid=${pkg.ilink_appid}, version=${pkg.version}`)
    : bad('vendor/weixin-dist/package.json 里没有 ilink_appid —— 请求头 iLink-App-Id 会是空的！')
} catch (err) {
  bad('读 vendor/weixin-dist/package.json 失败：' + (err.message || '').split('\n')[0])
}

console.log('\n── apply() 冒烟（★ 这一段是补的洞）──')
// 为什么必须有这段：2026-10-02 我在 index.js 里把 pinnedSessionId 声明写进了 try 块、
// 却在 try 外面用，apply 一抛 ReferenceError 整个插件就没挂上 —— 桥整个死了。
// 而当时的自检只 import 模块（模块能 import 成功），完全抓不到这个错。
// 所以：**必须用 mock ctx 真跑一遍 apply**。
try {
  const mod = await import('../lib/index.js')
  const disposers = []
  const mockCtx = {
    logger: { info: () => {} },
    effect: (fn) => { const d = fn(); disposers.push(d); return d },
    on: () => () => {},
    sessions: { list: () => [] },
    agents: { get: () => undefined, list: () => [] },
    get: () => undefined,
  }
  let applyError = null
  try {
    mod.apply(mockCtx, { cwd: os.tmpdir(), autoStart: true })
  } catch (err) {
    applyError = err
  }
  if (applyError === null) ok(`apply() 跑通，注册了 ${disposers.length} 个 disposer`)
  else bad(`apply() 抛错：${applyError.message}`)
  for (const d of disposers) { try { await d?.() } catch {} }
} catch (err) {
  bad('apply 冒烟测试本身出错：' + (err.message || '').split('\n')[0])
}

console.log(fail === 0 ? '\n🎉 全部通过\n' : `\n💥 ${fail} 项失败\n`)
process.exit(fail === 0 ? 0 : 1)
