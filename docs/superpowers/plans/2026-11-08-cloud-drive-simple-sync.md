# Cloud Drive Environment Sync (Simple Mode Standalone Plugin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, zero-schema-coupling Paseo plugin (`paseo-env-sync`) that keeps plugins and `plugin-settings` synchronized across machines via a cloud-drive folder (iCloud Drive / OneDrive / Google Drive / Dropbox), separating file transport from local environment application.

**Architecture:** A lightweight Paseo native plugin with three layers: (1) `shared/` Zod contracts for host settings (`syncDir`, `cliPath`, `excludeFiles`) and 5 RPCs (`discover`, `status`, `save`, `apply`, `restore`), (2) `server/core/` pure Node.js modules (~250 LOC total) for cloud folder discovery, schema-agnostic JSON settings copy, Paseo CLI plugin reconciliation, and single-slot local backup, and (3) `client/sync.tsx` React Native screen with one-click "Save Local to Cloud Folder" and "Apply Cloud Folder to Local" actions.

**Tech Stack:** Paseo Plugin SDK (`@getpaseo/plugin` `>=0.11.4`), TypeScript, Node.js `>=22.18` standard library (`node:fs/promises`, `node:path`, `node:os`, `node:child_process`, `node:crypto`), React Native, Zod, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-08-cloud-drive-simple-sync-design.md`

## Global Constraints

- Plugin ID is `paseo-env-sync`; `paseo-plugin.json` declares `"requirements": { "paseo": ">=0.11.4" }`.
- Zero runtime npm dependencies beyond Paseo host-provided `@getpaseo/plugin`, `react`, `react-native`, and `zod`.
- Strict SDK runtime import boundaries: `shared/` imports only `@getpaseo/plugin` and `zod`; `client/` never imports `node:*` or `server/`; `server/` never imports `client/`.
- Never hardcode any third-party plugin's internal settings schema or field names; any valid JSON object in `plugin-settings/<plugin>/<doc>.json` (not matching exclusion rules) is copied verbatim.
- Always delete `ELECTRON_RUN_AS_NODE` from child process environment before spawning `paseo` CLI unless explicitly launching the Windows Electron entrypoint.
- Client UI uses React Native primitives (`View`, `Text`, `Pressable`, `ScrollView`, `TextInput`) with colors exclusively from `theme.colors`, supporting both desktop and `layout.compact` mobile views.
- Chinese user-facing UI strings use corner brackets `「」` for quoting UI actions or terms.

## Review Focus

1. Cloud-drive conflict/temp files (e.g. `presentation (conflicted copy 2026-11-08).json`, `.DS_Store`, `~$temp.json`) in `plugin-settings/` or `syncDir/settings/` must be ignored during both `save` and `apply`.
2. Half-synced or truncated JSON files in the cloud folder must be rejected before overwriting any local `~/.paseo/plugin-settings` file, leaving existing local settings intact.
3. Symlinked directories or path traversal segments (`..`, absolute paths) inside `syncDir` or `manifest.json` must be rejected by `safeChildPath`.
4. The sync plugin's own settings directory (`plugin-settings/paseo-env-sync/`) and `paseo-sync/` must always be excluded so machine A's cloud folder path (`C:\Users\...` vs `/Users/...`) never overwrites machine B's path.
5. Target plugins with `enabled: false` that are not currently installed on the machine must be skipped during `apply` (since `paseo plugin install` immediately enables and runs plugin code).

---

## Target Project File Structure

```text
paseo-env-sync/
  paseo-plugin.json
  package.json
  tsconfig.json
  OVERVIEW.md
  README.md
  index.server.ts
  index.client.tsx
  shared/
    contracts.ts          # Settings definition + RPC Zod schemas
  server/
    cloud-dirs.mjs        # Auto-detect iCloud / OneDrive / Google Drive / Dropbox paths
    files.mjs             # Safe path resolution, atomicWrite, canonical JSON diff, exclusions
    paseo-cli.mjs         # Cross-platform Paseo CLI locator & runner (macOS/Linux/Windows .cmd)
    reconcile.mjs         # Core inspectDiff, saveToSyncDir, applyFromSyncDir, restoreLastBackup
  client/
    i18n.mjs              # Bilingual zh/en strings
    sync-screen.tsx       # Main screen component + sidebar item
  tests/
    files.test.mjs
    cloud-dirs.test.mjs
    paseo-cli.test.mjs
    reconcile.test.mjs
