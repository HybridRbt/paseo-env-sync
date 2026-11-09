import { readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteJson,
  canonicalJsonString,
  isConflictOrTempName,
  readValidJsonObject,
  safeChildPath,
  shouldSyncSettingFile,
} from "./files.mjs";
import { toPortablePlugin } from "./paseo-cli.mjs";

const SELF_IDS = ["paseo-env-sync"];
const SCHEMA_VERSION = 1;

function validateSyncDir(syncDir, home) {
  if (typeof syncDir !== "string" || !path.isAbsolute(syncDir)) {
    throw new Error("The sync folder must be an absolute local path");
  }
  const rel = path.relative(path.resolve(home), path.resolve(syncDir));
  if (rel === "" || !(rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error("The sync folder must be outside the Paseo home directory");
  }
}

async function listSyncableSettingRels(home, extraExcludes) {
  const root = path.join(home, "plugin-settings");
  const rels = [];
  let plugins;
  try {
    plugins = await readdir(root, { withFileTypes: true });
  } catch {
    return rels;
  }
  for (const plugin of plugins) {
    if (!plugin.isDirectory() || plugin.isSymbolicLink()) continue;
    let files;
    try {
      files = await readdir(path.join(root, plugin.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || file.isSymbolicLink()) continue;
      if (!shouldSyncSettingFile(plugin.name, file.name, { selfIds: SELF_IDS, extraExcludes })) continue;
      rels.push(`${plugin.name}/${file.name}`);
    }
  }
  return rels;
}

async function snapshotLocalTree(home) {
  const files = {};
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.isFile()) {
        const raw = await readFile(path.join(dir, entry.name), "utf8").catch(() => null);
        if (raw !== null) files[`${prefix}${entry.name}`] = raw;
      }
    }
  }
  await walk(path.join(home, "plugin-settings"), "");
  return files;
}

async function backupPath(ctx) {
  return path.join(ctx.stateDir, "last-backup.json");
}

// A manifest is external input: its settingsFiles entries must pass the same
// exclusion rules as local scanning, so a stale or tampered manifest can never
// overwrite this machine's controller-own or otherwise excluded settings.
function manifestRelAllowed(rel, extraExcludes) {
  const [pluginId, fileName] = rel.split("/");
  return shouldSyncSettingFile(pluginId, fileName, { selfIds: SELF_IDS, extraExcludes });
}

export async function inspectStatus(ctx) {
  const configured = typeof ctx.syncDir === "string" && ctx.syncDir !== "" && path.isAbsolute(ctx.syncDir);
  const base = {
    configured,
    manifest: null,
    missingPlugins: [],
    enablementDiffs: [],
    changedSettings: [],
    skippedLocalPlugins: [],
    hasBackup: existsSync(await backupPath(ctx)),
    warning: null,
  };
  if (!configured) return { ...base, warning: "sync-dir-unset" };

  const rows = await ctx.adapter.list();
  const skippedLocalPlugins = [];
  const localById = new Map();
  for (const row of rows) {
    const { plugin, skippedReason } = toPortablePlugin(row, SELF_IDS);
    if (plugin) localById.set(row.id, row);
    else if (skippedReason === "local-directory" || skippedReason === "unsupported-remote") {
      skippedLocalPlugins.push(row.id);
    }
  }

  const manifest = await readValidJsonObject(path.join(ctx.syncDir, "manifest.json"));
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION || !Array.isArray(manifest.plugins)) {
    return { ...base, skippedLocalPlugins, warning: "no-manifest" };
  }

  const missingPlugins = [];
  const enablementDiffs = [];
  for (const target of manifest.plugins) {
    const local = localById.get(target.id);
    if (!local) {
      if (target.enabled === true) {
        missingPlugins.push({ id: target.id, installSpec: target.installSpec });
      }
      continue;
    }
    if (local.enabled === true && target.enabled !== true) {
      enablementDiffs.push({ id: target.id, local: true, target: false });
    } else if (local.enabled !== true && target.enabled === true) {
      enablementDiffs.push({ id: target.id, local: false, target: true });
    }
  }

  const settingsFiles = Array.isArray(manifest.settingsFiles) ? manifest.settingsFiles : [];
  const changedSettings = [];
  for (const rel of settingsFiles) {
    if (typeof rel !== "string") continue;
    if (!manifestRelAllowed(rel, ctx.extraExcludes)) continue;
    let cloud;
    try {
      cloud = await readValidJsonObject(await safeChildPath(path.join(ctx.syncDir, "settings"), rel));
    } catch {
      continue;
    }
    if (cloud === null) continue;
    const local = await readValidJsonObject(path.join(ctx.home, "plugin-settings", rel));
    if (local === null || canonicalJsonString(local) !== canonicalJsonString(cloud)) {
      changedSettings.push(rel);
    }
  }

  return {
    ...base,
    skippedLocalPlugins,
    manifest: {
      updatedAt: typeof manifest.updatedAt === "string" ? manifest.updatedAt : null,
      updatedByHost: typeof manifest.updatedByHost === "string" ? manifest.updatedByHost : null,
    },
    missingPlugins,
    enablementDiffs,
    changedSettings,
  };
}

