# DSH 安装路径实测发现（2026-10-25）

记录把 craft-context 装进本机 DSH 时实际发生的事，以及由此得出的 catalog 设计约束。
结论全部来自本机文件证据，标注了路径。

## 0. 「此索引的格式无效」：两套索引格式被混用了

这个错误是第一位的：索引源根本读不进去，后面所有安装动作都无从谈起。

DSH 里有**两套互不相同的索引格式**，由不同代码读取：

| | dshmarket 目录 | 官方 Discover 索引源 |
|---|---|---|
| 读取者 | `dshmarket/src/registry.ts` | `@deepseek-ai/dsh-plugin-market-index` |
| 顶层 | `updated, count, categories, plugins` | `format: 1, title, description, metadata, plugins` |
| 条目 | `name, owner, url, category, install, added` | `name, title, description, icon, author, homepage, repository, metadata, versions` |
| 版本 | 无 | `versions[]`：`version`、`publishTimestamp`、`source`、`engines` |

本仓库最初按 **dshmarket 目录**的格式写 `index.json`，填进官方 Discover 的「索引源」
输入框，于是被 `@deepseek-ai/dsh-plugin-market-index` 拒绝。该校验器的第一条规则就是
`$.format === 1`，而文档里没有这个字段，于是报「此索引的格式无效」。

**错误消息不说是哪条规则被违反**，所以定位靠的是把校验器本身找出来：

| 步骤 | 结果 |
|---|---|
| 官方 `dsh-plugin-catalog` npm 包 | 下下来解开，`index.json` 顶层是 `format, title, description, metadata, plugins` |
| 在 app.asar 里搜「此索引的格式无效」 | 命中 `readInvalid` 文案，属于 Discover 客户端 |
| 搜 `parseIndexInWorker` | 找到服务端调用：`fetchIndex` → `parseIndexInWorker` → 失败抛 `plugin-market/invalid-index` |
| 搜 `parse-thread.js` | 拿到 `parse.js`，它 import 的是 `@deepseek-ai/dsh-plugin-market-index` |
| 定位该包的 `lib/index.js` | 拿到完整 format 1 校验器 |

**format 1 的规则**（来自校验器源码）：

- `$.format` 必须等于 `1`
- `$.title` 必填，且必须含 `en`
- `$.plugins[i].name` 必须是合法 npm 包名
- `$.plugins[i].versions` 必填且非空；`version` 精确 SemVer；`publishTimestamp` 是 Unix 秒整数
- `versions[j].source` 必填：`{type:"npm", registry?}` 或 `{type:"git", url, commit(40 位小写 hex), path?}`
- `metadata.category` / `labels` / `sortKeys` 引用的 id **必须在 `$.metadata` 里先声明**
- `repository.url` 必须是 http(s) 且不带 query/fragment；`homepage` 允许带 fragment
- `engines.dsh` 必须是 SemVer range，不能 `workspace:`

安装目标由 `marketInstallTarget()` 决定：npm 源是 `name@version`；git 源是
`git+<url>.git#<commit>&path:/<dir>`，**必须 pin 到 commit**。

**教训**：索引格式不能靠「看起来像」来定。两个包都叫「market」，都能列插件，但字段集
完全不同。要确认格式，唯一的办法是找到读取它的那段代码。

## 1. `link:` 安装会被 DSH 主动移除

`pnpm add link:<插件目录>` 装进 `profiles/web` 成功，junction 建立，bundles 手工追加后
插件可加载、可调用。但之后 DSH 执行了标准卸载流程：

| 证据 | 路径 |
|---|---|
| 移除记录 | `%APPDATA%\dsh-desktop\harness\recovery\plugin-removals.json` |
| 记录内容 | `pluginName: dsh-craft-context`，`status: removed`，`disabledAt: 2026-10-25T03:54:10Z`，`failures: []`，`bootVerifiedAt` 已完成 |
| 备份 | `recovery/plugin-removals/2026-10-25T03-54-10-128Z-.../dsh-craft-context/`，含 `package.json`、`generations.json`（`[]`）、`profile-packages/node_modules/dsh-craft-context/` |
| 移除后状态 | `profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles`、`node_modules/` 三处均无该包 |
| 时间戳 | `package.json` / `pnpm-lock.yaml` / `cordis.yml` / `.install-complete` 全部在 11:54:29 被改写 |

`failures: []` 且带完整备份与 boot 验证，说明这是**正常卸载流程**，不是加载失败。
历史先例：同一文件里有 2026-09-19 的 `dsh-craft-memory`、`dsh-craft-knowledge`、
`dsh-craft-workflow-evolution`——同一套流程，说明这不是偶发。

市场 log（`profiles/web/.dsh-market/log.ndjson`）最后一条是 10-24 10:34，
**没有** `event:"uninstall"` 记录，所以卸载不是从市场 UI 的卸载按钮发起的。

## 2. 「未能获取市场版本信息」的来源

错误原文：

```
dsh-craft-context
未能获取市场版本信息，请重新检查更新。
https://registry.npmmirror.com: This operation was aborted;
https://registry.npmjs.org: HTTP 404
```

两个 registry 都被询问，且 npm 返回 404——因为 **npm 上没有 `dsh-craft-context` 这个包**。

代码路径（dshmarket@1.66.42）：

- `src/updates.ts:667` — `fetchJson(npmUrl('${encodeURIComponent(name)}/latest'))`，
  即按包名查 npm 的 `latest` dist-tag
- `src/discovery-compatibility.ts:423` — `${registry}/${encodeURIComponent(npmName)}`
  拉 packument 以判断「与当前 DSH 版本是否兼容」
