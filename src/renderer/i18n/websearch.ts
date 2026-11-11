// Translation entries owned by the web search settings domain.
export const enUS: Record<string, string> = {
  searchTab: "Search",
  webSearch: "Web search",
  webSearchDescription:
    "Give the Agent web_search and web_fetch tools for current information. Search is billed per call; fetched page content is treated as untrusted data.",
  webSearchEnable: "Enable web search tools",
  webSearchBilling:
    "Search and fetch are billed per successful request; failed requests are not billed. Each call is recorded in the session execution history.",
  webSearchToolsHint:
    "After enabling, grant the tools per session by choosing Full access in the session tool menu. New sessions keep their own tool choice.",
  webSearchProvider: "Search provider",
  webSearchProviderDeepSeekHint:
    "DeepSeek provides both web_search and web_fetch; charges per 1,000 calls. Reuses the DeepSeek provider key from Settings → Models unless a dedicated key is saved below.",
  webSearchProviderTencentWsaHint:
    "Tencent Yuanbao Search provides web_search only (no web_fetch); it bills per successful call. Configure its own service API KEY below — a DeepSeek key cannot be used here.",
  webSearchApiKeyOverride: "Dedicated API key (optional)",
  webSearchApiKeyOverridePlaceholderDeepSeek: "Reuse the DeepSeek provider key",
  webSearchApiKeyOverridePlaceholderTencentWsa: "Tencent Yuanbao search service API KEY (sk-…)",
  webSearchApiKeyOverrideSave: "Save key",
  webSearchTest: "Test",
  webSearchTesting: "Testing…",
  webSearchTestPassed: "Test passed",
  webSearchTestFailed: "Test failed",
  webSearchTestDisabledHint: "Enable the switch above to let the Agent use it.",
  webSearchCredentialOverride: "Using the dedicated key saved above.",
  webSearchCredentialProvider: "Using the provider API key from Settings → Models.",
  webSearchCredentialNone:
    "No key configured. Add a matching provider in Settings → Models, or save a dedicated key above.",
  webSearchLoadFailed: "Web search settings could not be loaded.",
  webSearchSaveFailed: "Web search settings could not be saved. The previous setting was restored.",
};

export const zhCN: Record<string, string> = {
  searchTab: "搜索",
  webSearch: "网页搜索",
  webSearchDescription:
    "为 Agent 提供 web_search 与 web_fetch 工具以获取最新信息。搜索按次计费；抓取到的网页内容按不可信数据处理。",
  webSearchEnable: "启用网页搜索工具",
  webSearchBilling: "搜索与抓取按成功请求计费，失败请求不计费。每次调用都会记录在会话执行历史中。",
  webSearchToolsHint: "启用后按会话授权：在会话工具菜单中选择「完全访问」。新会话保留自己的工具选择。",
  webSearchProvider: "搜索服务商",
  webSearchProviderDeepSeekHint:
    "DeepSeek 同时提供 web_search 与 web_fetch，按每千次调用收费。未在下方保存专用 Key 时，自动复用「设置 → 模型」中的 DeepSeek 服务商 Key。",
  webSearchProviderTencentWsaHint:
    "腾讯元宝搜索仅提供 web_search（不支持 web_fetch），按成功请求计费。需在下方单独配置元宝搜索服务 API KEY，DeepSeek 的 Key 无法用于元宝搜索。",
  webSearchApiKeyOverride: "专用 API Key（可选）",
  webSearchApiKeyOverridePlaceholderDeepSeek: "留空则复用 DeepSeek 服务商 Key",
  webSearchApiKeyOverridePlaceholderTencentWsa: "腾讯元宝搜索服务 API KEY（sk-…）",
  webSearchApiKeyOverrideSave: "保存 Key",
  webSearchTest: "测试",
  webSearchTesting: "测试中…",
  webSearchTestPassed: "测试通过",
  webSearchTestFailed: "测试失败",
  webSearchTestDisabledHint: "打开上方开关后 Agent 即可使用。",
  webSearchCredentialOverride: "正在使用上方保存的专用 Key。",
  webSearchCredentialProvider: "正在使用「设置 → 模型」中对应服务商的 API Key。",
  webSearchCredentialNone: "尚未配置 Key。请在「设置 → 模型」中添加对应服务商，或在上方保存专用 Key。",
  webSearchLoadFailed: "网页搜索设置加载失败。",
  webSearchSaveFailed: "网页搜索设置保存失败，已恢复之前的设置。",
};

export const zhTW: Record<string, string> = {
  searchTab: "搜尋",
  webSearch: "網頁搜尋",
  webSearchDescription:
    "為 Agent 提供 web_search 與 web_fetch 工具以取得最新資訊。搜尋按次計費；抓取到的網頁內容按不可信資料處理。",
  webSearchEnable: "啟用網頁搜尋工具",
  webSearchBilling: "搜尋與抓取按成功請求計費，失敗請求不收費。每次呼叫都會記錄在会话執行歷史中。",
  webSearchToolsHint: "啟用後按会话授權：在会话工具菜单中选择「完整存取」。新会话保留自己的工具選擇。",
  webSearchProvider: "搜尋服務商",
  webSearchProviderDeepSeekHint:
    "DeepSeek 同時提供 web_search 與 web_fetch，按每千次呼叫收費。未在下方儲存專用 Key 時，自動復用「設定 → 模型」中的 DeepSeek 服務商 Key。",
  webSearchProviderTencentWsaHint:
    "騰訊元寶搜尋僅提供 web_search（不支援 web_fetch），按成功請求計費。需在下方單獨設定元寶搜尋服務 API KEY，DeepSeek 的 Key 無法用於元寶搜尋。",
  webSearchApiKeyOverride: "專用 API Key（可选）",
  webSearchApiKeyOverridePlaceholderDeepSeek: "留空則復用 DeepSeek 服務商 Key",
  webSearchApiKeyOverridePlaceholderTencentWsa: "騰訊元寶搜尋服務 API KEY（sk-…）",
  webSearchApiKeyOverrideSave: "儲存 Key",
  webSearchTest: "測試",
  webSearchTesting: "測試中…",
  webSearchTestPassed: "測試通過",
  webSearchTestFailed: "測試失敗",
  webSearchTestDisabledHint: "打開上方開關後 Agent 即可使用。",
  webSearchCredentialOverride: "正在使用上方儲存的專用 Key。",
  webSearchCredentialProvider: "正在使用「設定 → 模型」中對應服務商的 API Key。",
  webSearchCredentialNone: "尚未設定 Key。请在「設定 → 模型」中加入對應服務商，或在上方儲存專用 Key。",
  webSearchLoadFailed: "網頁搜尋設定載入失敗。",
  webSearchSaveFailed: "網頁搜尋設定儲存失敗，已還原之前的設定。",
};