export async function saveToSyncDir(ctx) {
  validateSyncDir(ctx.syncDir, ctx.home);
  const rows = await ctx.adapter.list();
  const plugins = [];
  const skippedLocalPlugins = [];
  for (const row of rows) {
    const { plugin, skippedReason } = toPortablePlugin(row, SELF_IDS);
    if (plugin) plugins.push(plugin);
    else if (skippedReason === "local-directory" || skippedReason === "unsupported-remote") {
      skippedLocalPlugins.push(row.id);
    }
  }
  plugins.sort((a, b) => a.id.localeCompare(b.id));

  const settingsDir = path.join(ctx.syncDir, "settings");
  const settingsFiles = [];
  for (const rel of await listSyncableSettingRels(ctx.home, ctx.extraExcludes)) {
    const obj = await readValidJsonObject(path.join(ctx.home, "plugin-settings", rel));
    if (obj === null) {
      // Half-written or corrupt local file: never propagate it — but keep any
      // existing cloud copy listed, or pruning would destroy the last good one.
      if (existsSync(path.join(settingsDir, ...rel.split("/")))) settingsFiles.push(rel);
      continue;
    }
    await atomicWriteJson(await safeChildPath(settingsDir, rel), obj);
    settingsFiles.push(rel);
  }
  settingsFiles.sort();

  // Prune sync-folder settings this machine no longer has — but never touch
  // conflict copies or temp files: they hold another machine's forked data.
  let pluginDirs;
  try {
    pluginDirs = await readdir(settingsDir, { withFileTypes: true });
  } catch {
    pluginDirs = [];
  }
  const keep = new Set(settingsFiles);
  for (const pluginDir of pluginDirs) {
    if (!pluginDir.isDirectory()) continue;
    let files;
    try {
      files = await readdir(path.join(settingsDir, pluginDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || keep.has(`${pluginDir.name}/${file.name}`)) continue;
      if (isConflictOrTempName(file.name)) continue;
      await rm(path.join(settingsDir, pluginDir.name, file.name), { force: true });
    }
  }

  const savedAt = new Date().toISOString();
  await atomicWriteJson(path.join(ctx.syncDir, "manifest.json"), {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: savedAt,
    updatedByHost: os.hostname(),
    plugins,
    settingsFiles,
  });
  return {
    savedAt,
    pluginsCount: plugins.length,
    settingsCount: settingsFiles.length,
    skippedLocalPlugins,
  };
}

export async function applyFromSyncDir(ctx, options = {}) {
  const manifest = await readValidJsonObject(path.join(ctx.syncDir, "manifest.json"));
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION || !Array.isArray(manifest.plugins)) {
    throw new Error("The sync folder has no valid manifest.json (schemaVersion 1)");
  }
  const warnings = [];

  // One-click rollback snapshot of the pre-apply local state.
  const rows = await ctx.adapter.list();
  await atomicWriteJson(await backupPath(ctx), {
    createdAt: new Date().toISOString(),
    plugins: rows,
    settings: await snapshotLocalTree(ctx.home),
  });
  const localById = new Map(rows.map((row) => [row.id, row]));

  const installed = [];
  const updated = [];
  const skippedDisabled = [];
  for (const target of manifest.plugins) {
    const local = localById.get(target.id);
    if (!local) {
      if (target.enabled !== true) {
        skippedDisabled.push(target.id); // install would immediately enable+run code
        continue;
      }
      try {
        await ctx.adapter.install(target);
        installed.push(target.id);
        localById.set(target.id, { id: target.id, enabled: true });
      } catch (error) {
        warnings.push(`install ${target.id}: ${error.message}`);
      }
    } else if (options.updateExisting === true) {
      try {
        await ctx.adapter.update(target.id);
        updated.push(target.id);
      } catch (error) {
        warnings.push(`update ${target.id}: ${error.message}`);
      }
    }
  }

  const settingsWritten = [];
  const touchedPlugins = new Set();
  const settingsFiles = Array.isArray(manifest.settingsFiles) ? manifest.settingsFiles : [];
  for (const rel of settingsFiles) {
    if (typeof rel !== "string") continue;
    if (!manifestRelAllowed(rel, ctx.extraExcludes)) {
      warnings.push(`skipped excluded path ${rel}`);
      continue;
    }
    let obj;
    let cloudPath;
    try {
      cloudPath = await safeChildPath(path.join(ctx.syncDir, "settings"), rel);
      obj = await readValidJsonObject(cloudPath);
    } catch {
      warnings.push(`skipped unsafe path ${rel}`);
      continue;
    }
    if (obj === null) {
      warnings.push(`skipped invalid JSON ${rel}`); // half-synced cloud file: never clobber local
      continue;
    }
    await atomicWriteJson(await safeChildPath(path.join(ctx.home, "plugin-settings"), rel), obj);
    settingsWritten.push(rel);
    touchedPlugins.add(rel.split("/")[0]);
  }

  const toggled = [];
  for (const target of manifest.plugins) {
    const local = localById.get(target.id);
    if (!local) continue;
    if (local.enabled === true && target.enabled !== true) {
      try {
        await ctx.adapter.act("disable", target.id);
        toggled.push(target.id);
      } catch (error) {
        warnings.push(`disable ${target.id}: ${error.message}`);
      }
    } else if (local.enabled !== true && target.enabled === true) {
      try {
        await ctx.adapter.act("enable", target.id);
        toggled.push(target.id);
      } catch (error) {
        warnings.push(`enable ${target.id}: ${error.message}`);
      }
    }
  }
  for (const pluginId of touchedPlugins) {
    const local = localById.get(pluginId);
    if (local && local.enabled === true) {
      try {
        await ctx.adapter.act("reload", pluginId);
      } catch (error) {
        warnings.push(`reload ${pluginId}: ${error.message}`);
      }
    }
  }

  return { installed, updated, toggled, settingsWritten, skippedDisabled, warnings };
}

export async function restoreLastBackup(ctx) {
  const backup = await readValidJsonObject(await backupPath(ctx));
  if (!backup || typeof backup.settings !== "object") {
    throw new Error("No previous backup found on this machine");
  }
  const settingsRestored = [];
  for (const [rel, raw] of Object.entries(backup.settings)) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) continue;
    await atomicWriteJson(await safeChildPath(path.join(ctx.home, "plugin-settings"), rel), obj);
    settingsRestored.push(rel);
  }
  settingsRestored.sort();
  for (const row of Array.isArray(backup.plugins) ? backup.plugins : []) {
    if (!row?.id) continue;
    try {
      await ctx.adapter.act(row.enabled === true ? "enable" : "disable", row.id);
    } catch {
      // plugin may no longer exist locally
    }
  }
  const localRows = await ctx.adapter.list().catch(() => []);
  for (const pluginId of new Set(settingsRestored.map((rel) => rel.split("/")[0]))) {
    if (localRows.some((row) => row.id === pluginId && row.enabled === true)) {
      await ctx.adapter.act("reload", pluginId).catch(() => {});
    }
  }
  return { restoredAt: new Date().toISOString(), settingsRestored };
}
