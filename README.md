# craft-dsh-marketplace

给 DeepSeek Desktop（DSH）「插件 → 发现 → 索引源」用的 Craft 插件目录。

本仓库同时是**分发源本身**：`index.json` 是目录，`plugins/craft-context/` 是可安装的
DSH 插件包（自带 Craft MCP runtime）。指向 craft 源码仓库是行不通的——craft 把 `dist/`
排除在 Git 之外，`github:` 安装拉到的仓库里没有可运行产物，且其根 `package.json` 没有
`dsh` 字段，过不了市场第一道门。

## 索引格式依据

格式与字段语义来自本机 `dshmarket@1.66.42` 源码，不是推测：

| 事实 | 源码位置 |
|---|---|
| catalog 顶层结构 `{updated, count, categories, plugins}` | `dshmarket/src/registry.ts` `Registry` / `RegistryPlugin` |
| `plugins` 非空，且每条必须有 usable `category`，否则整份 catalog 被拒 | `dshmarket/src/registry.ts` `asRegistry()` |
| 安装目标决策：`npm` 名优先 → 作者 release tarball → `github:owner/repo` | `dshmarket/src/sources.ts` `installTargetFor()` |
| `url` 必须是 `https://github.com/owner/repo`（可带 `/tree/<branch>/<subpath>`） | `dshmarket/src/sources.ts` `parseSourceUrl()` |
| 安装路由只按 `url` 精确匹配目录条目 | `dshmarket/src/routes.ts` install 分支 |

因此每个条目的 `url` 必须唯一。5 个条目共用同一个仓库 url 会让后 4 个装成第 1 个——
这是 `registry.plugins.find(p => p.url.toLowerCase() === url)` 的直接后果，`verify-index.mjs`
会拦住。

## 为什么只有一个条目

craft 的对外发布产品只有 `craft` 和 `craft-context`（外加 hooks-only 的 `craft-datasec`）。
`craft-knowledge` / `craft-memory` / `craft-experience` / `craft-codebase` 是内部
component 名，**不是 release product**（见 `craft/core/release-catalog.ts` 的
`RELEASE_PRODUCTS`），列出来会指向不存在的安装目标。`craft-context` 本身已聚合这四个
子能力，所以一个条目覆盖全部能力。

## 如何被 DSH 使用

在 DSH 里进入「插件 → 发现 → 索引源」，添加本文件的 raw URL：

```
https://raw.githubusercontent.com/wdx9413/craft-dsh-marketplace/main/index.json
```

市场随后会在「发现」页列出 `craft-context`，`plugin_market` 智能体工具也搜索同一份目录。
官方目录是 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`，两者可并存。

## 插件包：plugins/craft-context

| 文件 | 作用 |
|---|---|
| `package.json` | 唯一清单（`dsh.bundle.patch` + `dsh.marketplace`） |
| `cordis.patch.yml` | 插入 profile 层栈；entry id `craft-context` 全局唯一 |
| `lib/index.js` | cordis 插件入口，注册三个工具 |
| `lib/mcp-client.js` | 长连 stdio MCP 客户端（懒启动 + 空闲回收） |
| `lib/tool.js` | `defineTool` 编译形状的本地复刻 |
| `vendor/craft-mcp.cjs` | Craft MCP runtime（`--product context`），约 14 MB |
| `vendor/craft-parser-worker.js` | 解析器 worker，与 bundle 同目录 |
| `skills/craft-context/SKILL.md` | 使用纪律，注册进宿主技能目录 |
| `test/smoke.mjs` | 离线冒烟测试，跑真实 MCP 往返 |

三个工具：`craft_context_info`（运行时身份）、`craft_context_tools`（工具目录，
默认只给名字+描述+参数名，schema 与 Skill 正文按需）、`craft_context_call`（按发现的
schema 调用任一工具）。不是 1:1 注册 91 个工具——schema 每次请求都重发，全量注册会让
每轮都为未使用的能力付 token。

### 14 MB 的 runtime 为什么提交进 Git

默认 Context surface 带 TypeScript checker，bundle 约 14 MB。craft 自己的仓库把
`dist/` 排除在 Git 外，所以没有更轻的上游 artifact 可指；能到达 GitHub 的网络这里只走
SSH，安装时下载不可行。代价是每次 craft 发版多一次 14 MB 提交。若要改，唯一接缝是
`lib/mcp-client.js` 的 `bundlePath()`。

## 本地验证

```sh
node verify-index.mjs                                    # catalog 契约 + 插件四道门
node plugins/craft-context/test/smoke.mjs                # 真实 MCP 往返
```

当前结果：catalog 与四道门 28 项全 PASS；smoke 21 项全 PASS，运行时回报
`0.12.104`，surface 91 个工具，读写真实 `~/.craft_data`。

## 同步新 craft 版本

```sh
node scripts/sync-from-craft.mjs [path-to-craft]
```

从本地 craft checkout 复制 `dist/plugin/` 下两个 bundle 到 `vendor/`，并写
`vendor/SOURCE.json`。插件 `package.json` 的 version 与 craft 不一致时**直接失败**——
静默的版本漂移比失败更难发现。craft 侧需先 `pnpm run build:plugin`。

## 安装

```powershell
$dshHome = "$env:APPDATA\dsh-desktop\harness"
$node = "$dshHome\.desktop-bin\node.cmd"
$dsh  = "D:\application\dshdesktop\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js"

& $node $dsh plugin --profile web add link:D:\documents\project\mytest\craft-dsh-marketplace\plugins\craft-context
```

或走市场：添加上面的索引 URL 后从「发现」页安装。装完**重启 DSH** 生效。

## 已验证 / 未验证

已验证：catalog 契约与四道门（28 项）、插件 shape 与三个工具的真实 MCP 往返（21 项，
含 4 类非法参数拒绝）、`craft_info` 回报版本与声明一致、bundle 可独立启动、
`vendor/` 自足（parser worker 与 bundle 同目录）。

未验证：DSH 内真实安装与重启后工具是否进入模型上下文、市场 UI 渲染、
`~/.craft_data` 与既有 Codex/Claude Craft 数据的并发写、`link:` 与 `github:` 两种安装
路径的实际差异。这些需要在目标 Host 里跑，不能由本地协议测试代替——本仓库尚未推送远端，
所以市场路径整体未测。
