import type { PluginServerContext } from "@getpaseo/plugin/server";
import os from "node:os";
import path from "node:path";
import {
  applyRpc,
  discoverDirsRpc,
  envSyncSettings,
  restoreRpc,
  saveRpc,
  statusRpc,
} from "./shared/contracts";
import { discoverCloudFolders } from "./server/cloud-dirs.mjs";
import { makeCliAdapter } from "./server/paseo-cli.mjs";
import {
  applyFromSyncDir,
  inspectStatus,
  restoreLastBackup,
  saveToSyncDir,
} from "./server/reconcile.mjs";

interface RuntimeConfig {
  home: string;
  syncDir: string;
  stateDir: string;
  extraExcludes: string[];
  updateExisting: boolean;
  cliPath: string | undefined;
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(envSyncSettings);

  // In-memory mutex: one save/apply/restore at a time per daemon process, so
  // two quick clicks can never interleave a backup with an apply.
  let active = false;
  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (active) throw new Error("另一个同步操作正在进行中，请稍后再试");
    active = true;
    try {
      return await fn();
    } finally {
      active = false;
    }
  }

  async function runtime(): Promise<RuntimeConfig> {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(state.error);
    const home =
      state.values.daemonHome.trim() || path.join(os.homedir(), ".paseo");
    const extraExcludes = state.values.extraExcludes
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return {
      home,
      syncDir: state.values.syncDir.trim(),
      stateDir: path.join(home, "plugin-data", "paseo-env-sync"),
      extraExcludes,
      updateExisting: state.values.updateExisting,
      cliPath: state.values.cliPath.trim() || undefined,
    };
  }

  async function reconcileContext() {
    const config = await runtime();
    const adapter = await makeCliAdapter(config.home, config.cliPath);
    return { config, adapter };
  }

  server.handle(discoverDirsRpc, async () => ({
    candidates: await discoverCloudFolders(),
  }));

  server.handle(statusRpc, () =>
    exclusive(async () => {
      const { config, adapter } = await reconcileContext();
      return inspectStatus({
        home: config.home,
        syncDir: config.syncDir,
        stateDir: config.stateDir,
        adapter,
        extraExcludes: config.extraExcludes,
      });
    }),
  );

  server.handle(saveRpc, () =>
    exclusive(async () => {
      const { config, adapter } = await reconcileContext();
      if (!config.syncDir) throw new Error("请先在设置中填写云盘同步目录");
      return saveToSyncDir({
        home: config.home,
        syncDir: config.syncDir,
        stateDir: config.stateDir,
        adapter,
        extraExcludes: config.extraExcludes,
      });
    }),
  );

  server.handle(applyRpc, (input) =>
    exclusive(async () => {
      const { config, adapter } = await reconcileContext();
      if (!config.syncDir) throw new Error("请先在设置中填写云盘同步目录");
      return applyFromSyncDir(
        {
          home: config.home,
          syncDir: config.syncDir,
          stateDir: config.stateDir,
          adapter,
          extraExcludes: config.extraExcludes,
        },
        { updateExisting: input.updateExisting ?? config.updateExisting },
      );
    }),
  );

  server.handle(restoreRpc, () =>
    exclusive(async () => {
      const { config, adapter } = await reconcileContext();
      return restoreLastBackup({
        home: config.home,
        syncDir: config.syncDir,
        stateDir: config.stateDir,
        adapter,
        extraExcludes: config.extraExcludes,
      });
    }),
  );

  return () => {};
}
