import test from "node:test";
import assert from "node:assert/strict";
import {
  toPortablePlugin,
  installArgs,
  trampolineTarget,
} from "../server/paseo-cli.mjs";

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

test("toPortablePlugin excludes controller self and unsupported git remotes", () => {
  assert.deepEqual(toPortablePlugin({ id: "paseo-env-sync", enabled: true, installation: { identity: { kind: "npm", packageName: "paseo-env-sync" } } }, ["paseo-env-sync"]), {
    plugin: null,
    skippedReason: "self",
  });
  assert.deepEqual(toPortablePlugin({ id: "weird", enabled: true, installation: { identity: { kind: "git", remote: "file:///local/repo" } } }), {
    plugin: null,
    skippedReason: "unsupported-remote",
  });
  assert.deepEqual(toPortablePlugin({ id: "sshok", enabled: true, installation: { identity: { kind: "git", remote: "git@github.com:RoundRedDot/better-paseo.git" } } }).plugin.installSpec, "git:git@github.com:RoundRedDot/better-paseo.git");
  assert.deepEqual(toPortablePlugin({ id: "noidentity", enabled: true, installation: {} }), {
    plugin: null,
    skippedReason: "local-directory",
  });
});

test("installArgs adds --path only for non-root plugin paths", () => {
  assert.deepEqual(
    installArgs({ id: "mono", installSpec: "git:https://example.com/mono", pluginPath: "packages/plugin" }, "/h"),
    ["plugin", "install", "git:https://example.com/mono", "--id", "mono", "--path", "packages/plugin", "--home", "/h", "--json"],
  );
});

test("trampolineTarget recognizes the Windows first-run .cmd shape and rejects others", () => {
  const content = [
    '@echo off',
    'set "BUNDLED_CLI=C:\\Users\\t\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd"',
    'call "%BUNDLED_CLI%" %*',
  ].join("\r\n");
  assert.equal(trampolineTarget(content), "C:\\Users\\t\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd");
  assert.equal(trampolineTarget("@echo off\r\necho hi"), null);
  assert.equal(trampolineTarget(null), null);
});
