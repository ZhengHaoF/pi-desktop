import type { AppLanguage } from "../shared/app-language";

export function notificationLabels(language: AppLanguage) {
  if (language === "zh-CN") {
    return {
      agentFinishedTitle: "会话已完成",
      agentFinishedBody: "有一个会话在后台完成了本轮任务",
      updateAvailableTitle: "Pi Agent Desktop 有可用更新",
      updateAvailableBody: (version: string | null) => (version ? `版本 ${version} 可供下载。` : "新版本可供下载。"),
    };
  }
  if (language === "zh-TW") {
    return {
      agentFinishedTitle: "對話已完成",
      agentFinishedBody: "有一個對話在背景完成了本輪任務",
      updateAvailableTitle: "Pi Agent Desktop 有可用更新",
      updateAvailableBody: (version: string | null) => (version ? `版本 ${version} 可供下載。` : "新版本可供下載。"),
    };
  }
  return {
    agentFinishedTitle: "Agent finished",
    agentFinishedBody: "A session completed in the background",
    updateAvailableTitle: "Pi Agent Desktop update available",
    updateAvailableBody: (version: string | null) =>
      version ? `Version ${version} is ready to download.` : "A new version is ready to download.",
  };
}