```

---

### Task 1: Project Scaffold & Shared Contracts (`shared/contracts.ts`)

**Files:**
- Create: `paseo-plugin.json`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `shared/contracts.ts`

**Interfaces:**
- Produces:
  - `envSyncSettings`: `defineSettings({ id: "config", scope: "host", version: 1, schema })` with fields `{ syncDir: string, cliPath: string, daemonHome: string, updateExisting: boolean, extraExcludes: string }`
  - `discoverDirsRpc`: `defineRpc({ name: "envSync.discoverDirs", input, output })`
  - `statusRpc`: `defineRpc({ name: "envSync.status", input, output })`
  - `saveRpc`: `defineRpc({ name: "envSync.save", input, output })`
  - `applyRpc`: `defineRpc({ name: "envSync.apply", input, output })`
  - `restoreRpc`: `defineRpc({ name: "envSync.restore", input, output })`

- [ ] **Step 1: Create `paseo-plugin.json`, `package.json`, and `tsconfig.json`**

```json
// paseo-plugin.json
{
  "id": "paseo-env-sync",
  "name": "Paseo Env Sync",
  "description": "Keep plugins and plugin settings in sync across machines using your cloud drive folder.",
  "requirements": {
    "paseo": ">=0.11.4"
  }
}
```

```json
// package.json
{
  "name": "paseo-env-sync",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "files": [
    "paseo-plugin.json",
    "OVERVIEW.md",
    "README.md",
    "index.client.tsx",
    "index.server.ts",
    "client",
    "server",
    "shared"
  ],
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@getpaseo/plugin": "^0.15.3",
    "@types/react": "^19.0.0",
    "react": "^19.0.0",
    "react-native": "^0.78.0",
    "typescript": "^5.8.0",
    "zod": "^4.0.0"
  }
}
```

- [ ] **Step 2: Write `shared/contracts.ts` with settings and RPC schemas**

Define `envSyncSettings`, `discoverDirsRpc`, `statusRpc`, `saveRpc`, `applyRpc`, and `restoreRpc`. Ensure no control characters (`[\x00-\x1f]`) are allowed in path inputs.

- [ ] **Step 3: Run typecheck to verify contract compilation**

Run: `npm install && npm run typecheck`
Expected: PASS with 0 errors.

- [ ] **Step 4: Commit**

```bash
git add paseo-plugin.json package.json tsconfig.json shared/contracts.ts
git commit -m "feat: initialize plugin scaffold and shared RPC contracts"
```

---

### Task 2: Safe File Operations, Conflict Filter & Cloud Folder Discovery (`server/files.mjs`, `server/cloud-dirs.mjs`)

**Files:**
- Create: `server/files.mjs`
- Create: `server/cloud-dirs.mjs`
- Test: `tests/files.test.mjs`
- Test: `tests/cloud-dirs.test.mjs`

**Interfaces:**
- Produces in `server/files.mjs`:
  - `safeChildPath(rootDir: string, relativePath: string) -> Promise<string>` (rejects `..`, absolute paths, and symlink components)
  - `shouldSyncSettingFile(pluginId: string, fileName: string, options?: { selfIds?: string[], extraExcludes?: string[] }) -> boolean`
  - `readValidJsonObject(filePath: string) -> Promise<Record<string, unknown> | null>`
  - `canonicalJsonString(obj: unknown) -> string`
  - `atomicWriteJson(filePath: string, data: unknown) -> Promise<void>`
- Produces in `server/cloud-dirs.mjs`:
  - `discoverCloudFolders(options?: { homedir?: string, platform?: string, env?: Record<string, string | undefined> }) -> Promise<Array<{ provider: string, path: string, exists: boolean }>>`

- [ ] **Step 1: Write failing tests in `tests/files.test.mjs` and `tests/cloud-dirs.test.mjs`**

```js
// tests/files.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { shouldSyncSettingFile, canonicalJsonString } from "../server/files.mjs";

