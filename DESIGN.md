# Cloud Drive Environment Sync (Simple Mode Standalone Plugin) Design Spec

## 1. 背景与核心设计哲学 (Intent & Philosophy)

初代 `paseo-sync` 膨胀至 8,500+ 行且频繁因第三方插件更新而崩溃，根源在于它把**「跨设备文件传输（Git 远端管理）」**、**「业务插件内部配置 Schema 校验与迁移」**、**「三方基线 CAS 冲突检测」**与**「离线 Tar 打包构建」**全部耦合在一个插件中。

新项目采用**彻底解耦「同步」与「应用」**的极简架构：
1. **「同步」交给成熟的操作系统级云盘服务**：由 iCloud Drive / OneDrive / Google Drive / Dropbox / Syncthing 负责把一个轻量的环境配置文件夹（如 `~/Library/Mobile Documents/com~apple~CloudDocs/PaseoEnv` 或 `~/OneDrive/PaseoEnv`）自动同步到所有机器的本地磁盘。
2. **「应用」交给本插件**：本插件不碰网络同步协议、不调用 Git、不解析任何第三方插件的设置字段 Schema、不锁死 40 位 Git SHA 或打包 `tar.gz`。它只做两件事：
   - **保存本机环境到同步目录 (`save`)**：将本机可移植插件清单写入 `manifest.json`，并将 `~/.paseo/plugin-settings/<plugin>/<doc>.json`（排除本机专属黑名单）**原样复制**到同步目录。
   - **将同步目录应用到本机 (`apply`)**：读取同步目录的 `manifest.json`，在本机补装缺失插件、对齐启用/禁用状态、将 `settings/` 下的 JSON 文件原样写入 `~/.paseo/plugin-settings/`，并 reload 受影响的插件。

---

## 2. 目标、非目标与反目标 (Goals, Non-Goals, Anti-Goals)

- **目标 (Goals)**：
  1. **零跨插件 Schema 耦合（永不因其他插件更新而 Break）**：对 `plugin-settings/<plugin>/<doc>.json` 仅校验其为合法 JSON 对象（或原样透传字节），不校验任何插件的内部字段名或版本号。
  2. **自动探测主流云盘目录**：开箱自动扫描本机存在的 iCloud Drive、OneDrive、Google Drive、Dropbox 目录，提供一键选用或手动填写任意本地同步文件夹路径。
  3. **宽松幂等的插件对齐 (Reconcile)**：只要求目标插件在本机「已安装且启用/禁用状态一致」。缺失插件通过 `paseo plugin install <installSpec>` 安装；已安装插件默认不强行锁死 SHA 重装（可选提供 `updateExisting: true` 开关顺便执行 `paseo plugin update`）。
  4. **单目录轻量快照回滚**：每次执行 `apply` 覆盖本机设置前，将本机当前的 `~/.paseo/plugin-settings` 与插件列表快照备份到本机状态目录 `last-backup/`（仅保留最新 1 份），支持一键恢复上一次应用前的本机设置。
  5. **跨平台兼容 (macOS / Windows / Linux)**：复用已验证的 Paseo CLI 定位（含 Windows `.cmd` trampoline 解析与 `ELECTRON_RUN_AS_NODE` 清洗）与 Windows 文件锁重试。

- **非目标 (Non-Goals)**：
  - 不内置 Git 仓库 clone / fetch / commit / push。
  - 不支持未发布到本地目录的 `directory` 开发态插件离线打包（`bundle:`）；遇到本地开发目录插件直接跳过并提示。
  - 不做源码级字符串补丁（`patches/`）或插件源码树 `git status` 脏检查。

- **反目标 (Anti-Goals)**：
  - **绝不硬编码任何业务插件的设置字段名或迁移逻辑**（如 `better-paseo` 的 `presentation` 字段列表）。
  - **绝不把 `~/.paseo/plugins/`（含 `node_modules` 与二进制产物）或 `~/.paseo/config.json`、`plugin-data/`（含 SQLite 数据库与密钥）放入云盘目录**。

---

## 3. 同步目录结构与数据契约 (Sync Folder Layout & Schema)

用户在云盘中指定的同步目录（下称 `syncDir`）结构固定为：

```text
<syncDir>/
  manifest.json
  settings/
    better-paseo/
      presentation.json
      tasks.json
      title-generation.json
    paseo-cafe/
      directory-settings.json
    flowly/
      language.json
      board-view.json
```

