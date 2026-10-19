// Translation entries owned by the web search settings domain.
export const enUS: Record<string, string> = {
  searchTab: "Search",
  webSearch: "Web search",
  webSearchDescription:
    "Give the Agent web_search and web_fetch tools for current information. Search runs on DeepSeek; fetched page content is treated as untrusted data.",
  webSearchEnable: "Enable web search tools",
  webSearchBilling:
    "Search and fetch are billed per successful request (DeepSeek charges per 1,000 calls); failed requests are not billed. Each call is recorded in the session execution history.",
  webSearchToolsHint:
    "After enabling, grant the tools per session by choosing Full access in the session tool menu. New sessions keep their own tool choice.",
  webSearchApiKeyOverride: "Dedicated API key (optional)",
  webSearchApiKeyOverridePlaceholder: "Reuse the DeepSeek provider key",
  webSearchApiKeyOverrideSave: "Save key",
  webSearchTest: "Test",
  webSearchTesting: "Testing…",
  webSearchTestPassed: "Test passed",
  webSearchTestFailed: "Test failed",
  webSearchTestDisabledHint: "Enable the switch above to let the Agent use it.",
  webSearchCredentialOverride: "Using the dedicated key saved above.",
  webSearchCredentialProvider: "Using the DeepSeek API key from Settings → Models.",
  webSearchCredentialNone:
    "No key configured. Add a DeepSeek provider in Settings → Models, or save a dedicated key above.",
  webSearchLoadFailed: "Web search settings could not be loaded.",
  webSearchSaveFailed: "Web search settings could not be saved. The previous setting was restored.",
};

export const zhCN: Record<string, string> = {
  searchTab: "搜索",
  webSearch: "网页搜索",
  webSearchDescription:
    "为 Agent 提供 web_search 与 web_fetch 工具以获取最新信息。搜索由 DeepSeek 提供；抓取到的网页内容按不可信数据处理。",
  webSearchEnable: "启用网页搜索工具",
  webSearchBilling:
    "搜索与抓取按成功请求计费（DeepSeek 按每千次调用收费），失败请求不计费。每次调用都会记录在会话执行历史中。",
  webSearchToolsHint: "启用后按会话授权：在会话工具菜单中选择「完全访问」。新会话保留自己的工具选择。",
  webSearchApiKeyOverride: "专用 API Key（可选）",
  webSearchApiKeyOverridePlaceholder: "留空则复用 DeepSeek 服务商 Key",
  webSearchApiKeyOverrideSave: "保存 Key",
  webSearchTest: "测试",
  webSearchTesting: "测试中…",
  webSearchTestPassed: "测试通过",
  webSearchTestFailed: "测试失败",
  webSearchTestDisabledHint: "打开上方开关后 Agent 即可使用。",
  webSearchCredentialOverride: "正在使用上方保存的专用 Key。",
  webSearchCredentialProvider: "正在使用「设置 → 模型」中的 DeepSeek API Key。",
  webSearchCredentialNone: "尚未配置 Key。请在「设置 → 模型」中添加 DeepSeek 服务商，或在上方保存专用 Key。",
  webSearchLoadFailed: "网页搜索设置加载失败。",
  webSearchSaveFailed: "网页搜索设置保存失败，已恢复之前的设置。",
};

export const zhTW: Record<string, string> = {
  searchTab: "搜尋",
  webSearch: "網頁搜尋",
  webSearchDescription:
    "為 Agent 提供 web_search 與 web_fetch 工具以取得最新資訊。搜尋由 DeepSeek 提供；抓取到的網頁內容按不可信資料處理。",
  webSearchEnable: "啟用網頁搜尋工具",
  webSearchBilling:
    "搜尋與抓取按成功請求計費（DeepSeek 按每千次呼叫收費），失敗請求不收費。每次呼叫都會記錄在会话執行歷史中。",
  webSearchToolsHint: "啟用後按会话授權：在会话工具菜单中选择「完整存取」。新会话保留自己的工具選擇。",
  webSearchApiKeyOverride: "專用 API Key（可选）",
  webSearchApiKeyOverridePlaceholder: "留空則復用 DeepSeek 服务商 Key",
  webSearchApiKeyOverrideSave: "儲存 Key",
  webSearchTest: "測試",
  webSearchTesting: "測試中…",
  webSearchTestPassed: "測試通過",
  webSearchTestFailed: "測試失敗",
  webSearchTestDisabledHint: "打開上方開關後 Agent 即可使用。",
  webSearchCredentialOverride: "正在使用上方儲存的專用 Key。",
  webSearchCredentialProvider: "正在使用「設定 → 模型」中的 DeepSeek API Key。",
  webSearchCredentialNone: "尚未設定 Key。请在「設定 → 模型」中加入 DeepSeek 服务商，或在上方儲存專用 Key。",
  webSearchLoadFailed: "網頁搜尋設定載入失敗。",
  webSearchSaveFailed: "網頁搜尋設定儲存失敗，已還原之前的設定。",
};