test("shouldSyncSettingFile excludes self plugins, onboarding/device files, and cloud conflict copies", () => {
  assert.equal(shouldSyncSettingFile("better-paseo", "presentation.json"), true);
  assert.equal(shouldSyncSettingFile("better-paseo", "tasks.json"), true);
  assert.equal(shouldSyncSettingFile("paseo-env-sync", "config.json"), false);
  assert.equal(shouldSyncSettingFile("paseo-sync", "connection.json"), false);
  assert.equal(shouldSyncSettingFile("flowly", "onboarding.json"), false);
  assert.equal(shouldSyncSettingFile("flowly", "device-language.json"), false);
  assert.equal(shouldSyncSettingFile("flowly", "board-view.json"), true);
  assert.equal(shouldSyncSettingFile("better-paseo", "presentation (conflicted copy 2026-11-08).json"), false);
  assert.equal(shouldSyncSettingFile("better-paseo", "presentation-conflict-1.json"), false);
  assert.equal(shouldSyncSettingFile("better-paseo", ".presentation.json"), false);
});

test("canonicalJsonString sorts object keys deterministically regardless of insertion order", () => {
  assert.equal(
    canonicalJsonString({ b: 1, a: { y: true, x: false } }),
    canonicalJsonString({ a: { x: false, y: true }, b: 1 }),
  );
});
```

```js
// tests/cloud-dirs.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverCloudFolders } from "../server/cloud-dirs.mjs";