### 3.1 `manifest.json` 格式

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-11-08T18:30:00.000Z",
  "updatedByHost": "MacBook-Air.local",
  "plugins": [
    {
      "id": "better-paseo",
      "installSpec": "git:https://github.com/RoundRedDot/better-paseo",
      "pluginPath": ".",
      "enabled": true
    },
    {
      "id": "genui",
      "installSpec": "npm:paseo-plugin-genui",
      "pluginPath": ".",
      "enabled": true
    }
  ],
  "settingsFiles": [
    "better-paseo/presentation.json",
    "better-paseo/tasks.json",
    "paseo-cafe/directory-settings.json"
  ]
}
```

### 3.2 插件来源提取规则 (`toPortablePlugin`)
从 `paseo plugin ls --json` 返回的行提取：
- 排除控制器自身（`manifest.id === selfId` 或 `"paseo-env-sync"` / `"paseo-sync"`）。
- `installation.identity.kind === "npm"` → `installSpec = "npm:" + identity.packageName`（**不锁死 `@version`**，使新机器直接装最新可用版，或按需可选附加版本）。
- `installation.identity.kind === "git"` → `installSpec = "git:" + identity.remote`（仅允许 `https://` 或 `git@` 远端，不锁死 40 位 commit SHA）。
- `installation.identity.kind === "directory"` 或无 `identity` → 归入 `skipped`（`reason: "local-directory"`），不写入 `manifest.json`，不阻塞其他插件。

### 3.3 设置文件扫描与排除规则 (`shouldSyncSettingFile`)
扫描 `~/.paseo/plugin-settings/<plugin>/<file>`，满足以下全部条件即纳入同步：
1. `<plugin>` 与 `<file>` 为合法单层文件名，`file.endsWith(".json")`，非符号链接。
2. **排除控制器自身设置目录**：`<plugin> === selfId`（避免把 Mac 的云盘路径 `/Users/...` 同步到 Windows `C:\Users\...`）。
3. **排除设备/引导态私有文件（默认内置黑名单，支持用户在设置中追加）**：
   - `flowly/onboarding.json`（各机器引导气泡状态）
   - `flowly/device-language.json`（设备本地语言）
4. **排除云盘冲突副本与临时文件**：
   - 文件名包含 `conflicted copy`、`冲突副本`、`-conflict-`、或以 `.` / `~` 开头。
5. **排除含明显凭据键名的 JSON（安全兜底）**：
   - 读取并解析 JSON，若无法解析为对象则跳过；这保证了正在被云盘写入半截的文件或损坏文件不会覆盖目标机器。

---

## 4. 核心工作流设计 (Core Workflows)

### 4.1 比较状态 (`inspectAndDiff`)
读取本机状态与 `syncDir/manifest.json`，输出直观的差异摘要（无需任何审批哈希锁）：
- `missingPlugins`: 同步目录有且 `enabled: true`，但本机未安装的插件列表。
- `enablementDiffs`: 本机已安装，但 `enabled` 状态与同步目录不一致的插件列表。
- `changedSettings`: 对比 `syncDir/settings/<rel>` 与 `~/.paseo/plugin-settings/<rel>` 的规范化 JSON（`JSON.stringify(sortKeys(parsed))`），列出新增或内容不同的设置文件。
- `skippedLocalPlugins`: 本机无法导出的本地目录开发插件。

### 4.2 保存本机到同步目录 (`saveToSyncDir`)
1. 校验 `syncDir` 为本机绝对路径，且不在 `~/.paseo` 内部。
2. 调用 `adapter.list()` 获取本机插件，生成 `plugins` 数组与 `skippedLocalPlugins`。
3. 扫描 `~/.paseo/plugin-settings`，将符合规则的 `<plugin>/<doc>.json` 原子写入 `syncDir/settings/<plugin>/<doc>.json`，并清理 `syncDir/settings/` 中已被本机删除的旧文件。
4. 原子写入 `syncDir/manifest.json`。

### 4.3 应用同步目录到本机 (`applyFromSyncDir`)
1. 读取并校验 `syncDir/manifest.json` 存在且 `schemaVersion === 1`。
2. **创建一键回滚快照 (`last-backup`)**：将本机当前的 `plugin-settings` 文件树和已安装插件状态写入 `<stateRoot>/last-backup.json`。
3. **对齐插件**：
   - 对每个 `manifest.plugins` 条目：
     - 若本机未安装且 `target.enabled === true`：调用 `paseo plugin install <installSpec> --id <id>`（若含子目录则带 `--path`）。
     - 若本机未安装且 `target.enabled === false`：直接跳过（因为 Paseo `install` 会立即启用运行代码）。
     - 若本机已安装且传入 `updateExisting === true`：调用 `paseo plugin update <id>`（若单插件更新失败，记录到 `warnings` 而不中断整体应用）。
4. **写入设置文件**：
   - 遍历 `manifest.settingsFiles`，读取 `syncDir/settings/<rel>`，校验 JSON 合法后原子写入 `~/.paseo/plugin-settings/<rel>`。
5. **对齐启用状态与热重载**：
   - 若插件 `enabled` 状态与目标不符，调用 `paseo plugin enable/disable <id>`。
   - 若插件处于启用状态且其设置文件发生了写入，调用 `paseo plugin reload <id>` 使新设置立即生效。

### 4.4 一键恢复上一次本机设置 (`restoreLastBackup`)
- 读取 `<stateRoot>/last-backup.json`，将备份的设置文件原子回写到 `~/.paseo/plugin-settings/`，并对相关插件执行 `enable` / `disable` / `reload`。