- `src/routes.ts:2610` — `registry.plugins.some(plugin => plugin.npm === npmName)`：
  只接受 catalog 里**声明了 `npm` 字段**的条目

`link:` 安装本身走 `updates.ts:564` 的 `kind:'linked'` 分支，不查 registry。所以这个错误
不是插件运行时的故障，而是**市场在为这一行取版本/兼容性信息时，需要一个 npm 身份**，
而 catalog 条目没有提供。

## 3. 设计约束：catalog 条目应当带 `npm` 字段

`installTargetFor()` 的优先级是 `npm` → 作者 release tarball → `github:owner/repo`。
没有 `npm` 时市场退回 `github:`，会：

- 克隆整个仓库（本仓库含 14 MB bundle，克隆成本高）
- 无法判断与当前 DSH 版本的兼容性（发现页取不到 packument）
- 更新检查按包名查 npm 必然 404，表现为「未能获取市场版本信息」

因此正解是**把插件发布为 npm 包**，并在 catalog 条目补上 `npm` 字段。附带收益：

- git 仓库不再需要提交 14 MB bundle，可改为 npm 包携带
- `installTargetFor()` 优先走 registry，安装更快、可校验完整性
- 兼容性判断与更新检查全部走通

## 4. npm 包形态：已实施与实测

包已改造成可发布形态（`plugins/craft-context/package.json`）：

- `publishConfig: { registry: "https://registry.npmjs.org", access: "public" }`
- `engines.dsh` 采用生态里的分段表达式
  `>=0.1.7-rc.2 <0.2.0-rc.1 || >=0.2.0-rc.1 <0.2.1-rc.2 || >=0.2.1-rc.2 <0.2.2`
- `@deepseek-ai/cordis` 标为 **optional peer**。这一步是必需的而非可选：非 optional 的
  宿主 peer 会让 pnpm 把整个宿主依赖树拖进用户 profile，实测
  `dsh-workbuddy-trae-qoder-connect` 因此拖进 165 个包并直接失败。本插件不 import
  任何 `@deepseek-ai/*`，标 optional 不影响运行。
- catalog 条目补上 `npm: dsh-craft-context`

实测（`npm pack` 后在临时工程里 `pnpm add file:...tgz`）：

| 项 | 结果 |
|---|---|
| 包内容 | 10 个文件，压缩 2.34 MB（未压缩 13.9 MB） |
| 安装引入的包数 | **1 个**（`dsh-craft-context`），1.1 秒 |
| 传递依赖 | 无宿主依赖树被拖入 |
| 安装后文件 | 10 个全部就位，入口可 import（`name=craft-context inject=["tools"]`） |

### 发布被凭据挡住

`npm publish` 返回：

```
403 Forbidden - PUT https://registry.npmjs.org/dsh-craft-context
Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

根因不是账号没开 2FA：账号 `wdx9413` 的 `tfa` 为 `false`。这条 npm 的措辞有误导性，
真正缺的是 **token 自己的 bypass 2FA 能力**。用 npm 的 token 列表端点可以看到 token 的
全部属性：

```json
{
  "key": "9d49aacc-2182-4dd5-b404-45f57ef525a7",
  "bypass_2fa": false,
  "permissions": [{ "name": "package", "action": "write" }],
  "scopes": [{ "name": null, "type": "package" }]
}
```

`permissions` 已经是 package:write，但 `bypass_2fa: false` —— npm 官方文档的要求是
「发布需要账号开启 2FA，**或**使用启用了 bypass 2FA 的 granular access token」。
账号既然没开 2FA，这个 token 就必须带 bypass 2FA。

已排除的其它可能：

| 假设 | 结论 |
|---|---|
| `.npmrc` 里的旧会话 token 覆盖了环境变量 | 排除：用 `--userconfig` 指向只含新 token 的隔离 npmrc，仍是同一个 403 |
| `NODE_AUTH_TOKEN` 未被采纳 | 排除：隔离 npmrc 的发布同样使用新 token |
| 包本身有问题 | 排除：`npm pack` 成功，10 个文件、2.5 MB；403 是权限拒绝，不是内容问题 |
| 账号开了 2FA 但没配 OTP | 排除：账号 `tfa: false`；`npm profile enable-2fa` 需账号密码，CLI 无法自助开启 |

**解法**：编辑该 token，勾选 **Bypass 2FA**（npmjs.com → Access Tokens → 该 token →
Edit → Bypass 2FA）。或给账号开启 2FA（`npm profile enable-2fa auth-and-writes`），
之后用普通 token + 一次性验证码发布。两者都需要账号持有者本人操作。

发布后 `tools/catalog-probe.mjs` 的 `npm package is reachable in the registry`
一项会从 FAIL 转为 PASS——该探针现在与市场用同一条代码路径失败。

## 5. 当前状态与未验证项

**已能读入索引**：`index.json` 已改为 format 1，并由官方校验器验证通过——
`tools/market-index-validator.mjs` 直接调用从 app.asar 抽出的
`@deepseek-ai/dsh-plugin-market-index`，不重写规则。旧格式被它明确拒绝为
`$.format must be 1`，这说明检查是有效的而非自我确认。远端 URL 实测通过。

未验证：

- **从市场「发现」页点击安装**（GUI 路径）未测。程序化验证覆盖了市场会执行的
  format 1 校验与安装目标构造，但没有覆盖点击本身。
- **安装后的实际加载**未测：git 源会构造
  `git+<url>.git#<commit>&path:/plugins/craft-context`，需要真实装一次并重启 DSH，
  确认 `craft_context_info` 进入模型上下文、技能目录出现 `craft-context`。
- **registry 安装未测**：包尚未发布，tarball 路径已测，registry 路径未测。
- `~/.craft_data` 与既有 Codex/Claude Craft 数据的并发写未测。
