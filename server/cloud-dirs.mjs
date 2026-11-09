import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export async function discoverCloudFolders(options = {}) {
  const homedir = options.homedir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  const roots = [];
  const add = (provider, root) => roots.push({ provider, root });

  if (platform === "darwin") {
    add(
      "iCloud Drive",
      path.join(homedir, "Library", "Mobile Documents", "com~apple~CloudDocs"),
    );
  }
  if (platform === "win32" && env.USERPROFILE) {
    add("iCloud Drive", path.join(env.USERPROFILE, "iCloudDrive"));
  }

  if (env.OneDriveConsumer) add("OneDrive", env.OneDriveConsumer);
  if (env.OneDrive) add("OneDrive", env.OneDrive);
  add("OneDrive", path.join(homedir, "OneDrive"));
  if (platform === "darwin") {
    add(
      "OneDrive",
      path.join(homedir, "Library", "CloudStorage", "OneDrive-Personal"),
    );
  }

  add("Google Drive", path.join(homedir, "Google Drive", "My Drive"));

  const cloudStorage = path.join(homedir, "Library", "CloudStorage");
  if (existsSync(cloudStorage)) {
    for (const entry of readdirSync(cloudStorage)) {
      if (/^GoogleDrive-/.test(entry)) {
        add("Google Drive", path.join(cloudStorage, entry, "My Drive"));
        add("Google Drive", path.join(cloudStorage, entry, "我的云端硬盘"));
      }
      if (/^Dropbox/.test(entry)) {
        add("Dropbox", path.join(cloudStorage, entry));
      }
    }
  }

  add("Dropbox", path.join(homedir, "Dropbox"));

  const seen = new Set();
  const candidates = [];
  for (const { provider, root } of roots) {
    if (seen.has(root) || !existsSync(root)) continue;
    seen.add(root);
    const syncDir = path.join(root, "PaseoSync");
    candidates.push({
      provider,
      path: syncDir,
      exists: existsSync(path.join(syncDir, "manifest.json")),
    });
  }
  return candidates;
}
