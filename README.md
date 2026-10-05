# dsh-wechat-bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13.0-brightgreen.svg)](package.json)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.0-4D6BFE.svg)](#requirements)
[![WeChat](https://img.shields.io/badge/WeChat-iLink%20Bot-07C160.svg)](#how-it-works)
[![Tested on macOS](https://img.shields.io/badge/tested%20on-macOS-lightgrey.svg)](#known-limitations)

**English** ｜ [中文](./README.zh_CN.md)

> Talk to your [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) (DeepSeek Harness) sessions
> from WeChat. Text, images and files — both directions.

```bash
dsh plugin --profile web add github:AmeliaCai67/dsh-wechat-bridge
```

---

## Why this exists

There was a third-party plugin, `@ccchase/dsh-plugin-wechat`, that did this. **Its author stopped
publishing on 2026-08-14** (the package doesn't even carry a `repository` field) and **it cannot
start on DSH 0.2.0 at all** — the `apiProxy` service it injects no longer exists.

This package is a rewrite. **It doesn't reimplement the shell — it vendors Tencent's protocol layer**,
which is still actively maintained.

---

## Requirements

| | |
|---|---|
| **DSH** | **≥ 0.2.0** — this bridge uses `ctx.sessions.list()`, `ctx.on('session/event')` and `agent.followup`, none of which exist in 0.1.x |
| **Actually verified on** | DSH `0.2.0-rc.2` (2026-10-01) and `0.2.1-alpha.1` (2026-10-04, full round trip). `0.2.0` stable and anything else in between is **untested** — the `≥ 0.2.0` floor comes from the API analysis above, not from a run. |
| **Node** | ≥ 22.13.0 |
| **OS** | macOS only so far (Node v24.13.0 + a real WeChat account) |
| **WeChat** | A personal WeChat account you can scan a QR code with |

---

## Install

### One command

```bash
dsh plugin --profile web add github:AmeliaCai67/dsh-wechat-bridge
```

The official CLI installs the package, sees the **`dsh.bundle`** metadata it declares, appends it to
`dsh.profile.bundles`, and merges the `cordis.patch.yml` **shipped inside the package** on boot.
**No profile files to edit.**

> ⚠️ If you previously added the manual `insert` line yourself (see below), **remove it before
> switching** — otherwise the plugin mounts twice and two bridge instances fight over the same
> WeChat account's messages.

### Then three things

**① Log in** — scan once; credentials land in `~/.openclaw/openclaw-weixin/accounts/` and persist.

```bash
node scripts/login.mjs
```

**② Tell the bridge which session to use**

```bash
echo '{"sessionId":"session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}' \
  > ~/.openclaw/openclaw-weixin/dsh-bridge-state.json
```

Find the session id in the DSH Web URL, or as a directory name under `~/.dsh/sessions/`.

> ⚠️ **Why this is manual:** the bridge needs to know which DSH session WeChat messages go to.
> Without a pin it tries to **create a dedicated session**, and **session creation is not
> implemented yet** (see the limitations table — it needs the agent-preset composition to be
> resolved first). So right now this step is required, not optional.

**③ Restart DSH**, then send a message to your bot from WeChat.

### Manual mount (alternative)

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: wechat-bridge
      # ⚠️ Must be a RELATIVE path: a bare package name resolves through pnpm's
      #    dependency graph, and DSH's hot reload does not rebuild that graph.
      # ⚠️ Never append ?v=1 — 0.2.0 encodes the ? as %3F and the import fails.
      name: '../../plugins/dsh-wechat-bridge/lib/main.js'
      config:
        cwd: '/Users/you'          # received/sent media lands here
        autoStart: true
```

---

## How it works

```
Your WeChat
  → Tencent iLink Bot (HTTP long-poll getUpdates)
  → vendor/weixin-dist/     compiled output of Tencent's @tencent-weixin/openclaw-weixin
  → lib/bridge.js           main loop: receive → hand to DSH → collect reply → send back
  → lib/native-transport.js DSH 0.2.0 native transport
  → your DSH session
```

### Two design decisions

**① Why vendor Tencent's code instead of `npm i` it**

The official package is an **OpenClaw host plugin** (`peerDependencies: { openclaw: ">=2026.5.12" }`)
and cannot be imported as a standalone library — its `package.json` has no `main`/`exports`, and the
root has no `index.js`.

But we only touch **8 of its modules**, and its host dependency is just **6 named symbols**. So this
repo copies its compiled output verbatim and substitutes **8 stubs (~20 lines total)** for the OpenClaw
host. See [`vendor/weixin-dist/README-VENDOR.md`](vendor/weixin-dist/README-VENDOR.md) — including
**the one change we had to make** (12 import paths rewritten to relative, nothing else).

**② Why not `apiProxy`**

The old shell went through `ctx.apiProxy` — that RPC envelope was removed in DSH 0.2.0.
0.2.0 offers a more direct in-process API:

```js
send   → agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
receive → ctx.on('session/event', (session, event) => …)
list   → ctx.sessions.list()      // note: only LIVE sessions
agent  → ctx.agents.get(id)
```

---

## Completion notifications

**On by default.** When any session's turn ends, it pushes one WeChat message:

```
✅ add voice input to TAKA  done
⏱ 3m 12s  ｜  🔧 5 steps
💬 Finished — 3 files changed, smoke tests pass.
🔗 session-1a2b3c4d-…
```

**The criterion is "did this turn call a tool", not elapsed time.** Using duration was wrong: a fast
agent (three files rewritten in seconds) would never cross the threshold, so the feature would silently
do nothing. **"It used a tool" is the reliable signal that real work happened.**

**Five restraint rules** (so it doesn't become a spam cannon):

| Rule | Why |
|---|---|
| **Only turns that called a tool** (`notifyMinToolCalls: 1`) | Pure chat shouldn't interrupt you |
| **Never subagent sessions** | `session/event` is a global emit — subagent events arrive too, so without this filter every `subagent` call would push a notification |
| **Never turns WeChat itself started** | The reply already went back over WeChat; pushing again would echo |
| **Never the session you're typing in** (`notifyBoundSession: false`) | You're already looking at it |
| **Only real terminal states** (completed / blocked / aborted / failed) | Not every intermediate step |

```yaml
config:
  notifyOnComplete: true        # master switch
  notifyMinToolCalls: 1         # how many tool calls before pushing (0 = always)
  notifyMinDurationMs: 120000   # fallback: push if no tools but it ran this long
  notifyBoundSession: false     # also push for the bound session?
```

**⚠️ It depends on `context_token`, which has a limited lifetime.** Once expired the push fails
(server returns `ret=-2`). **Send the bot any WeChat message to refresh it.** This makes the feature a
good fit for "I just messaged it, then went off to do something else."

**Why not a standalone plugin:** third-party WeChat notifiers (e.g. `dsh-notify-plugin`) **log into an
iLink bot themselves** — and one WeChat account can only bind one bot, cannot re-scan once bound. It
would fight this bridge for the channel. Reusing the bridge's existing account is conflict-free.

---

## Media

**Receive:** images / files / videos sent over WeChat are downloaded, decrypted and written to
`<cwd>/.wechat-inbox/`, then surfaced to the session.

**Send:** in your reply, put this **on its own line**:

```
MEDIA:/absolute/path/to/photo.png
MEDIA:https://example.com/image.jpg
```

The directive line isn't shown to the user. You can put text on the same line — it sends the text
first, then the media.

---

## Known limitations

| Limitation | Detail |
|---|---|
| **The session must already be open in the Web UI** | Cold resume (working with the browser closed) requires passing `agentPresets.resolve` + `mount` + the session's model selection into `ctx.agents.resume()`. **Not implemented yet.** With no live agent the bridge refuses explicitly rather than building a broken one. **This is the biggest gap right now.** |
| **Completion notifications depend on `context_token`** | Once expired the push fails; send the bot a message to refresh. |
| **Cannot create sessions** | `session.create` is unimplemented. The bridge is pinned to the session named in `dsh-bridge-state.json`. |
| **Verified on macOS only** | Node v24.13.0 + DSH `0.2.0-rc.2` and `0.2.1-alpha.1` + one real WeChat account. Other environments untested. |
| **Group chats unverified** | Tencent's `WeixinMessage` carries `group_id`, but upstream `channel.ts` declares `capabilities.chatTypes` as `["direct"]` only. |
| **Re-scanning logs in a *new* bot** | Scanning the QR again does **not** refresh the old bot's token — it registers a **brand-new bot id** and appends it to `~/.openclaw/openclaw-weixin/accounts.json`. A WeChat account can only be bound to one bot at a time. Since `1.0.1` the bridge picks the **most recently logged-in** account (by `accounts/<id>.json` mtime) rather than `accountIds[0]`, so whichever machine scanned last is the one that works. **Before `1.0.1` it always took the first entry**, so re-scanning silently kept polling the dead account and received nothing. Requires a DSH restart (the account is read into memory at bridge startup). |
| **`[表情: …]` is Web-only** | To send an image over WeChat, use `MEDIA:<absolute path>` or `MEDIA:<https image url>` on its own line. |

---

## Development

```bash
node scripts/selftest.mjs              # 28 checks: module exports, host stubs, contracts, and a real apply()
node scripts/patch-vendor.mjs          # re-apply the vendor import patch (after upgrading upstream)
node scripts/patch-vendor.mjs --check  # verify no bare "openclaw/plugin-sdk/*" specifiers remain
```

**On verification:** a local run is not proof. Of the three ways we tried to ship the host stubs,
**two worked locally and broke on install.** Always test the *installed* artifact:

```bash
dsh plugin --profile __test__ add github:AmeliaCai67/dsh-wechat-bridge
# then import and apply() the package from the throwaway profile's node_modules
```

The last check in `selftest.mjs` — **actually calling `apply()` with a mock ctx** — exists because a
scope error once shipped with 24/24 checks green while the plugin failed to load entirely.
Importing a module is not the same as initializing it.

---

## Credits

- Protocol layer: [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) (Tencent, MIT)
- `lib/bridge.js` / `lib/media.js` / `lib/inbox.js` are ported from the design of
  [`@ccchase/dsh-plugin-wechat`](https://www.npmjs.com/package/@ccchase/dsh-plugin-wechat)
  (unmaintained, no repository published). Thanks to the original author for making the
  send/receive loop legible.

## Changelog

### 1.0.0

- First release.
- Text, image and file transfer in both directions.
- Completion notifications (five restraint rules above).
- Ships the OpenClaw host stubs as part of the package, with the vendor imports rewritten to
  relative paths so the published package actually works.

## License

MIT — see [`LICENSE`](LICENSE). Distribution includes Tencent's MIT-licensed code; its license text is
in [`vendor/weixin-dist/LICENSE`](vendor/weixin-dist/LICENSE).
