# dsh-wechat-bridge

> 在微信里跟你的 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）会话对话。
> **支持 DSH 0.2.0**。文字 / 图片 / 文件双向收發。

原来有个第三方插件 `@ccchase/dsh-plugin-wechat` 做这件事，但**作者从 2026-08-14 之后就没再维护过
（连 repository 字段都没留），在 DSH 0.2.0 上直接起不来** —— 它 `inject` 的 `apiProxy` 服务在新版里没了。

这个包是重写的替代品。**它不复刻那个壳子，而是直接 vendor 腾讯官方仍在维护的协议层。**

---

## 它怎么工作

```
你的微信
  → 腾讯 iLink Bot（HTTP 长轮询 getUpdates）
  → vendor/weixin-dist/   腾讯官方 @tencent-weixin/openclaw-weixin 的编译产物（原样，零改动）
  → lib/bridge.js         主循环：收 → 投给 DSH → 收回复 → 发回微信
  → lib/native-transport.js  DSH 0.2.0 原生传输
  → 你的 DSH 会话
```

### 两个关键设计

**① 为什么 vendor 腾讯代码，而不是 `npm i` 它**

官方包是个 **OpenClaw 宿主插件**（`peerDependencies: { openclaw: ">=2026.5.12" }`），
不能当独立库 import（`package.json` 没有 `main`/`exports`，根目录也没有 `index.js`）。

但我们对它的用法只碰 **8 个模块**，而它对宿主的依赖**只有 6 个具名符号**。
所以本仓库原样复制它的编译产物，再用 **8 个 stub（共约 20 行）** 顶替 OpenClaw 宿主。
详见 [`vendor/weixin-dist/README-VENDOR.md`](vendor/weixin-dist/README-VENDOR.md)。

**② 为什么不用 `apiProxy`**

旧壳子走 `ctx.apiProxy` —— 那层 RPC 信封在 DSH 0.2.0 里被移除了。
0.2.0 有更直接的进程内 API：

```js
投消息  → agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
收回复  → ctx.on('session/event', (session, event) => …)
列会话  → ctx.sessions.list()      （注意：只列【活着的】会话）
拿 agent → ctx.agents.get(id)
```

---

## 安装

### 一条命令（推荐）

```bash
dsh plugin --profile web add github:AmeliaCai67/dsh-wechat-bridge
```

官方 CLI 会装包，看到包内声明的 **`dsh.bundle`** 就把它加进 `dsh.profile.bundles`，
并在启动时合并**包内自带**的 `cordis.patch.yml` —— **不用手改任何 profile 文件。**

> ⚠️ 如果你之前已经手写过下面「手动挂载」那段 `insert`，**切换过来前先删掉它** ——
> 否则会挂载两次（两个桥实例抢同一个微信账号的消息）。

### 然后做两件事

**① 登录**（首次扫码一次，凭据存到 `~/.openclaw/openclaw-weixin/accounts/`，之后不用再扫）

```bash
node scripts/login.mjs
```

**② 告诉桥「消息进哪个会话」**

```bash
echo '{"sessionId":"session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}' \
  > ~/.openclaw/openclaw-weixin/dsh-bridge-state.json
```

会话 id 可以从 DSH Web 的 URL、或 `~/.dsh/sessions/` 下的目录名里找到。

> ⚠️ **为什么必须手动指定**：桥需要知道微信消息要进哪个 DSH 会话。
> 不指定的话它会尝试**新建一个专用会话**，而**新建会话目前还没实现**
> （见下方限制清单 —— 需要先搞定 agent preset 的组合，是个已知的待办）。
> 所以现在这一步是必需的，不是可选的。

**③ 重启 DSH**，然后从微信给自己发一条消息。

### 手动挂载（备选）

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: wechat-bridge
      # ⚠️ 必须用【相对路径】：裸包名要靠 pnpm 的依赖图解析，
      #    而 DSH 的热重载不会重建依赖图。
      # ⚠️ 也千万别加 ?v=1 —— 0.2.0 会把 ? 编码成 %3F 导致 import 失败。
      name: '../../plugins/dsh-wechat-bridge/lib/main.js'
      config:
        cwd: '/Users/you'          # 收发的媒体文件落在这里
        autoStart: true