test("discoverCloudFolders detects iCloud Drive on darwin and OneDrive via env", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "cloud-home-"));
  const icloudRoot = path.join(fakeHome, "Library", "Mobile Documents", "com~apple~CloudDocs");
  const oneDriveRoot = path.join(fakeHome, "OneDrive");
  await mkdir(icloudRoot, { recursive: true });
  await mkdir(oneDriveRoot, { recursive: true });

  const candidates = await discoverCloudFolders({
    homedir: fakeHome,
    platform: "darwin",
    env: { OneDrive: oneDriveRoot },
  });
  assert.equal(candidates.some((c) => c.provider === "iCloud Drive" && c.path === path.join(icloudRoot, "PaseoSync")), true);
  assert.equal(candidates.some((c) => c.provider === "OneDrive" && c.path === path.join(oneDriveRoot, "PaseoSync")), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `server/files.mjs` and `server/cloud-dirs.mjs`**

In `server/files.mjs`:
- Built-in excluded relative paths: `flowly/onboarding.json`, `flowly/device-language.json`.
- Built-in excluded plugin IDs: `paseo-env-sync`, `paseo-sync`, plus any caller-supplied `selfIds`.
- Conflict regex: `/conflicted copy|冲突副本|-conflict-|\(1\)\.json$/i` or file starting with `.` or `~`.
- `atomicWriteJson`: writes to `.tmp-<uuid>` in the same directory and `rename`s (with Windows `EPERM`/`EACCES` short retry).

In `server/cloud-dirs.mjs`:
- Check candidate roots:
  - iCloud Drive (macOS): `<homedir>/Library/Mobile Documents/com~apple~CloudDocs`
  - iCloud Drive (Windows): `<env.USERPROFILE>/iCloudDrive`
  - OneDrive: `env.OneDriveConsumer`, `env.OneDrive`, `<homedir>/OneDrive`, `<homedir>/Library/CloudStorage/OneDrive-Personal`
  - Google Drive: `<homedir>/Google Drive/My Drive`, `<homedir>/Library/CloudStorage` entries matching `GoogleDrive-*` (with `My Drive` or `我的云端硬盘` child)
  - Dropbox: `<homedir>/Dropbox`, `<homedir>/Library/CloudStorage/Dropbox`
- For each existing cloud root, return `{ provider, path: path.join(cloudRoot, "PaseoSync"), exists: existsSync(path.join(cloudRoot, "PaseoSync", "manifest.json")) }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/files.mjs server/cloud-dirs.mjs tests/files.test.mjs tests/cloud-dirs.test.mjs
git commit -m "feat: add safe file helpers, conflict filters, and cloud folder discovery"
```

---

### Task 3: Cross-Platform Paseo CLI Adapter (`server/paseo-cli.mjs`)

**Files:**
- Create: `server/paseo-cli.mjs`
- Test: `tests/paseo-cli.test.mjs`

**Interfaces:**
- Produces in `server/paseo-cli.mjs`:
  - `toPortablePlugin(row: any, selfIds?: string[]) -> { plugin: { id: string, installSpec: string, pluginPath: string, enabled: boolean } | null, skippedReason: string | null }`
  - `installArgs(plugin: { id: string, installSpec: string, pluginPath?: string }, home: string) -> string[]`
  - `makeCliAdapter(home: string, explicitCliPath?: string) -> Promise<{ list(): Promise<any[]>, install(p): Promise<any>, update(id: string): Promise<any>, act(action: "enable"|"disable"|"reload", id: string): Promise<any> }>`

- [ ] **Step 1: Write failing tests in `tests/paseo-cli.test.mjs`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { toPortablePlugin, installArgs } from "../server/paseo-cli.mjs";

test("toPortablePlugin converts npm and git plugins without locking commit SHA or version", () => {
  const gitRow = {
    id: "better-paseo",
    enabled: true,
    installation: {
      currentRevision: "443fa034bcc238f98b990bc9b3124fe6dbc5e96d",
      identity: { kind: "git", remote: "https://github.com/RoundRedDot/better-paseo" },
    },
  };
  assert.deepEqual(toPortablePlugin(gitRow), {
    plugin: {
      id: "better-paseo",
      installSpec: "git:https://github.com/RoundRedDot/better-paseo",
      pluginPath: ".",
      enabled: true,
    },
    skippedReason: null,
  });

  const npmRow = {
    id: "genui",
    enabled: false,
    installation: {
      currentRevision: "0.3.3",
      identity: { kind: "npm", packageName: "paseo-plugin-genui" },
    },
  };
  assert.deepEqual(toPortablePlugin(npmRow), {
    plugin: {
      id: "genui",
      installSpec: "npm:paseo-plugin-genui",
      pluginPath: ".",
      enabled: false,
    },
    skippedReason: null,
  });

  const dirRow = {
    id: "flowly",
    enabled: true,
    installation: { identity: { kind: "directory" } },
  };
  assert.deepEqual(toPortablePlugin(dirRow), {
    plugin: null,
    skippedReason: "local-directory",
  });
});

test("installArgs builds CLI arguments without pinned ref", () => {
  assert.deepEqual(
    installArgs({ id: "better-paseo", installSpec: "git:https://github.com/RoundRedDot/better-paseo", pluginPath: "." }, "/Users/test/.paseo"),
    ["plugin", "install", "git:https://github.com/RoundRedDot/better-paseo", "--id", "better-paseo", "--home", "/Users/test/.paseo", "--json"],
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `server/paseo-cli.mjs`**

Port the proven cross-platform CLI locator from `paseo-sync` (`locate`, `resolveWindowsLaunch`, `trampolineTarget`, and `delete childEnv.ELECTRON_RUN_AS_NODE`), while simplifying `installArgs` and `toPortablePlugin` to use unpinned `installSpec` (`npm:<pkg>` and `git:<remote>`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/paseo-cli.mjs tests/paseo-cli.test.mjs
git commit -m "feat: add cross-platform Paseo CLI adapter and portable plugin extractor"
```

---

### Task 4: Core Save, Apply, Diff & Single-Backup Engine (`server/reconcile.mjs`)

**Files:**
- Create: `server/reconcile.mjs`
- Test: `tests/reconcile.test.mjs`

**Interfaces:**
- Consumes: `server/files.mjs`, `server/paseo-cli.mjs`
- Produces in `server/reconcile.mjs`:
  - `inspectStatus(ctx: { home: string, syncDir: string, stateDir: string, adapter: any, selfIds?: string[], extraExcludes?: string[] }) -> Promise<StatusResult>`
  - `saveToSyncDir(ctx) -> Promise<{ savedAt: string, pluginsCount: number, settingsCount: number, skippedLocalPlugins: string[] }>`
  - `applyFromSyncDir(ctx, options?: { updateExisting?: boolean }) -> Promise<{ installed: string[], updated: string[], toggled: string[], settingsWritten: string[], skippedDisabled: string[], warnings: string[] }>`
  - `restoreLastBackup(ctx) -> Promise<{ restoredAt: string, settingsRestored: string[] }>`

- [ ] **Step 1: Write failing end-to-end unit tests in `tests/reconcile.test.mjs`**

Test all core scenarios using temp directories and a mock `adapter`:
1. `saveToSyncDir` scans arbitrary third-party plugin settings (e.g., `better-paseo/presentation.json` with unknown future fields, `better-paseo/tasks.json`, `flowly/board-view.json`), excludes `flowly/onboarding.json` and `paseo-env-sync/config.json`, skips `directory` plugins, and writes `manifest.json` + `settings/**/*.json`.
2. `applyFromSyncDir` on a second machine:
   - Saves `last-backup.json` in `stateDir` before making changes.
   - Installs missing enabled plugins via `adapter.install`.
   - Skips missing disabled plugins (`skippedDisabled`).
   - Copies all `settingsFiles` into `<home>/plugin-settings/<plugin>/<doc>.json` verbatim and calls `adapter.act("reload", pluginId)` on running plugins.
   - Rejects corrupted/truncated JSON in `syncDir/settings/` without clobbering local files.
3. `restoreLastBackup` restores the exact pre-apply settings files from `last-backup.json`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `server/reconcile.mjs`**

Implement `inspectStatus`, `saveToSyncDir`, `applyFromSyncDir`, and `restoreLastBackup` following the exact steps in Spec Section 4. Keep total code under ~160 lines.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/reconcile.mjs tests/reconcile.test.mjs
git commit -m "feat: implement schema-agnostic save, apply, diff, and single-slot backup"
```

---

### Task 5: Server Entry, Client UI & Documentation (`index.server.ts`, `index.client.tsx`, `client/`)

**Files:**
- Create: `index.server.ts`
- Create: `client/i18n.mjs`
- Create: `client/sync-screen.tsx`
- Create: `index.client.tsx`
- Create: `OVERVIEW.md`
- Create: `README.md`

**Interfaces:**
- Consumes: `shared/contracts.ts`, `server/cloud-dirs.mjs`, `server/paseo-cli.mjs`, `server/reconcile.mjs`
- Produces: Complete Paseo server & client plugin entrypoints.

- [ ] **Step 1: Implement `index.server.ts`**

Register `envSyncSettings` and the 5 RPC handlers (`discoverDirsRpc`, `statusRpc`, `saveRpc`, `applyRpc`, `restoreRpc`). Use a simple in-memory mutex (`let activeOp = false`) per daemon process so two clicks cannot interleave.

- [ ] **Step 2: Implement `client/i18n.mjs`, `client/sync-screen.tsx`, and `index.client.tsx`**

Build a clean single-page UI with:
1. **Cloud Folder Card**: Shows detected cloud drive folders (`iCloud Drive`, `OneDrive`, `Google Drive`) as one-tap pills to fill `syncDir`, or manual `TextInput` + `「保存设置」`.
2. **Environment Status Card**: Shows `manifest.json` last updated time & host, diff summary (missing plugins count, changed settings files list, local directory plugins skipped).
3. **Two Primary Action Buttons**:
   - `「将云盘环境应用到本机」` (calls `applyRpc`, with optional toggle `「同时更新已安装插件」`)
   - `「将本机环境保存到云盘」` (calls `saveRpc`)
4. **Safety Rollback Row**: When `hasBackup` is true, renders `「恢复上一次本机设置」` button (calls `restoreRpc`).

- [ ] **Step 3: Write `OVERVIEW.md` and `README.md`**

Document how the plugin separates cloud sync (iCloud/OneDrive/Google Drive) from local environment application, what files are synced vs excluded, and supported Paseo versions (`>=0.11.4`).

- [ ] **Step 4: Run typecheck, mobile UI audit, and full test suite**

Run:
```bash
npm run typecheck
npm test
rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" client/
```
Expected: `typecheck` passes, all tests pass, `rg` returns no hits.

- [ ] **Step 5: Commit**

```bash
git add index.server.ts index.client.tsx client/ OVERVIEW.md README.md
git commit -m "feat: wire server RPC handlers, client screen UI, and documentation"
```
