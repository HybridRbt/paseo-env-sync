import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  shouldSyncSettingFile,
  canonicalJsonString,
  safeChildPath,
  readValidJsonObject,
  atomicWriteJson,
} from "../server/files.mjs";

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

test("shouldSyncSettingFile honors caller-supplied selfIds and extraExcludes", () => {
  assert.equal(shouldSyncSettingFile("my-controller", "config.json", { selfIds: ["my-controller"] }), false);
  assert.equal(shouldSyncSettingFile("some-plugin", "secret.json", { extraExcludes: ["some-plugin/secret.json"] }), false);
  assert.equal(shouldSyncSettingFile("some-plugin", "other.json", { extraExcludes: ["some-plugin/secret.json"] }), true);
});

test("shouldSyncSettingFile rejects non-json and hidden plugin dirs", () => {
  assert.equal(shouldSyncSettingFile("better-paseo", "notes.txt"), false);
  assert.equal(shouldSyncSettingFile(".git", "config.json"), false);
});

test("safeChildPath rejects traversal, absolute, and symlinked segments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "safe-child-"));
  await mkdir(path.join(root, "real"));
  await symlink(path.join(root, "real"), path.join(root, "link"));

  const joined = await safeChildPath(root, "real/file.json");
  assert.equal(joined, path.join(root, "real", "file.json"));

  await assert.rejects(() => safeChildPath(root, "../escape.json"));
  await assert.rejects(() => safeChildPath(root, "a/../b.json"));
  await assert.rejects(() => safeChildPath(root, "/etc/passwd"));
  await assert.rejects(() => safeChildPath(root, "link/file.json"), /symlink|realpath/i);
});

test("safeChildPath rejects Windows drive-relative segments that would escape the root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "safe-child-"));
  await assert.rejects(() => safeChildPath(root, "C:evil.json"), /drive|escape|not allowed/i);
  await assert.rejects(() => safeChildPath(root, "better-paseo/C:evil.json"), /drive|escape|not allowed/i);
});

test("readValidJsonObject returns object for valid JSON and null otherwise", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "read-json-"));
  const good = path.join(dir, "good.json");
  const bad = path.join(dir, "bad.json");
  const truncated = path.join(dir, "truncated.json");
  await atomicWriteJson(good, { a: 1 });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(bad, "not json at all {");
  await writeFile(truncated, '{"a": 1, "b":');
  assert.deepEqual(await readValidJsonObject(good), { a: 1 });
  assert.equal(await readValidJsonObject(bad), null);
  assert.equal(await readValidJsonObject(truncated), null);
  assert.equal(await readValidJsonObject(path.join(dir, "missing.json")), null);
});

test("atomicWriteJson writes parseable JSON and leaves no temp files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atomic-write-"));
  const target = path.join(dir, "nested", "file.json");
  await atomicWriteJson(target, { z: [1, 2], y: "s" });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { z: [1, 2], y: "s" });
  const files = await readdir(path.join(dir, "nested"));
  assert.deepEqual(files, ["file.json"]);
  // overwrite keeps it atomic and single-file
  await atomicWriteJson(target, { only: true });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { only: true });
});
