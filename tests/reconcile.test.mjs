import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  saveToSyncDir,
  applyFromSyncDir,
  restoreLastBackup,
  inspectStatus,
} from "../server/reconcile.mjs";

function mockAdapter(rows = []) {
  const calls = [];
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    calls,
    async list() {
      return [...byId.values()].map((r) => ({ ...r }));
    },
    async install(plugin) {
      calls.push(["install", plugin.id]);
      byId.set(plugin.id, { id: plugin.id, enabled: true });
    },
    async update(id) {
      calls.push(["update", id]);
    },
    async act(action, id) {
      calls.push([action, id]);
      if (action === "enable" || action === "disable") {
        const row = byId.get(id);
        if (row) row.enabled = action === "enable";
      }
    },
  };
}

async function makeEnv() {
  const base = await mkdtemp(path.join(tmpdir(), "reconcile-"));
  const home = path.join(base, "home");
  const syncDir = path.join(base, "sync", "PaseoSync");
  const stateDir = path.join(base, "state");
  await mkdir(path.join(home, "plugin-settings"), { recursive: true });
  return { base, home, syncDir, stateDir };
}

async function putSetting(home, rel, value) {
  const target = path.join(home, "plugin-settings", rel);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

async function readSetting(home, rel) {
  return JSON.parse(await readFile(path.join(home, "plugin-settings", rel), "utf8"));
}

const machineOneAdapter = () =>
  mockAdapter([
    {
      id: "better-paseo",
      enabled: true,
      installation: { identity: { kind: "git", remote: "https://github.com/RoundRedDot/better-paseo" } },
    },
    {
      id: "genui",
      enabled: false,
      installation: { identity: { kind: "npm", packageName: "paseo-plugin-genui" } },
    },
    { id: "flowly", enabled: true, installation: { identity: { kind: "directory" } } },
  ]);

test("saveToSyncDir writes manifest and settings, excluding private/conflict/broken files", async () => {
  const { home, syncDir } = await makeEnv();
  await putSetting(home, "better-paseo/presentation.json", { unknownFutureField: { deep: [1, 2] }, theme: "dark" });
  await putSetting(home, "better-paseo/tasks.json", { views: [] });
  await putSetting(home, "flowly/board-view.json", { columns: ["todo"] });
  await putSetting(home, "flowly/onboarding.json", { seen: true });
  await putSetting(home, "paseo-env-sync/config.json", { syncDir: "/machine/one/path" });
  await putSetting(home, "better-paseo/half-written.json", '{"truncated":');
  await putSetting(home, "better-paseo/tasks (conflicted copy 2026-11-08).json", { views: ["old"] });

  const result = await saveToSyncDir({ home, syncDir, stateDir: path.join(home, "state"), adapter: machineOneAdapter() });

  assert.deepEqual(result.skippedLocalPlugins, ["flowly"]);
  assert.equal(result.pluginsCount, 2);
  assert.equal(result.settingsCount, 3);
  assert.deepEqual(result.savedAt.length > 0, true);

  const manifest = JSON.parse(await readFile(path.join(syncDir, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(
    manifest.plugins.map((p) => p.id),
    ["better-paseo", "genui"],
  );
  assert.equal(manifest.plugins.find((p) => p.id === "genui").enabled, false);
  assert.deepEqual(manifest.settingsFiles, [
    "better-paseo/presentation.json",
    "better-paseo/tasks.json",
    "flowly/board-view.json",
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(syncDir, "settings", "better-paseo", "presentation.json"), "utf8")),
    { unknownFutureField: { deep: [1, 2] }, theme: "dark" },
  );
  assert.equal(existsSync(path.join(syncDir, "settings", "flowly", "onboarding.json")), false);
  assert.equal(existsSync(path.join(syncDir, "settings", "paseo-env-sync", "config.json")), false);
  assert.equal(existsSync(path.join(syncDir, "settings", "better-paseo", "half-written.json")), false);
  assert.ok(manifest.updatedByHost.length > 0);
});

test("saveToSyncDir rejects a syncDir inside the Paseo home", async () => {
  const { home, base } = await makeEnv();
  await assert.rejects(
    () => saveToSyncDir({ home, syncDir: path.join(home, "inside"), adapter: mockAdapter([]) }),
    /outside|inside/i,
  );
  await assert.rejects(
    () => saveToSyncDir({ home, syncDir: "relative/path", adapter: mockAdapter([]) }),
    /absolute/i,
  );
  void base;
});

test("saveToSyncDir prunes settings removed locally from the sync folder", async () => {
  const { home, syncDir } = await makeEnv();
  await putSetting(home, "better-paseo/presentation.json", { a: 1 });
  await saveToSyncDir({ home, syncDir, adapter: mockAdapter([]) });
  const stale = path.join(syncDir, "settings", "gone-plugin", "old.json");
  await mkdir(path.dirname(stale), { recursive: true });
  await writeFile(stale, "{}");
  await saveToSyncDir({ home, syncDir, adapter: mockAdapter([]) });
  assert.equal(existsSync(stale), false);
});

test("saveToSyncDir keeps the cloud copy when the local file becomes unreadable", async () => {
  const { home, syncDir } = await makeEnv();
  await putSetting(home, "better-paseo/tasks.json", { good: "value" });
  await saveToSyncDir({ home, syncDir, adapter: mockAdapter([]) });
  // local file gets truncated (e.g. plugin crashed mid-write); cloud still good
  await writeFile(path.join(home, "plugin-settings", "better-paseo", "tasks.json"), '{"truncated":');
  await saveToSyncDir({ home, syncDir, adapter: mockAdapter([]) });
  const cloudCopy = JSON.parse(
    await readFile(path.join(syncDir, "settings", "better-paseo", "tasks.json"), "utf8"),
  );
  assert.deepEqual(cloudCopy, { good: "value" });
  const manifest = JSON.parse(await readFile(path.join(syncDir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.settingsFiles, ["better-paseo/tasks.json"]);
});

test("saveToSyncDir never deletes cloud conflict copies or temp files", async () => {
  const { home, syncDir } = await makeEnv();
  await putSetting(home, "better-paseo/tasks.json", { views: [] });
  await saveToSyncDir({ home, syncDir, adapter: mockAdapter([]) });
  const conflicted = path.join(syncDir, "settings", "better-paseo", "tasks (conflicted copy 2026-11-08).json");
  const temp = path.join(syncDir, "settings", "better-paseo", ".tmp-abc123");
  await writeFile(conflicted, JSON.stringify({ fromOtherMachine: true }));
  await writeFile(temp, "{}");
  await saveToSyncDir({ home, syncDir, adapter: mockAdapter([]) });
  assert.equal(existsSync(conflicted), true);
  assert.equal(existsSync(temp), true);
});

test("applyFromSyncDir refuses self and excluded paths listed in the manifest", async () => {
  const { base } = await makeEnv();
  const home = path.join(base, "home6");
  const syncDir = path.join(base, "sync6");
  const stateDir = path.join(base, "state6");
  await putSetting(home, "paseo-env-sync/config.json", { syncDir: "/machine/b/path" });
  await mkdir(path.join(syncDir, "settings", "paseo-env-sync"), { recursive: true });
  await writeFile(
    path.join(syncDir, "settings", "paseo-env-sync", "config.json"),
    JSON.stringify({ syncDir: "C:\\Users\\machineA\\PaseoSync" }),
  );
  await writeFile(
    path.join(syncDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      plugins: [],
      settingsFiles: ["paseo-env-sync/config.json"],
    }),
  );
  const result = await applyFromSyncDir({ home, syncDir, stateDir, adapter: mockAdapter([]) });
  assert.deepEqual(result.settingsWritten, []);
  assert.equal(result.warnings.some((w) => w.includes("paseo-env-sync/config.json")), true);
  assert.deepEqual(await readSetting(home, "paseo-env-sync/config.json"), { syncDir: "/machine/b/path" });
});

test("inspectStatus ignores excluded manifest entries when diffing", async () => {
  const { base } = await makeEnv();
  const home = path.join(base, "home7");
  const syncDir = path.join(base, "sync7");
  await mkdir(path.join(syncDir, "settings", "paseo-env-sync"), { recursive: true });
  await writeFile(path.join(syncDir, "settings", "paseo-env-sync", "config.json"), JSON.stringify({ evil: true }));
  await writeFile(
    path.join(syncDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      plugins: [],
      settingsFiles: ["paseo-env-sync/config.json"],
    }),
  );
  const status = await inspectStatus({ home, syncDir, stateDir: path.join(base, "state7"), adapter: mockAdapter([]) });
  assert.deepEqual(status.changedSettings, []);
});

test("applyFromSyncDir backs up, installs, writes settings verbatim, and rejects corrupted JSON", async () => {
  const { base } = await makeEnv();
  const home = path.join(base, "home2");
  const syncDir = path.join(base, "sync2");
  const stateDir = path.join(base, "state2");
  await putSetting(home, "better-paseo/presentation.json", { theme: "old-local-value" });

  await mkdir(path.join(syncDir, "settings", "better-paseo"), { recursive: true });
  await mkdir(path.join(syncDir, "settings", "flowly"), { recursive: true });
  await writeFile(path.join(syncDir, "settings", "better-paseo", "presentation.json"), JSON.stringify({ theme: "new-cloud-value", extra: [1] }));
  await writeFile(path.join(syncDir, "settings", "better-paseo", "tasks.json"), JSON.stringify({ views: ["x"] }));
  await writeFile(path.join(syncDir, "settings", "flowly", "board-view.json"), JSON.stringify({ columns: ["done"] }));
  await writeFile(path.join(syncDir, "settings", "better-paseo", "half-synced.json"), '{"still uploading');
  await writeFile(
    path.join(syncDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-11-08T18:30:00.000Z",
      updatedByHost: "machine-one",
      plugins: [
        { id: "better-paseo", installSpec: "git:https://github.com/RoundRedDot/better-paseo", pluginPath: ".", enabled: true },
        { id: "genui", installSpec: "npm:paseo-plugin-genui", pluginPath: ".", enabled: false },
        { id: "newplugin", installSpec: "npm:paseo-plugin-new", pluginPath: ".", enabled: true },
      ],
      settingsFiles: [
        "better-paseo/presentation.json",
        "better-paseo/tasks.json",
        "flowly/board-view.json",
        "better-paseo/half-synced.json",
        "../evil/escape.json",
      ],
    }),
  );

  const adapter = mockAdapter([
    { id: "better-paseo", enabled: true, installation: { identity: { kind: "git", remote: "https://x" } } },
    { id: "flowly", enabled: true, installation: { identity: { kind: "directory" } } },
  ]);
  const result = await applyFromSyncDir({ home, syncDir, stateDir, adapter });

  assert.deepEqual(result.installed, ["newplugin"]);
  assert.deepEqual(result.skippedDisabled, ["genui"]);
  assert.deepEqual(result.settingsWritten, [
    "better-paseo/presentation.json",
    "better-paseo/tasks.json",
    "flowly/board-view.json",
  ]);
  assert.equal(result.warnings.some((w) => w.includes("half-synced.json")), true);
  assert.equal(result.warnings.some((w) => w.includes("evil")), true);
  assert.deepEqual(await readSetting(home, "better-paseo/presentation.json"), { theme: "new-cloud-value", extra: [1] });
  assert.deepEqual(await readSetting(home, "flowly/board-view.json"), { columns: ["done"] });
  assert.equal(existsSync(path.join(home, "plugin-settings", "better-paseo", "half-synced.json")), false);
  assert.equal(existsSync(path.join(base, "evil")), false);

  // backup was taken BEFORE overwriting: old local value preserved
  const backup = JSON.parse(await readFile(path.join(stateDir, "last-backup.json"), "utf8"));
  assert.equal(JSON.parse(backup.settings["better-paseo/presentation.json"]).theme, "old-local-value");
  assert.ok(Array.isArray(backup.plugins));

  // reload called for enabled plugins whose settings were written
  assert.equal(adapter.calls.some(([action, id]) => action === "reload" && id === "better-paseo"), true);
  assert.equal(adapter.calls.some(([action, id]) => action === "reload" && id === "flowly"), true);
  assert.equal(adapter.calls.some(([action, id]) => action === "install" && id === "newplugin"), true);
});

test("applyFromSyncDir aligns enablement and honors updateExisting", async () => {
  const { base } = await makeEnv();
  const home = path.join(base, "home3");
  const syncDir = path.join(base, "sync3");
  const stateDir = path.join(base, "state3");
  await mkdir(path.join(syncDir, "settings"), { recursive: true });
  await writeFile(
    path.join(syncDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      plugins: [
        { id: "better-paseo", installSpec: "npm:paseo-plugin-better", pluginPath: ".", enabled: false },
      ],
      settingsFiles: [],
    }),
  );
  const adapter = mockAdapter([
    { id: "better-paseo", enabled: true, installation: { identity: { kind: "npm", packageName: "paseo-plugin-better" } } },
  ]);
  const result = await applyFromSyncDir({ home, syncDir, stateDir, adapter }, { updateExisting: true });
  assert.deepEqual(result.toggled, ["better-paseo"]);
  assert.deepEqual(result.updated, ["better-paseo"]);
  assert.equal(adapter.calls.some(([a, id]) => a === "disable" && id === "better-paseo"), true);
  assert.equal(adapter.calls.some(([a, id]) => a === "update" && id === "better-paseo"), true);
});

test("applyFromSyncDir throws on invalid manifest", async () => {
  const { base } = await makeEnv();
  const syncDir = path.join(base, "sync4");
  await mkdir(syncDir, { recursive: true });
  await writeFile(path.join(syncDir, "manifest.json"), "{broken");
  await assert.rejects(
    () => applyFromSyncDir({ home: path.join(base, "home4"), syncDir, stateDir: path.join(base, "state4"), adapter: mockAdapter([]) }),
    /manifest/i,
  );
});

test("restoreLastBackup puts the exact pre-apply settings back", async () => {
  const { base } = await makeEnv();
  const home = path.join(base, "home5");
  const syncDir = path.join(base, "sync5");
  const stateDir = path.join(base, "state5");
  await putSetting(home, "better-paseo/presentation.json", { theme: "old-local-value" });
  await mkdir(path.join(syncDir, "settings", "better-paseo"), { recursive: true });
  await writeFile(path.join(syncDir, "settings", "better-paseo", "presentation.json"), JSON.stringify({ theme: "new-cloud-value" }));
  await writeFile(
    path.join(syncDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      plugins: [],
      settingsFiles: ["better-paseo/presentation.json"],
    }),
  );
  await applyFromSyncDir({ home, syncDir, stateDir, adapter: mockAdapter([]) });
  assert.deepEqual(await readSetting(home, "better-paseo/presentation.json"), { theme: "new-cloud-value" });

  const result = await restoreLastBackup({ home, syncDir, stateDir, adapter: mockAdapter([]) });
  assert.deepEqual(await readSetting(home, "better-paseo/presentation.json"), { theme: "old-local-value" });
  assert.deepEqual(result.settingsRestored, ["better-paseo/presentation.json"]);
});

