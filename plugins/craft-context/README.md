# craft-context (DSH)

Craft Context 的 DeepSeek Desktop 插件形态。自包含：内置 Craft MCP runtime
bundle 与 `craft-context` Skill，不下载 npm 包，不需要 Hook。

## 装什么

| 文件 | 作用 |
|---|---|
| `package.json` | 唯一清单（`dsh.bundle.patch` + `dsh.marketplace`） |
| `cordis.patch.yml` | 把自己插入 profile 层栈；`id: craft-context` 全局唯一 |
| `lib/index.js` | cordis 插件入口，注册三个工具 |
| `lib/mcp-client.js` | 长连 stdio MCP 客户端（懒启动 + 空闲回收） |
| `lib/tool.js` | `defineTool` 编译形状的本地复刻 |
| `vendor/craft-mcp.cjs` | Craft MCP runtime（`--product context`） |
| `vendor/craft-parser-worker.js` | 解析器 worker；与 bundle 同目录，启动时按 `entryDir` 解析 |
| `skills/craft-context/SKILL.md` | 使用纪律，注册进宿主技能目录 |

## 暴露的三个工具

| 工具 | 用途 |
|---|---|
| `craft_context_info` | runtime 身份、版本、`data_space_id`；安装后先用它确认插件活着 |
| `craft_context_tools` | 实际工具名 + schema +  bundled Skill 正文 |
| `craft_context_call` | 按发现的 schema 调用任一工具 |

不是 1:1 注册全部 Context 工具：工具 schema 每次请求都会重发，全量注册会让
每一轮都为未使用的能力付 token。`craft_context_tools` + Skill 构成渐进披露，
全部能力仍可达，常驻成本恒定。

## 安装

```powershell
$dshHome = "$env:APPDATA\dsh-desktop\harness"
$node = "$dshHome\.desktop-bin\node.cmd"
$dsh  = "D:\application\dshdesktop\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js"

& $node $dsh plugin --profile web add link:D:\documents\project\mytest\craft-dsh-marketplace\plugins\craft-context
```

或在 profile 目录直接用 PATH 上的 pnpm（即 Desktop runner，会自动处理
generation projection 共存）：

```powershell
cd "$env:APPDATA\dsh-desktop\harness\profiles\web"
pnpm add link:D:\documents\project\mytest\craft-dsh-marketplace\plugins\craft-context
```

`reconcilePlugins()` 会自动把 `dsh-craft-context` 追加进 `dsh.profile.bundles`，
**重启 DSH 后生效**。

## 数据

默认写 `~/.craft_data`（Craft 标准数据根）。用 `CRAFT_DATA_DIR` 或插件的
`dataDir` 配置覆盖。与 Codex / Claude 侧的 Craft 插件**共用同一份数据**，
因此同一台机器上不需要重复导入知识或记忆。

## 四道门（装不上 / 起不来 / 被自动卸载都因为这四个）

| 门 | 本插件状态 |
|---|---|
| `package.json` 有 `dsh` 字段 | ✅ |
| `main` / `exports['.']` 指向的入口已构建存在 | ✅ `lib/index.js` 入库 |
| `cordis.patch.yml` 的 entry id 全局唯一 | ✅ `craft-context`；安装前用 `node ../../verify-index.mjs` 核对与本机已有 id 无冲突 |
| 入口模块可被真正 import | ✅ 零运行时依赖、零 `@deepseek-ai/*` import |

## 已验证 / 未验证

已验证：目录结构与清单形状、bundle 可独立启动（`node vendor/craft-mcp.cjs
--product context` 返回 `craft_info`）、MCP 客户端协议往返。

未验证：DSH 内真实安装与重启后工具是否进入模型上下文、设置页渲染、
`~/.craft_data` 与既有 Codex/Claude Craft 数据的并发写。这些需要在目标 Host
里跑，不能由本地协议测试代替。
