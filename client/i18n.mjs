// Bilingual UI strings. Chinese is the source of truth (keys); English maps
// from it. Language is per client session — no persistent storage is touched,
// so the client bundle stays free of web-storage APIs.
const english = {
  云盘环境同步: "Cloud Drive Env Sync",
  检测到的云盘: "Detected cloud drives",
  "点击选用，或手动填写同步目录路径。":
    "Tap to use one, or type the sync folder path manually.",
  同步目录: "Sync folder",
  "云盘中的环境文件夹绝对路径，例如 iCloud Drive 里的 PaseoSync。":
    'Absolute path of the env folder in your cloud drive, e.g. PaseoSync in iCloud Drive.',
  "Paseo CLI 路径（可选）": "Paseo CLI path (optional)",
  "留空时自动查找。": "Left empty to auto-detect.",
  "Paseo 数据目录（可选）": "Paseo data directory (optional)",
  "留空时使用默认的 ~/.paseo。": "Left empty to use the default ~/.paseo.",
  "额外排除（可选）": "Extra excludes (optional)",
  "每行一个，格式 plugin/file.json。": "One per line, format plugin/file.json.",
  保存设置: "Save settings",
  保存: "Save",
  "设置文件无法读取，可能已损坏或由旧版本生成；可重置为默认设置后重新填写。":
    "The settings file could not be read. It may be corrupted or written by an older version. Reset it to defaults and fill it in again.",
  "原始错误：{error}": "Underlying error: {error}",
  重置为默认设置: "Reset to defaults",
  重置: "Reset",
  环境状态: "Environment status",
  "设置不可用，暂无法加载环境状态。":
    "Settings unavailable; environment status cannot load yet.",
  刷新: "Refresh",
  "尚未设置云盘同步目录。": "The cloud sync folder is not set yet.",
  "云盘目录中没有有效的 manifest.json；请先在一台机器上执行「将本机环境保存到云盘」。":
    'No valid manifest.json in the cloud folder; run "Save this machine to the cloud" on one machine first.',
  "云端清单：{time} 由 {host} 更新":
    "Cloud manifest: updated {time} by {host}",
  "缺失插件（{count}）": "Missing plugins ({count})",
  "启用状态差异（{count}）": "Enablement differences ({count})",
  "内容有差异的设置文件（{count}）":
    "Changed settings files ({count})",
  "本机无法导出的插件：{list}":
    "Plugins this machine cannot export: {list}",
  操作: "Actions",
  同时更新已安装插件: "Also update installed plugins",
  "「apply」时不锁版本；开启后对已安装插件执行 plugin update。":
    'Unpinned by default; when on, "apply" also runs plugin update.',
  将云盘环境应用到本机: "Apply cloud folder to this machine",
  将本机环境保存到云盘: "Save this machine to the cloud folder",
  恢复上一次本机设置: "Restore last local settings",
  "执行中…": "Working…",
  "请先保存设置，再执行同步操作。":
    "Save the settings before running a sync action.",
  "保存完成：{plugins} 个插件、{settings} 个设置文件。":
    "Saved {plugins} plugins and {settings} settings files.",
  "应用完成：新装 {installed}、切换启用 {toggled}、写入 {settings} 个设置文件。":
    "Applied: installed {installed}, toggled {toggled}, wrote {settings} settings files.",
  "恢复完成：{count} 个设置文件已还原。":
    "Restored {count} settings files.",
  "注意：{list}": "Notes: {list}",
  无: "none",
  中文: "中文",
};

const warningStrings = {
  "sync-dir-unset": "尚未设置云盘同步目录。",
  "no-manifest":
    "云盘目录中没有有效的 manifest.json；请先在一台机器上执行「将本机环境保存到云盘」。",
};

let language = "zh";

export function setLanguage(code) {
  if (code === "zh" || code === "en") language = code;
}

export function getLanguage() {
  return language;
}

export function translator() {
  return (key, values = {}) => {
    const text = language === "en" ? (english[key] ?? key) : key;
    return text.replace(/\{([a-zA-Z]+)\}/g, (match, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : match,
    );
  };
}

export function warningText(code) {
  const entry = warningStrings[code];
  if (!entry) return code;
  return language === "en" ? (english[entry] ?? entry) : entry;
}

export function formatList(items, t) {
  if (!items || items.length === 0) return t("无");
  return items.join("、");
}

export function formatTime(iso, t) {
  if (!iso) return t("无");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