```

---

## 会话干完活推微信

**默认开启。** 任何**会话**的一个 turn 结束时，推一条微信：

```
✅ 给塔卡加语音输入 干完了
⏱ 3 分 12 秒
💬 搞定了，改了 3 个文件，冒烟全过。
🔗 session-1a2b3c4d-…
```

**判据是「这个 turn 调用过工具」，不是耗时** —— 用耗时当判据是错的：agent 干活快的时候
（几秒改完 3 个文件）永远触发不了阈值，通知等于没有。**「用过工具」才是「真干了活」的可靠信号。**

**五条克制的规则**（避免变成刷屏器）：

| 规则 | 为什么 |
|---|---|
| **只推调用过工具的 turn**（`notifyMinToolCalls: 1`） | 纯聊天不打扰你 |
| **子代理会话不推** | `session/event` 是全局 emit，subagent 的事件也会进来 —— 不过滤的话每跑一次子代理都推一条 |
| **微信自己发起的 turn 不推** | 回复已经原路发回微信了，再推一遍是回声 |
| **本会话默认不推**（`notifyBoundSession: false`） | 你一般就在看着它 |
| **只在真终态推**（完成 / 等你 / 打断 / 出错） | 中途步骤不推 |

**配置**：

```yaml
config:
  notifyOnComplete: true        # 总开关
  notifyMinToolCalls: 1         # 调用过几次工具才推（0 = 只要结束就推）
  notifyMinDurationMs: 120000   # 兜底：没用工具但耗时超过这个数也推
  notifyBoundSession: false     # 本会话要不要也推
```

**⚠️ 它依赖 `context_token`，而这个 token 有次数/时效限制。** 过期后推送会失败（服务端 `ret=-2`）。
**随手给 bot 发条微信就能刷新**，然后继续用。所以它更适合「你刚发过消息、然后去忙别的」这种节奏。

**为什么不做成独立插件**：第三方的微信通知插件（如 `dsh-notify-plugin`）要**自己扫码登录 iLink bot** ——
而一个微信只能连一个 bot、且连接后不可重复扫码。**它会跟本桥抢通道。** 复用桥已有的账号是零冲突的。

## 已知限制（诚实清单）

| 限制 | 说明 |
|---|---|
| **会话必须先在 Web 里打开着** | 冷恢复（浏览器关着时也能用）需要把 `agentPresets.resolve` + `mount` + 会话的模型选择一起传给 `ctx.agents.resume()`；**目前没实现**，没有活着的 agent 时桥会明确拒绝而不是建出坏 agent。**这是现在最大的短板。** |
| 完成通知依赖 context_token | 过期后推不出去，需要你给 bot 发条消息刷新（见上一节）。 |
| 不能自动建新会话 | `session.create` 未实现。桥固定接进 `dsh-bridge-state.json` 里指定的那个会话。 |
| 只在 macOS 上验证过 | Node v24.13.0 + DSH 0.2.0-rc.2 + 一个真实微信账号。其它环境未测试。 |
| 群聊未验证 | 腾讯的 `WeixinMessage` 里有 `group_id`，但上游 `channel.ts` 的 `capabilities.chatTypes` 只声明了 `["direct"]`。 |
| `[表情: …]` 是 Web 专用 | 微信里要发图，在回复中独占一行写 `MEDIA:<文件绝对路径>` 或 `MEDIA:<https图片链接>`。 |

---

## 媒体

**收**：微信发来的图片/文件/视频会下载解密后落盘到 `<cwd>/.wechat-inbox/`，然后作为附件进会话。

**发**：在你的回复中**独占一行**写：

```
MEDIA:/absolute/path/to/photo.png
MEDIA:https://example.com/image.jpg
```

该指令行不会显示给用户。你也可以在 `MEDIA:` 那一行同时带上文字，会先发一条文本再发媒体。

---

## 致谢

- 协议层：[`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)（Tencent，MIT）
- `lib/bridge.js` / `lib/media.js` / `lib/inbox.js` 移植自 [`@ccchase/dsh-plugin-wechat`](https://www.npmjs.com/package/@ccchase/dsh-plugin-wechat) 的设计（作者已停更，未留仓库地址）。感谢原作者把收发循环写清楚了。

## 许可证

MIT（见 [`LICENSE`](LICENSE)）。分发包含腾讯的 MIT 代码，其许可证见 [`vendor/weixin-dist/LICENSE`](vendor/weixin-dist/LICENSE)。
