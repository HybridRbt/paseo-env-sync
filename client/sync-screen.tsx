import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import type { z } from "zod";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  applyRpc,
  discoverDirsRpc,
  envSyncSettings,
  restoreRpc,
  saveRpc,
  statusRpc,
} from "../shared/contracts";
import {
  formatList,
  formatTime,
  getLanguage,
  setLanguage,
  translator,
  warningText,
} from "./i18n.mjs";

type StatusResult = z.infer<typeof statusRpc.output>;
type CloudFolder = z.infer<typeof discoverDirsRpc.output>["candidates"][number];
type Draft = {
  syncDir: string;
  cliPath: string;
  daemonHome: string;
  updateExisting: boolean;
  extraExcludes: string;
};

function PillButton({
  label,
  selected,
  accent,
  foreground,
  border,
  onPress,
}: {
  label: string;
  selected: boolean;
  accent: string;
  foreground: string;
  border: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? accent : border,
        backgroundColor: selected ? accent : "transparent",
      }}
    >
      <Text style={{ color: selected ? foreground : accent, fontSize: 13 }}>
        {label}
      </Text>
    </Pressable>
  );
}

function PrimaryButton({
  label,
  tone,
  theme,
  disabled,
  onPress,
}: {
  label: string;
  tone: "primary" | "danger";
  theme: PluginSurfaceProps["theme"];
  disabled: boolean;
  onPress: () => void;
}) {
  const colors = theme.colors;
  const danger = tone === "danger";
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 10,
        borderWidth: danger ? 1 : 0,
        borderColor: colors.statusDanger,
        backgroundColor: disabled
          ? colors.surface2
          : danger
            ? "transparent"
            : colors.accent,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Text
        style={{
          textAlign: "center",
          fontWeight: "600",
          fontSize: 14,
          color: disabled
            ? colors.foregroundMuted
            : danger
              ? colors.statusDanger
              : colors.accentForeground,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function DiffList({
  title,
  items,
  theme,
}: {
  title: string;
  items: string[];
  theme: PluginSurfaceProps["theme"];
}) {
  if (items.length === 0) return null;
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>
        {title}
      </Text>
      {items.map((item) => (
        <Text
          key={item}
          selectable
          style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}
        >
          {item}
        </Text>
      ))}
    </View>
  );
}

export function EnvSyncScreen({ theme, host }: PluginSurfaceProps) {
  const settings = useSettings(envSyncSettings);
  const discover = useRpc(discoverDirsRpc);
  const status = useRpc(statusRpc);
  const save = useRpc(saveRpc);
  const apply = useRpc(applyRpc);
  const restore = useRpc(restoreRpc);

  const [draft, setDraft] = useState<Draft>({
    syncDir: "",
    cliPath: "",
    daemonHome: "",
    updateExisting: false,
    extraExcludes: "",
  });
  const [candidates, setCandidates] = useState<CloudFolder[]>([]);
  const [statusResult, setStatusResult] = useState<StatusResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyUpdate, setApplyUpdate] = useState(false);
  const [notice, setNotice] = useState<
    { kind: "ok" | "warn" | "error"; text: string } | null
  >(null);
  const [, setLanguageTick] = useState(0);
  const t = translator();

  const settingsReady = settings.status === "ready";

  useEffect(() => {
    if (settingsReady) {
      setDraft(settings.values);
      setApplyUpdate(settings.values.updateExisting);
    }
  }, [settingsReady, settingsReady ? settings.revision : ""]);

  async function refreshStatus() {
    try {
      setStatusResult(await status({}));
    } catch (error) {
      setNotice({ kind: "error", text: String(error) });
    }
  }

  useEffect(() => {
    if (!settingsReady) return;
    let active = true;
    setNotice(null);
    void (async () => {
      try {
        const found = await discover({});
        if (active) setCandidates(found.candidates);
      } catch {
        // discovery is best-effort; manual path entry still works
      }
      if (active) await refreshStatus();
    })();
    return () => {
      active = false;
    };
    // Re-run when the saved host settings change, not on every draft keystroke.
  }, [host.id, settingsReady, settingsReady ? settings.revision : ""]);

  const dirty =
    settingsReady && JSON.stringify(draft) !== JSON.stringify(settings.values);

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(true);
    setNotice({ kind: "warn", text: `${label}…` });
    try {
      const text = await fn();
      setNotice({ kind: "ok", text });
      await refreshStatus();
    } catch (error) {
      setNotice({ kind: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  const colors = theme.colors;
  const muted = { color: colors.foregroundMuted, fontSize: 13 };
  const statusWarning = statusResult?.warning
    ? warningText(statusResult.warning)
    : null;

  return (
    <ScrollView
      style={{ backgroundColor: colors.surface0, flex: 1 }}
      contentContainerStyle={{ padding: 14, gap: 14, maxWidth: 720 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "700" }}>
          {t("云盘环境同步")}
        </Text>
        <View style={{ flex: 1 }} />
        {(["zh", "en"] as const).map((code) => (
          <PillButton
            key={code}
            label={code === "zh" ? "中文" : "EN"}
            selected={getLanguage() === code}
            accent={colors.accent}
            foreground={colors.accentForeground}
            border={colors.border}
            onPress={() => {
              setLanguage(code);
              setLanguageTick((tick) => tick + 1);
            }}
          />
        ))}
      </View>

      <SettingsSection title={t("云盘环境同步")}>
        <SettingsCard>
          {candidates.length > 0 ? (
            <View style={{ gap: 6 }}>
              <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>
                {t("检测到的云盘")}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {candidates.map((candidate) => (
                  <PillButton
                    key={candidate.path}
                    label={
                      candidate.exists
                        ? `${candidate.provider} ✓`
                        : candidate.provider
                    }
                    selected={draft.syncDir === candidate.path}
                    accent={colors.accent}
                    foreground={colors.accentForeground}
                    border={colors.border}
                    onPress={() => setDraft({ ...draft, syncDir: candidate.path })}
                  />
                ))}
              </View>
              <Text selectable style={muted}>
                {t("点击选用，或手动填写同步目录路径。")}
              </Text>
            </View>
          ) : null}
          <SettingsInput
            label={t("同步目录")}
            hint={t("云盘中的环境文件夹绝对路径，例如 iCloud Drive 里的 PaseoSync。")}
            placeholder="/path/to/PaseoSync"
            initialValue={draft.syncDir}
            onChangeText={(value) => setDraft({ ...draft, syncDir: value })}
          />
          <SettingsInput
            label={t("Paseo CLI 路径（可选）")}
            hint={t("留空时自动查找。")}
            placeholder="paseo"
            initialValue={draft.cliPath}
            onChangeText={(value) => setDraft({ ...draft, cliPath: value })}
          />
          <SettingsInput
            label={t("Paseo 数据目录（可选）")}
            hint={t("留空时使用默认的 ~/.paseo。")}
            initialValue={draft.daemonHome}
            onChangeText={(value) => setDraft({ ...draft, daemonHome: value })}
          />
          <SettingsInput
            label={t("额外排除（可选）")}
            hint={t("每行一个，格式 plugin/file.json。")}
            initialValue={draft.extraExcludes}
            onChangeText={(value) => setDraft({ ...draft, extraExcludes: value })}
          />
          <SettingsAction
            label={t("保存设置")}
            actionLabel={t("保存")}
            disabled={busy || settings.saving || !settingsReady || !dirty}
            onPress={() => {
              if (settingsReady) void settings.save(draft, settings.revision);
            }}
          />
        </SettingsCard>
      </SettingsSection>

      {settings.status === "error" || settings.status === "invalid" ? (
        <Text selectable style={{ color: colors.statusDanger, fontSize: 13 }}>
          {settings.error}
        </Text>
      ) : null}
      {settings.saveError ? (
        <Text selectable style={{ color: colors.statusDanger, fontSize: 13 }}>
          {settings.saveError}
        </Text>
      ) : null}
      {dirty ? <Text style={muted}>{t("请先保存设置，再执行同步操作。")}</Text> : null}

      <SettingsSection title={t("环境状态")}>
        <SettingsCard>
          {statusResult === null ? (
            <Text style={muted}>{t("执行中…")}</Text>
          ) : (
            <View style={{ gap: 8 }}>
              {statusWarning ? (
                <Text selectable style={{ color: colors.statusWarning, fontSize: 13 }}>
                  {statusWarning}
                </Text>
              ) : null}
              {statusResult.manifest ? (
                <Text selectable style={muted}>
                  {t("云端清单：{time} 由 {host} 更新", {
                    time: formatTime(statusResult.manifest.updatedAt, t),
                    host: statusResult.manifest.updatedByHost ?? t("无"),
                  })}
                </Text>
              ) : null}
              <DiffList
                theme={theme}
                title={t("缺失插件（{count}）", {
                  count: statusResult.missingPlugins.length,
                })}
                items={statusResult.missingPlugins.map(
                  (plugin) => `${plugin.id} (${plugin.installSpec})`,
                )}
              />
              <DiffList
                theme={theme}
                title={t("启用状态差异（{count}）", {
                  count: statusResult.enablementDiffs.length,
                })}
                items={statusResult.enablementDiffs.map(
                  (diff) =>
                    `${diff.id}: ${diff.local ? "on" : "off"} → ${diff.target ? "on" : "off"}`,
                )}
              />
              <DiffList
                theme={theme}
                title={t("内容有差异的设置文件（{count}）", {
                  count: statusResult.changedSettings.length,
                })}
                items={statusResult.changedSettings}
              />
              {statusResult.skippedLocalPlugins.length > 0 ? (
                <Text selectable style={muted}>
                  {t("本机无法导出的插件：{list}", {
                    list: formatList(statusResult.skippedLocalPlugins, t),
                  })}
                </Text>
              ) : null}
            </View>
          )}
          <SettingsAction
            label={t("环境状态")}
            actionLabel={t("刷新")}
            disabled={busy || !settingsReady || dirty}
            onPress={() => void refreshStatus()}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("操作")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("同时更新已安装插件")}
            value={applyUpdate}
            onValueChange={setApplyUpdate}
            disabled={busy}
          />
          <View style={{ gap: 8 }}>
            <PrimaryButton
              label={t("将云盘环境应用到本机")}
              tone="primary"
              theme={theme}
              disabled={busy || !settingsReady || dirty}
              onPress={() =>
                void run(t("将云盘环境应用到本机"), async () => {
                  const result = await apply({ updateExisting: applyUpdate });
                  const parts = [
                    t("应用完成：新装 {installed}、切换启用 {toggled}、写入 {settings} 个设置文件。", {
                      installed: result.installed.join("、") || t("无"),
                      toggled: result.toggled.join("、") || t("无"),
                      settings: result.settingsWritten.length,
                    }),
                  ];
                  if (result.warnings.length > 0) {
                    parts.push(t("注意：{list}", { list: result.warnings.join("；") }));
                  }
                  return parts.join("\n");
                })
              }
            />
            <PrimaryButton
              label={t("将本机环境保存到云盘")}
              tone="primary"
              theme={theme}
              disabled={busy || !settingsReady || dirty}
              onPress={() =>
                void run(t("将本机环境保存到云盘"), async () => {
                  const result = await save({});
                  const parts = [
                    t("保存完成：{plugins} 个插件、{settings} 个设置文件。", {
                      plugins: result.pluginsCount,
                      settings: result.settingsCount,
                    }),
                  ];
                  if (result.skippedLocalPlugins.length > 0) {
                    parts.push(
                      t("本机无法导出的插件：{list}", {
                        list: formatList(result.skippedLocalPlugins, t),
                      }),
                    );
                  }
                  return parts.join("\n");
                })
              }
            />
            {statusResult?.hasBackup ? (
              <PrimaryButton
                label={t("恢复上一次本机设置")}
                tone="danger"
                theme={theme}
                disabled={busy || !settingsReady}
                onPress={() =>
                  void run(t("恢复上一次本机设置"), async () => {
                    const result = await restore({});
                    return t("恢复完成：{count} 个设置文件已还原。", {
                      count: result.settingsRestored.length,
                    });
                  })
                }
              />
            ) : null}
          </View>
        </SettingsCard>
      </SettingsSection>

      {notice ? (
        <Text
          selectable
          style={{
            fontSize: 13,
            color:
              notice.kind === "error"
                ? colors.statusDanger
                : notice.kind === "warn"
                  ? colors.statusWarning
                  : colors.statusSuccess,
          }}
        >
          {notice.text}
        </Text>
      ) : null}
    </ScrollView>
  );
}
