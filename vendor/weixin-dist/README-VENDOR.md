# 这个目录是 vendor 进来的第三方代码

来源：**[@tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) v2.4.9**（2026-09-17 发布）
版权：Copyright (C) 2026 Tencent. 许可证：**MIT**（见同目录 `LICENSE`）

## 为什么是 vendor 而不是依赖

官方包是**给 OpenClaw 宿主写的插件**（`peerDependencies: { openclaw: ">=2026.5.12" }`，
入口 `index.js` 里 `api.registerChannel(...)`），**不能作为一个独立库被 import**
（`package.json` 没有 `main`/`exports`，根目录也没有 `index.js`）。

但我们对它的用法只碰 8 个模块，而它对宿主的依赖**只有 6 个具名符号**。
所以本仓库：

1. 原样复制它的**编译产物** `dist/`（不改一行代码）；
2. 在 `node_modules/openclaw/plugin-sdk/` 放 **8 个 stub**（共约 20 行）顶替 OpenClaw 宿主。

这样它就彻底脱离 OpenClaw 独立运行了。

## 改动说明

**零改动** —— 本目录下的 `.js` 与上游 `dist/` 逐字节相同。
唯一的差别是**多了一个 `package.json`**：上游把它放在包根，而
`api.ts` 的 `readPackageJsonFromDir()` 会从 `import.meta.url` 向上找带 `ilink_appid`
的 package.json；不放进这个目录的话，请求头里的 `iLink-App-Id` 会是空字符串。

## 升级上游

```bash
npm pack @tencent-weixin/openclaw-weixin@<版本>
tar xzf tencent-weixin-openclaw-weixin-<版本>.tgz
rm -rf vendor/weixin-dist
cp -R package/dist vendor/weixin-dist
cp package/package.json vendor/weixin-dist/package.json
cp package/LICENSE vendor/weixin-dist/LICENSE
```

然后跑一遍 `npm test`（会核对 8 个模块的导出是否仍然齐全）。

---

## 我们对上游做的唯一改动（2026-10-02）

**改了 7 个文件里的 12 处 import 语句**，把对 OpenClaw 宿主的裸包名引用改成了相对路径：

```diff
- import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
+ import { normalizeAccountId } from "../../../../stubs/openclaw/plugin-sdk/account-id.js";
```

**除了这些 import 路径，一行代码都没动**（逻辑、常量、注释全部保持原样）。

### 为什么非改不可

腾讯代码 import 的 `openclaw/plugin-sdk/*` 需要一个宿主替身，而**替身放进 `node_modules`
是发不出去的** —— 实测三条路全堵：

| 做法 | 结果 |
|---|---|
| 顶层 `node_modules/openclaw/` | ❌ npm/pnpm 发布时剥掉 `node_modules` |
| `vendor/…/node_modules/openclaw/` | ❌ pnpm 安装时把嵌套的 `node_modules` 也剪掉（实测 `ERR_MODULE_NOT_FOUND`） |
| `"openclaw": "file:./stubs/openclaw"` | ❌ pnpm 把 `file:` 当成【安装目录】的相对路径：`ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND` |

**相对路径不需要任何 `node_modules`，放进包里就一定能解析。**

### 升级上游之后

```bash
# 1. 用新版覆盖 vendor/weixin-dist/ 的内容（保留本文件、LICENSE、package.json）
# 2. 重新打补丁
node scripts/patch-vendor.mjs
# 3. 确认没有漏网的裸包名
node scripts/patch-vendor.mjs --check
# 4. 跑自检
node scripts/selftest.mjs
```

`scripts/patch-vendor.mjs` 会按每个文件所在的层级自动算好相对路径，是幂等的。
