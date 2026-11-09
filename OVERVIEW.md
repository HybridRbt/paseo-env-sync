# Paseo Env Sync 总览

`paseo-env-sync` 是一个独立的 Paseo 原生插件，用于在多台机器之间保持「插件清单 + 插件设置」一致。它不自己搬文件：文件传输交给操作系统级云盘（iCloud Drive / OneDrive / Google Drive / Dropbox / Syncthing 等），插件只负责把本机环境**保存**到云盘文件夹，以及把云盘文件夹**应用**回本机。

## 设计哲学：彻底解耦「同步」与「应用」

初代 `paseo-sync`（8,500+ 行）频繁因第三方插件更新而崩溃，根因是把 Git 远端管理、三方 Schema 校验迁移、冲突检测、离线打包全部耦合在一起。本插件反其道而行：

- **零跨插件 Schema 耦合**：对 `~/.paseo/plugin-settings/<plugin>/<doc>.json` 只校验「是合法 JSON 对象」，其余字节原样复制。任何插件更新自己的设置字段都不会让本插件失效。
- **不碰网络协议**：不调 Git、不打 tar 包、不锁 40 位 commit SHA。`manifest.json` 记录的是不锁版本的安装来源（`npm:<包名>` / `git:<https 或 git@ 远端>`），新机器直接安装最新可用版。
- **单槽快照回滚**：每次 `apply` 覆盖本机设置前，先把本机当前状态备份到 `<home>/plugin-data/paseo-env-sync/last-backup.json`（仅保留最新一份），支持一键恢复。

## 同步目录结构

```text
<syncDir>/            # 例如 ~/Library/Mobile Documents/com~apple~CloudDocs/PaseoSync
  manifest.json       # schemaVersion 1：插件清单 + 设置文件列表 + 更新时间/主机
  settings/
    better-paseo/
      presentation.json
      tasks.json
    flowly/
      board-view.json
```

## 什么会同步，什么不会

| 会同步 | 不会同步 |
| --- | --- |
| `plugin-settings/<plugin>/<doc>.json`（合法 JSON 对象，不在排除名单） | 本插件自身与旧 `paseo-sync` 的设置（避免 Mac 路径覆盖 Windows 路径） |
| 可移植插件清单（npm / git(https, git@) 来源，不锁版本） | `flowly/onboarding.json`、`flowly/device-language.json` 等设备私有文件（可在设置中追加） |
| | 云盘冲突副本（`conflicted copy`、`冲突副本`、`-conflict-`、`(1).json`）与 `.`/`~` 开头的临时文件 |
| | `~/.paseo/plugins/`、`config.json`、`plugin-data/`（含数据库与密钥） |
| | 本地目录开发态插件（`directory` 来源），保存时跳过并提示 |

## 安全机制

1. **半截文件不入本机**：`apply` 写入前逐一解析云盘 JSON，解析失败即跳过并记入警告，绝不覆盖本机现有设置。
2. **路径安全**：`safeChildPath` 拒绝 `..`、绝对路径与符号链接组件，`manifest.json` 里的越界路径不会逃出同步目录或 `plugin-settings`。
3. **禁用插件不偷装**：目标清单里 `enabled: false` 且本机未安装的插件直接跳过（Paseo 的 `plugin install` 会立即启用并运行插件代码）。
4. **原子写入**：所有 JSON 写入先写同目录临时文件再 `rename`，Windows 文件锁（EPERM/EACCES）短暂重试。

## 代码结构

```text
shared/contracts.ts    # Zod 设置 schema + 5 个 RPC（discoverDirs/status/save/apply/restore）
server/files.mjs       # 路径安全、排除规则、规范化 JSON、原子写入
server/cloud-dirs.mjs  # iCloud/OneDrive/Google Drive/Dropbox 目录探测
server/paseo-cli.mjs   # 跨平台 Paseo CLI 定位与调用（Windows .cmd trampoline、ELECTRON_RUN_AS_NODE 清洗）
server/reconcile.mjs   # save/apply/diff/restore 核心（不感知任何第三方插件 Schema）
client/sync-screen.tsx # 单屏 UI：云盘探测 → 状态对比 → 一键应用/保存/回滚
index.server.ts        # RPC 注册 + 进程内互斥
index.client.tsx       # 屏幕与侧边栏注册
```

## 兼容性

- Paseo `>=0.11.4`（`paseo-plugin.json` 声明，SDK `@getpaseo/plugin >=0.15.3`）。
- macOS / Windows / Linux。Windows 下经 .cmd trampoline 解析定位 Electron 入口，并从子进程环境中删除 `ELECTRON_RUN_AS_NODE`。
