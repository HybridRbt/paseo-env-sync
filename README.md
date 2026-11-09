# Paseo Env Sync

用你已有的云盘（iCloud Drive / OneDrive / Google Drive / Dropbox / Syncthing）在多台机器之间同步 Paseo 的插件与插件设置。文件传输由云盘完成，本插件只做两件事：**把本机环境保存到云盘文件夹**，**把云盘文件夹应用回本机**。对第三方插件的设置内容零感知（只要求是合法 JSON 对象），因此不会因其他插件更新而失效。

## 安装

```bash
paseo plugin install <本插件来源> --id paseo-env-sync
```

要求 Paseo `>=0.11.4`。开发调试：本仓库 `npm install && npm test`。

## 使用

1. 打开 Paseo 侧边栏的 **Env Sync**。
2. 在「云盘环境同步」卡片中点选自动探测到的云盘（iCloud Drive / OneDrive / Google Drive / Dropbox），或手动填写同步目录的绝对路径，例如：
   - macOS iCloud：`~/Library/Mobile Documents/com~apple~CloudDocs/PaseoSync`
   - OneDrive：`~/OneDrive/PaseoSync`
3. 点「保存设置」。
4. 在第一台机器上点「**将本机环境保存到云盘**」——生成 `manifest.json` 与 `settings/`，之后云盘会自动把它们带到其他机器。
5. 在其他机器上点「**将云盘环境应用到本机**」——补装缺失插件、对齐启用/禁用状态、写入设置文件并 reload 受影响插件。可选开启「同时更新已安装插件」。
6. 应用后如需反悔，点「**恢复上一次本机设置**」回到 apply 之前的本机状态（仅保留最近一份快照）。

## 高级设置（可选）

- **Paseo CLI 路径**：留空自动在 `PATH`、`/Applications/Paseo.app/...`、Windows 常见位置查找。
- **Paseo 数据目录**：留空使用默认 `~/.paseo`。
- **额外排除**：每行一条 `plugin/file.json`，叠加到内置排除名单之外。

## 同步内容与边界

- **同步**：`~/.paseo/plugin-settings/<plugin>/<doc>.json` 中合法的 JSON 对象（排除设备私有文件与云盘冲突副本），以及不锁版本的插件安装来源清单。
- **不同步**：本插件与旧 `paseo-sync` 自身设置、`~/.paseo/plugins/`、`config.json`、`plugin-data/`（数据库与密钥）、本地目录开发态插件（保存时跳过并提示）。
- **安全**：云盘中的半截/损坏 JSON 不会覆盖本机；`manifest.json` 中的越界路径（`..`、绝对路径、符号链接）会被拒绝；`enabled: false` 且未安装的插件不会被偷偷装上。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test tests/*.test.mjs（纯单测，使用临时目录与 mock adapter）
```

设计与实施文档见 `DESIGN.md` 与 `IMPLEMENTATION_PLAN.md`；架构总览见 `OVERVIEW.md`。
