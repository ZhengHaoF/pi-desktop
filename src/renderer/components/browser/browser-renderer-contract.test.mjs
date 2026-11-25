import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (url) => fs.readFileSync(url, "utf8");
const appShell = read(new URL("../AppShell.tsx", import.meta.url));
const settingsConfig = read(new URL("../SettingsConfig.tsx", import.meta.url));
const messageView = read(new URL("../MessageView.tsx", import.meta.url));
const browserDock = read(new URL("./BrowserDock.tsx", import.meta.url));
const browserSettings = read(new URL("./BrowserSettings.tsx", import.meta.url));
const browserAuthorization = read(new URL("./BrowserAuthorizationDialog.tsx", import.meta.url));

test("Browser remains a fixed right-panel resource and hides its native surface behind Settings", () => {
  assert.match(appShell, /const BROWSER_TAB_ID = "browser"/);
  assert.match(appShell, /t\("browser", "Browser"\)/);
  assert.match(appShell, /rightPanelOpen && !settingsOpen && !browserAuthorization/);
  assert.match(appShell, /persistRightPanelPreferredWidth\(finalWidth, activeFileTabId === BROWSER_TAB_ID\)/);
});

test("BrowserDock synchronizes native bounds, visibility, session ownership, and tool-result navigation", () => {
  assert.match(browserDock, /new ResizeObserver\(sync\)/);
  assert.match(browserDock, /browserSetBounds\(/);
  assert.match(browserDock, /browserSetSurfaceVisible\(/);
  assert.match(browserDock, /tab\.ownerSessionId === null \|\| tab\.ownerSessionId === ownerSessionId/);
  assert.match(browserDock, /message\.includes\("TAB_NOT_FOUND"\)/);
  assert.match(messageView, /pi-desktop:open-browser-tab/);
});

test("Browser access is demand-prompted and AppShell never eagerly grants a selected session", () => {
  assert.doesNotMatch(appShell, /browserGrantSession/);
  assert.match(appShell, /agent-authorization-request/);
  assert.match(appShell, /browserRespondAgentAuthorization/);
  // The authorization dialog delegates the shell to the shared Dialog
  // component; the deny flow stays caller-owned (Escape is not wired).
  assert.match(browserAuthorization, /from "@\/components\/ui\/Dialog"/);
  assert.match(browserAuthorization, /closeOnEscape=\{false\}/);
  assert.match(browserAuthorization, /onRespond\("deny"\)/);
});

test("Browser Settings is reachable and shows the current session permission", () => {
  assert.match(settingsConfig, /id: "browser"/);
  assert.match(settingsConfig, /<BrowserSettings sessionId=/);
  assert.doesNotMatch(browserSettings, /browserGrantSession/);
  assert.match(browserSettings, /browserRevokeTemporarySessionPermission/);
  assert.match(browserSettings, /browserRequestConfirmation\("advanced-browser-mode"/);
  assert.doesNotMatch(browserSettings, /browserSetUnsafePolicy|ENABLE UNSAFE BROWSER/);
  assert.match(browserSettings, /browserReset\(\)/);
});

test("Settings categories use a vertical sidebar with matching keyboard navigation", () => {
  assert.match(settingsConfig, /aria-orientation="vertical"/);
  assert.match(settingsConfig, /flexDirection: "column"/);
  assert.match(settingsConfig, /borderRight: "1px solid var\(--border\)"/);
  assert.match(settingsConfig, /id: "plugins"[\s\S]*id: "browser"[\s\S]*id: "channels"/);
  assert.match(settingsConfig, /event\.key === "ArrowDown"/);
  assert.match(settingsConfig, /event\.key === "ArrowUp"/);
  assert.match(settingsConfig, /event\.key === "Home"/);
  assert.match(settingsConfig, /event\.key === "End"/);
  assert.doesNotMatch(settingsConfig, /overflowX: "auto"/);
});

test("Browser Settings uses an in-app text prompt instead of Electron's unsupported window.prompt", () => {
  assert.doesNotMatch(browserSettings, /window\.prompt/);
  assert.match(browserSettings, /function TextPromptDialog/);
  assert.match(browserSettings, /requiredValue: "ENABLE ADVANCED BROWSER"/);
  assert.doesNotMatch(browserSettings, /requiredValue: "ENABLE UNSAFE BROWSER"/);
  // The prompt delegates the shell to the shared Dialog component.
  assert.match(browserSettings, /from "@\/components\/ui\/Dialog"/);
});
