import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const exec = promisify(execFile);

const BUILTIN_SELF_IDS = ["paseo-env-sync", "paseo-sync"];

// Spec §3.2: extract a portable, unpinned install spec from a plugin row.
// npm -> npm:<packageName>, git -> git:<remote> (https:// or git@ only),
// directory/missing identity -> skipped as local-directory.
export function toPortablePlugin(row, selfIds = []) {
  const id = typeof row?.id === "string" ? row.id : "";
  if (!id) return { plugin: null, skippedReason: "invalid-row" };
  if ([...BUILTIN_SELF_IDS, ...selfIds].includes(id)) {
    return { plugin: null, skippedReason: "self" };
  }
  const identity = row.installation?.identity;
  if (!identity) return { plugin: null, skippedReason: "local-directory" };
  if (identity.kind === "npm" && typeof identity.packageName === "string" && identity.packageName) {
    return {
      plugin: {
        id,
        installSpec: `npm:${identity.packageName}`,
        pluginPath: ".",
        enabled: row.enabled === true,
      },
      skippedReason: null,
    };
  }
  if (identity.kind === "git" && typeof identity.remote === "string") {
    if (!/^(https:\/\/|git@)/.test(identity.remote)) {
      return { plugin: null, skippedReason: "unsupported-remote" };
    }
    return {
      plugin: {
        id,
        installSpec: `git:${identity.remote}`,
        pluginPath: ".",
        enabled: row.enabled === true,
      },
      skippedReason: null,
    };
  }
  return { plugin: null, skippedReason: "local-directory" };
}

// Unpinned install: no @version and no --ref, so a new machine installs the
// latest available revision (spec §3.2).
export function installArgs(plugin, home) {
  const args = ["plugin", "install", plugin.installSpec, "--id", plugin.id];
  if (plugin.pluginPath && plugin.pluginPath !== ".") {
    args.push("--path", plugin.pluginPath);
  }
  args.push("--home", home, "--json");
  return args;
}

export function windowsLaunch(shim) {
  const resources = path.win32.dirname(path.win32.dirname(shim));
  return {
    command: path.win32.join(resources, "..", "Paseo.exe"),
    args: [
      "--disable-warning=DEP0040",
      path.win32.join(resources, "app.asar.unpacked", "dist", "daemon", "node-entrypoint-runner.js"),
      "node-script",
      path.win32.join(resources, "app.asar", "node_modules", "@getpaseo", "cli", "dist", "index.js"),
    ],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      PASEO_NODE_ENV: "production",
      PASEO_DESKTOP_MANAGED: "1",
      PASEO_CLI: shim,
    },
    shell: false,
  };
}

export function parseJsonOutput(stdout) {
  const value = JSON.parse(stdout.trim());
  if (value?.error) {
    throw new Error(`Paseo ${value.error.code ?? "ERROR"}: ${value.error.message ?? "request failed"}`);
  }
  return value;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function locate(explicit) {
  if (explicit) return explicit;
  const names = process.platform === "win32" ? ["paseo.exe", "paseo.cmd", "paseo"] : ["paseo"];
  for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!folder) continue;
    for (const name of names) {
      const p = path.join(folder, name);
      if (await exists(p)) return p;
    }
  }
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Paseo.app/Contents/Resources/bin/paseo",
        path.join(os.homedir(), "Applications/Paseo.app/Contents/Resources/bin/paseo"),
      ]
    : [
        // Paseo's first-run setup drops a trampoline here on fresh Windows installs.
        path.join(os.homedir(), ".local", "bin", "paseo.cmd"),
        path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Programs", "Paseo", "resources", "bin", "paseo.cmd"),
      ];
  for (const p of candidates) if (await exists(p)) return p;
  throw new Error("Paseo CLI not found. Install its CLI entry from Paseo, or set the plugin CLI path setting.");
}

