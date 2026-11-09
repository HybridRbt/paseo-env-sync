import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const text = z
  .string()
  .max(4096)
  .refine((s) => !/[\x00-\x1f]/.test(s), "Control characters are not allowed");

export const envSyncSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: z.object({
    syncDir: text.default(""),
    cliPath: text.default(""),
    daemonHome: text.default(""),
    updateExisting: z.boolean().default(false),
    extraExcludes: text.default(""),
  }),
});

const cloudFolder = z.object({
  provider: z.string(),
  path: z.string(),
  exists: z.boolean(),
});

export const discoverDirsRpc = defineRpc({
  name: "envSync.discoverDirs",
  input: z.object({}),
  output: z.object({
    candidates: z.array(cloudFolder),
  }),
});

export const statusRpc = defineRpc({
  name: "envSync.status",
  input: z.object({}),
  output: z.object({
    configured: z.boolean(),
    manifest: z
      .object({
        updatedAt: z.string().nullable(),
        updatedByHost: z.string().nullable(),
      })
      .nullable(),
    missingPlugins: z.array(
      z.object({ id: z.string(), installSpec: z.string() }),
    ),
    enablementDiffs: z.array(
      z.object({ id: z.string(), local: z.boolean(), target: z.boolean() }),
    ),
    changedSettings: z.array(z.string()),
    skippedLocalPlugins: z.array(z.string()),
    hasBackup: z.boolean(),
    warning: z.string().nullable(),
  }),
});

export const saveRpc = defineRpc({
  name: "envSync.save",
  input: z.object({}),
  output: z.object({
    savedAt: z.string(),
    pluginsCount: z.number(),
    settingsCount: z.number(),
    skippedLocalPlugins: z.array(z.string()),
  }),
});

export const applyRpc = defineRpc({
  name: "envSync.apply",
  input: z.object({
    updateExisting: z.boolean().optional(),
  }),
  output: z.object({
    installed: z.array(z.string()),
    updated: z.array(z.string()),
    toggled: z.array(z.string()),
    settingsWritten: z.array(z.string()),
    skippedDisabled: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
});

export const restoreRpc = defineRpc({
  name: "envSync.restore",
  input: z.object({}),
  output: z.object({
    restoredAt: z.string(),
    settingsRestored: z.array(z.string()),
  }),
});
