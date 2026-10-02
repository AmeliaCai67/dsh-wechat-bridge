#!/usr/bin/env node
/**
 * patch-vendor.mjs — 把 vendor 里对 OpenClaw 宿主的 import 改成相对路径
 *
 * ── 为什么必须这么做（2026-10-02 实测踩了两遍）──
 *
 * 腾讯的 openclaw-weixin 编译产物有 8 个文件 `import "openclaw/plugin-sdk/*"`。
 * 我们要给它一个极简的宿主替身（stub），但 **stub 放在 node_modules 里是发不出去的**：
 *
 *   ❌ 顶层 node_modules/openclaw/        —— npm/pnpm 发布时剥掉 node_modules
 *   ❌ vendor/…/node_modules/openclaw/    —— 实测 pnpm 安装时也会剪掉嵌套的 node_modules
 *   ❌ "openclaw": "file:./stubs/openclaw" —— pnpm 把 file: 路径当成【安装目录】的相对路径
 *
 * 实测报错：
 *   [ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND] Could not install from ".../profiles/x/stubs/openclaw"
 *   ERR_MODULE_NOT_FOUND: Cannot find package 'openclaw'
 *
 * ✅ 可行方案：把 bare specifier 改成【相对路径】。相对路径不需要任何 node_modules，
 *    放进包里就一定能解析。
 *
 * ── 这个脚本做什么 ──
 *
 * 扫描 vendor/ 下所有文件，把
 *     from "openclaw/plugin-sdk/<name>"
 *     import("openclaw/plugin-sdk/<name>")
 * 改写成指向 stubs/openclaw/plugin-sdk/<name>.js 的、**按文件层级算好的**相对路径。
 *
 * 幂等：已经改过的文件不会重复改（识别不了 bare specifier 就跳过）。
 *
 * ── 升级上游 vendor 之后 ──
 *
 *     node scripts/patch-vendor.mjs          # 重新打补丁
 *     node scripts/patch-vendor.mjs --check  # 只检查有没有漏网的 bare specifier
 *
 * 作者：小鲸  2026-10-02
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VENDOR = join(ROOT, 'vendor')
const STUB_ROOT = join(ROOT, 'stubs', 'openclaw', 'plugin-sdk')

/** 递归收集文件（跳过 node_modules 和 .map） */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(js|mjs)$/.test(name)) out.push(p)
  }
  return out
}

// 匹配两种写法：`from "spec"` 和 `import("spec")`。
// 也允许单引号。不碰 import("./relative") 这类（根本没匹配上）。
const SPEC_RE = /(from\s*|import\s*\(\s*)(["'])openclaw\/plugin-sdk\/([A-Za-z0-9_-]+)\2/g

function patchFile(file, { check }) {
  const src = readFileSync(file, 'utf8')
  let count = 0
  const out = src.replace(SPEC_RE, (m, prefix, quote, name) => {
    const target = join(STUB_ROOT, name + '.js')
    if (check) {
      count++
      return m
    }
    if (!existsSync(target)) {
      console.error(`  ⚠️ ${relative(ROOT, file)}: 找不到 stub "${name}" —— 保留原样`)
      return m
    }
    // 从【当前文件所在目录】算到 stub 的相对路径，并保证有 ./ 前缀
    let rel = relative(dirname(file), target).split('\\').join('/')
    if (!rel.startsWith('.')) rel = './' + rel
    count++
    return `${prefix}${quote}${rel}${quote}`
  })
  if (count > 0 && !check) writeFileSync(file, out, 'utf8')
  return count
}

const check = process.argv.includes('--check')
const files = walk(VENDOR)

if (!existsSync(STUB_ROOT)) {
  console.error(`❌ 找不到 stub 目录：${relative(ROOT, STUB_ROOT)}`)
  console.error('   它应该随包一起提交。参见 vendor/weixin-dist/README-VENDOR.md。')
  process.exit(2)
}

let total = 0
let touched = 0
for (const f of files) {
  const n = patchFile(f, { check })
  if (n > 0) {
    touched++
    total += n
    console.log(`  ${check ? '待改' : '已改'} ${String(n).padStart(2)} 处  ${relative(ROOT, f)}`)
  }
}

console.log('')
if (check) {
  if (total === 0) {
    console.log('✅ 没有漏网的 bare specifier —— vendor 已全部指向 stubs/。')
    process.exit(0)
  }
  console.log(`❌ 还有 ${total} 处 bare specifier（${touched} 个文件）没改 —— 跑 node scripts/patch-vendor.mjs`)
  process.exit(1)
}
console.log(total === 0
  ? '✅ 无需改动（已经是相对路径了）。'
  : `✅ 改了 ${total} 处，涉及 ${touched} 个文件。`)
