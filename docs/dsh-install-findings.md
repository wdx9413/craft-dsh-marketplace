# DSH 安装路径实测发现（2026-10-25）

记录把 craft-context 装进本机 DSH 时实际发生的事，以及由此得出的 catalog 设计约束。
结论全部来自本机文件证据，标注了路径。

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

## 4. 未验证项

- 从市场「发现」页点击安装（GUI 路径）未测；程序化验证覆盖了 catalog 校验与安装目标解析
- `github:` 安装（市场路径）未测，本次只用 `link:`
- npm 包形态未实施，因此上述第 3 节是设计推断，非实测