// Paseo's first-run setup writes a .cmd trampoline at %USERPROFILE%\.local\bin\paseo.cmd that
// bakes in only the bundled shim's path. Recognize that exact shape and return the target —
// resolution then validates the target instead of executing the trampoline.
export function trampolineTarget(content) {
  if (typeof content !== "string" || content.length > 65536) return null;
  const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const set = text.match(/^[^\S\n]*set[^\S\n]+"BUNDLED_CLI=([^"\n]+)"[^\S\n]*$/im);
  if (!set) return null;
  if (!/^[^\S\n]*call[^\S\n]+"%BUNDLED_CLI%"/im.test(text)) return null;
  const target = set[1].trim();
  // Absolute local or UNC path only; %VAR% expansion is never interpreted.
  if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(target) || /["%\n]/.test(target)) return null;
  return target;
}

async function desktopLayout(shim) {
  const desktop = windowsLaunch(shim);
  return (await exists(desktop.command)) && (await exists(desktop.args[1])) ? desktop : null;
}

async function trampolineLayout(executable) {
  let content;
  try {
    content = await readFile(executable, "utf8");
  } catch {
    return null;
  }
  const target = trampolineTarget(content);
  if (!target) return null;
  const shim = path.win32.resolve(target);
  const desktop = await desktopLayout(shim);
  if (!desktop) {
    throw new Error(`Paseo CLI trampoline ${executable} points to a bundled CLI at ${shim} that is missing; reinstall the Paseo desktop app or set the plugin CLI path setting.`);
  }
  return desktop;
}

export async function resolveWindowsLaunch(executable) {
  const desktop = (await desktopLayout(executable)) ?? (await trampolineLayout(executable));
  if (desktop) return desktop;
  // npm's normal global shim: resolve its package bin without executing cmd.exe.
  const unsupported = () =>
    new Error(`Unsupported Windows Paseo shim ${executable}; use the official desktop CLI or npm @getpaseo/cli, or set the plugin CLI path setting.`);
  const packageRoot = path.join(path.dirname(executable), "node_modules", "@getpaseo", "cli");
  let pkg;
  try {
    pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw unsupported();
    throw error;
  }
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.paseo;
  if (!bin || path.isAbsolute(bin) || bin.split(/[\\/]/).includes("..")) throw unsupported();
  return {
    command: process.execPath,
    args: [path.join(packageRoot, bin)],
    env: {},
    shell: false,
  };
}

export async function makeCliAdapter(home, explicitCliPath) {
  const executable = await realpath(await locate(explicitCliPath));
  let launch = { command: executable, args: [], env: {}, shell: false };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    launch = await resolveWindowsLaunch(executable);
  }
  const call = async (args) => {
    try {
      const childEnv = { ...process.env, ...launch.env };
      if (!launch.env.ELECTRON_RUN_AS_NODE) delete childEnv.ELECTRON_RUN_AS_NODE;
      const { stdout } = await exec(launch.command, [...launch.args, ...args], {
        env: childEnv,
        shell: false,
        timeout: 240000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      return parseJsonOutput(stdout);
    } catch (error) {
      if (error.stdout) {
        try {
          parseJsonOutput(error.stdout);
        } catch (inner) {
          throw inner;
        }
      }
      const detail = (error.stderr ?? "")
        .split("\n")
        .filter((line) => !/(token|secret|api.?key|authorization|credential)/i.test(line))
        .join("\n")
        .slice(-1600);
      throw new Error(`Paseo command failed (${args.slice(0, 2).join(" ")}): ${error.code ?? error.message}${detail ? `\n${detail}` : ""}`);
    }
  };
  return {
    executable,
    async list() {
      const rows = await call(["plugin", "ls", "--home", home, "--json"]);
      if (!Array.isArray(rows)) throw new Error("Unexpected plugin list response");
      return rows;
    },
    install: (plugin) => call(installArgs(plugin, home)),
    update: (id) => call(["plugin", "update", id, "--home", home, "--json"]),
    act: (action, id) => call(["plugin", action, id, "--home", home, "--json"]),
  };
}
