import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const BUILTIN_EXCLUDED_PLUGINS = new Set(["paseo-env-sync", "paseo-sync"]);
const BUILTIN_EXCLUDED_REL = new Set([
  "flowly/onboarding.json",
  "flowly/device-language.json",
]);
const CONFLICT_RE = /conflicted copy|冲突副本|-conflict-|\(1\)\.json$/i;

// Cloud-drive fork copies and editor temp files: never propagate them, but
// also never prune them from the sync folder — they hold another machine's
// forked data the user may still want to compare or merge.
export function isConflictOrTempName(fileName) {
  return fileName.startsWith(".") || fileName.startsWith("~") || CONFLICT_RE.test(fileName);
}

function isPlainSegment(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

export function shouldSyncSettingFile(pluginId, fileName, options = {}) {
  if (!isPlainSegment(pluginId) || !isPlainSegment(fileName)) return false;
  if (pluginId.startsWith(".") || pluginId.startsWith("~")) return false;
  if (!fileName.endsWith(".json")) return false;
  if (fileName.startsWith(".") || fileName.startsWith("~")) return false;
  if (CONFLICT_RE.test(fileName)) return false;
  const selfIds = new Set([...BUILTIN_EXCLUDED_PLUGINS, ...(options.selfIds ?? [])]);
  if (selfIds.has(pluginId)) return false;
  const rel = `${pluginId}/${fileName}`;
  if (BUILTIN_EXCLUDED_REL.has(rel)) return false;
  if ((options.extraExcludes ?? []).includes(rel)) return false;
  return true;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

export function canonicalJsonString(value) {
  return JSON.stringify(sortKeys(value));
}

export async function readValidJsonObject(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function safeChildPath(rootDir, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("Empty relative path");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Absolute paths are not allowed: ${relativePath}`);
  }
  const parts = relativePath.split(/[\\/]+/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Path traversal is not allowed: ${relativePath}`);
  }
  // Drive-relative segments like "C:foo" are not absolute, but win32 resolve
  // anchors them to the drive's CWD, escaping the root entirely.
  if (parts.some((part) => /^[A-Za-z]:/.test(part))) {
    throw new Error(`Drive-relative paths are not allowed: ${relativePath}`);
  }
  // Reject symlinked components with lstat (stat would follow the link).
  // A missing component — intermediate or leaf — just stops the walk: it
  // cannot be a symlink, and the caller (atomicWriteJson) creates parents.
  // Containment holds via segment validation: no empty/dot/dotdot parts and
  // a relative input, so resolve(rootDir, ...parts) can never escape rootDir.
  let current = rootDir;
  for (const part of parts) {
    current = path.join(current, part);
    let st;
    try {
      st = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Symlink components are not allowed: ${relativePath}`);
    }
  }
  return path.resolve(rootDir, ...parts);
}

async function renameWithRetry(src, dst, attempts = 5) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(src, dst);
      return;
    } catch (error) {
      // Windows file locks (EPERM/EACCES) clear quickly; retry briefly.
      if (
        (error.code === "EPERM" || error.code === "EACCES") &&
        attempt < attempts - 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

export async function atomicWriteJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.tmp-${randomUUID()}`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  try {
    await renameWithRetry(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