test("inspectStatus reports diffs, backup presence, and warning codes", async () => {
  const { home, syncDir, stateDir } = await makeEnv();
  const adapter = machineOneAdapter();

  const empty = await inspectStatus({ home, syncDir, stateDir, adapter });
  assert.equal(empty.configured, true);
  assert.equal(empty.warning, "no-manifest");
  assert.equal(empty.hasBackup, false);

  await putSetting(home, "better-paseo/presentation.json", { theme: "dark" });
  await saveToSyncDir({ home, syncDir, stateDir, adapter });
  await putSetting(home, "better-paseo/presentation.json", { theme: "light" });

  const manifest = JSON.parse(await readFile(path.join(syncDir, "manifest.json"), "utf8"));
  manifest.plugins.push({ id: "newplugin", installSpec: "npm:paseo-plugin-new", pluginPath: ".", enabled: true });
  await writeFile(path.join(syncDir, "manifest.json"), JSON.stringify(manifest));

  const status = await inspectStatus({ home, syncDir, stateDir, adapter });
  assert.equal(status.warning, null);
  assert.equal(status.manifest.updatedByHost.length > 0, true);
  assert.deepEqual(status.missingPlugins, [{ id: "newplugin", installSpec: "npm:paseo-plugin-new" }]);
  assert.deepEqual(status.changedSettings, ["better-paseo/presentation.json"]);
  assert.deepEqual(status.skippedLocalPlugins, ["flowly"]);
  assert.equal(status.hasBackup, false);

  await applyFromSyncDir({ home, syncDir, stateDir, adapter: mockAdapter([]) });
  const after = await inspectStatus({ home, syncDir, stateDir, adapter });
  assert.equal(after.hasBackup, true);
  assert.deepEqual(after.changedSettings, []);
});
