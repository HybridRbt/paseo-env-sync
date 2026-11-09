import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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

test("discoverCloudFolders marks exists only when a PaseoSync manifest is present", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "cloud-home-"));
  const dropboxRoot = path.join(fakeHome, "Dropbox");
  const gdriveRoot = path.join(fakeHome, "Google Drive", "My Drive");
  await mkdir(dropboxRoot, { recursive: true });
  await mkdir(gdriveRoot, { recursive: true });
  await mkdir(path.join(gdriveRoot, "PaseoSync"), { recursive: true });
  await writeFile(path.join(gdriveRoot, "PaseoSync", "manifest.json"), "{}");

  const candidates = await discoverCloudFolders({
    homedir: fakeHome,
    platform: "darwin",
    env: {},
  });
  const dropbox = candidates.find((c) => c.provider === "Dropbox");
  assert.equal(dropbox.path, path.join(dropboxRoot, "PaseoSync"));
  assert.equal(dropbox.exists, false);
  const gdrive = candidates.find((c) => c.provider === "Google Drive");
  assert.equal(gdrive.path, path.join(gdriveRoot, "PaseoSync"));
  assert.equal(gdrive.exists, true);
});

test("discoverCloudFolders returns empty for a home without cloud roots", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "cloud-home-"));
  const candidates = await discoverCloudFolders({
    homedir: fakeHome,
    platform: "linux",
    env: {},
  });
  assert.deepEqual(candidates, []);
});
