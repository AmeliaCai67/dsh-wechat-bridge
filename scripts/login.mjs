#!/usr/bin/env node
// 首次登录：用手机微信扫码一次。凭据存到 ~/.openclaw/openclaw-weixin/accounts/，之后长期有效。
//
//   node scripts/login.mjs            # 已登录则直接退出
//   node scripts/login.mjs --force    # 强制重新扫码
//
// 作者：小鲸  2026-10-01
import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  displayQRCode,
} from '../vendor/weixin-dist/src/auth/login-qr.js'
import {
  DEFAULT_BASE_URL,
  saveWeixinAccount,
  registerWeixinAccountId,
  listIndexedWeixinAccountIds,
} from '../vendor/weixin-dist/src/auth/accounts.js'

const apiBaseUrl = process.env.OPENCLAW_WEIXIN_BASE_URL ?? DEFAULT_BASE_URL
const force = process.argv.includes('--force')

const existing = listIndexedWeixinAccountIds()
if (existing.length > 0 && !force) {
  console.log(`已经登录过了：${existing.join(', ')}`)
  console.log('凭据在 ~/.openclaw/openclaw-weixin/accounts/。要重新扫码请加 --force。')
  process.exit(0)
}

console.log('正在向腾讯申请登录二维码…')
const start = await startWeixinLoginWithQr({ apiBaseUrl, verbose: true, force: true })
await displayQRCode(start.qrcodeUrl)
console.log('\n请用手机微信扫码（5 分钟内有效）…\n')

const res = await waitForWeixinLogin({
  sessionKey: start.sessionKey,
  apiBaseUrl,
  timeoutMs: 5 * 60_000,
  verbose: true,
})

if (!res.connected && res.alreadyConnected !== true) {
  console.error('\n❌ 登录失败：' + res.message)
  process.exit(1)
}

if (res.accountId !== undefined) {
  saveWeixinAccount(res.accountId, {
    token: res.botToken,
    baseUrl: res.baseUrl ?? apiBaseUrl,
    userId: res.userId,
  })
  registerWeixinAccountId(res.accountId)
  console.log(`\n✅ 登录成功，账号：${res.accountId}`)
  console.log('   凭据已存到 ~/.openclaw/openclaw-weixin/accounts/')
  console.log('\n下一步：把要接进的 DSH 会话 id 写进')
  console.log('   ~/.openclaw/openclaw-weixin/dsh-bridge-state.json')
  console.log('   形如 {"sessionId":"session-xxxx-…"}')
} else {
  console.log(`\nℹ️  ${res.message}`)
  console.log('    （服务端说这个 bot 已经绑定过了，本地凭据仍然有效，可以直接用。）')
}
