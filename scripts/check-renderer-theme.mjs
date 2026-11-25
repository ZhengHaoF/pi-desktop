#!/usr/bin/env node
/**
 * Renderer theme contract. These invariants used to live in a test file that
 * only scanned source text; keeping them in the verify gate makes them fail on
 * the real tree instead of on fixtures.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = path.join(root, "src", "renderer");
const failures = [];
const read = (relativePath) => fs.readFileSync(path.join(rendererRoot, relativePath), "utf8");

// Status colors must come from the semantic tokens so both themes follow.
const TOKEN_OWNERS = [
  "components/FileViewer.tsx",
  "components/channels/ChannelsConfig.tsx",
  "components/ChatInput.tsx",
  "components/composer/ComposerToolbar.tsx",
  "components/PluginsConfig.tsx",
  "components/ToolchainsConfig.tsx",
  "components/MessageView.tsx",
];
const FORBIDDEN_STATUS_HEX = ["#f87171", "#ef4444", "#4ade80", "#22c55e", "#f59e0b", "#d97706", "#16a34a", "#1f2937"];
for (const owner of TOKEN_OWNERS) {
  const source = read(owner);
  for (const hex of FORBIDDEN_STATUS_HEX)
    if (new RegExp(hex, "i").test(source)) failures.push(`${owner} hardcodes status color ${hex}`);
}

const SEMANTIC_TOKENS = [
  "--success",
  "--success-soft",
  "--success-border",
  "--danger",
  "--danger-soft",
  "--danger-border",
  "--warning",
  "--warning-soft",
  "--warning-border",
  "--info",
  "--info-soft",
  "--info-border",
  "--accent-contrast",
  "--on-accent",
];
const css = read("globals.css");
const themeRoots = [
  ["light", css.slice(css.indexOf(":root {"), css.indexOf("html.dark"))],
  ["dark", css.slice(css.indexOf("html.dark"))],
];
for (const [theme, block] of themeRoots) {
  for (const token of SEMANTIC_TOKENS)
    if (!block.includes(`${token}:`)) failures.push(`${theme} theme is missing ${token}`);
}

function hexToken(theme, block, token) {
  const match = block.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!match) failures.push(`${theme} theme ${token} should be a concrete six-digit hex color`);
  return match?.[1];
}

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

for (const [theme, block] of themeRoots) {
  const accent = hexToken(theme, block, "--accent");
  const contrast = hexToken(theme, block, "--accent-contrast");
  if (!accent || !contrast) continue;
  const ratio = contrastRatio(accent, contrast);
  if (ratio < 4.5) failures.push(`${theme} theme accent contrast is ${ratio.toFixed(2)}:1 (AA needs 4.5:1)`);
  if (!block.includes("--on-accent: var(--accent-contrast)"))
    failures.push(`${theme} theme must alias --on-accent to --accent-contrast`);
}

const browserSettings = read("components/browser/BrowserSettings.tsx");
if (!/color:\s*"var\(--accent-contrast\)"/.test(browserSettings))
  failures.push("BrowserSettings must paint accent text with var(--accent-contrast)");
if (/var\(--accent-contrast\s*,/.test(browserSettings))
  failures.push("BrowserSettings must not guess a fallback for --accent-contrast");

// Chat appearance: the settings surface, the CSS scales it drives, and the
// composer layout that consumes them. These are layout contracts rather than
// behaviour, so they belong in the verify gate next to the theme tokens.
const settingsConfig = read("components/SettingsConfig.tsx");
const chatWindow = read("components/ChatWindow.tsx");
const chatInput = read("components/ChatInput.tsx");
const composerToolbar = read("components/composer/ComposerToolbar.tsx");
const messageView = read("components/MessageView.tsx");

for (const controlId of ["chatFontSizeControlId", "chatLayoutControlId", "chatAssistantWidthControlId"])
  if (!settingsConfig.includes(controlId)) failures.push(`SettingsConfig is missing ${controlId}`);
for (const value of ["small", "standard", "large", "extra-large", "fixed", "wide", "comfortable", "full"])
  if (!settingsConfig.includes(`value: "${value}"`))
    failures.push(`SettingsConfig chat appearance is missing the "${value}" option`);
if (
  !settingsConfig.includes("onChatAppearanceChange(next)") ||
  !settingsConfig.includes("disabled={chatAppearanceSaving}")
)
  failures.push("chat appearance changes must go through onChatAppearanceChange and disable while saving");
if (!/role="alert"[\s\S]*?chatAppearanceSaveFailed/.test(settingsConfig))
  failures.push("a failed chat appearance save must surface chatAppearanceSaveFailed in an alert");

const CHAT_CSS_RULES = [
  [/\.chat-appearance-scope\s*\{[\s\S]*?--chat-font-scale:\s*1/, "chat appearance scope keeps a 1x default scale"],
  [/data-chat-font-size="small"[\s\S]*?--chat-font-scale:\s*0\.9/, "small chat text maps to a 0.9 scale"],
  [/data-chat-font-size="large"[\s\S]*?--chat-font-scale:\s*1\.15/, "large chat text maps to a 1.15 scale"],
  [/data-chat-font-size="extra-large"[\s\S]*?--chat-font-scale:\s*1\.3/, "extra-large chat text maps to a 1.3 scale"],
  [
    /data-chat-layout="wide"[\s\S]*?--chat-content-max-width:\s*clamp\(760px,\s*80%,\s*1280px\)/,
    "wide layout keeps the clamp(760px, 80%, 1280px) column",
  ],
  [
    /\.chat-content-column\s*\{[\s\S]*?max-width:\s*var\(--chat-content-max-width\)/,
    ".chat-content-column must consume --chat-content-max-width",
  ],
];
for (const [pattern, message] of CHAT_CSS_RULES) if (!pattern.test(css)) failures.push(message);
if (/data-chat-layout="full"|--chat-content-max-width:\s*100%/.test(css))
  failures.push("full-width layout must not be expressed as a 100% --chat-content-max-width");
if (/var\(--chat-font-scale\)(?!\s*:)/.test(css))
  failures.push("--chat-font-scale must only be declared, never applied directly to text");
if (!/data-chat-assistant-width="full"[^}]*--chat-assistant-max-width:\s*100%/.test(css))
  failures.push("full reply width must scope --chat-assistant-max-width to assistant messages");
if (/data-chat-assistant-width="full"[^}]*--chat-content-max-width/.test(css))
  failures.push("reply width must not widen the conversation column");
if (!messageView.includes('maxWidth: "var(--chat-assistant-max-width, 68ch)"'))
  failures.push("assistant messages must read var(--chat-assistant-max-width, 68ch)");

if ((chatWindow.match(/className="chat-content-column/g) ?? []).length !== 4)
  failures.push("ChatWindow must wrap the column exactly four times after reserving the minimap gutter");
if ((chatInput.match(/className="chat-content-column"/g) ?? []).length !== 1)
  failures.push("ChatInput must apply the content column once");
if (!/className="chat-input-transition-dock[^\n]*w-full/.test(chatWindow))
  failures.push("the composer dock must span the window, not the content column");
if (
  /maxWidth:\s*"var\(--chat-content-max-width\)"/.test(chatWindow) ||
  /maxWidth:\s*"var\(--chat-content-max-width\)"/.test(chatInput)
)
  failures.push("the content column owns the max width; the dock must not re-apply it");
if (!/paddingRight:\s*isMobile \? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING/.test(chatWindow))
  failures.push("the composer dock must reserve the minimap gutter on the right only");

const CHAT_SCALE_OWNERS = [
  [chatWindow, /fontSize:\s*scaledChatFont\(22\)/, "ChatWindow titles must use scaledChatFont(22)"],
  [chatInput, /fontSize:\s*scaledChatFont\(14\)/, "ChatInput text must use scaledChatFont(14)"],
  [messageView, /fontSize:\s*scaledChatFont\(13\.5\)/, "MessageView body text must use scaledChatFont(13.5)"],
];
for (const [source, pattern, message] of CHAT_SCALE_OWNERS) if (!pattern.test(source)) failures.push(message);
// Glyph-only icons keep fixed sizes; text surfaces must stay on the shared scale.
const RAW_FONT_SIZE = /fontSize:\s*[0-9]+(?:\.[0-9]+)?/g;
for (const [name, source] of [
  ["ChatInput", chatInput],
  ["ComposerToolbar", composerToolbar],
])
  if ((source.match(RAW_FONT_SIZE) ?? []).length)
    failures.push(`${name} must not set a raw numeric fontSize outside the chat scale`);
if (JSON.stringify(messageView.match(RAW_FONT_SIZE) ?? []) !== JSON.stringify(["fontSize: 10"]))
  failures.push("MessageView may only size glyph-only icons outside the chat scale (fontSize: 10)");

// The dock must stay in the normal paint path: a filter promotes it to a
// composited layer, and re-rasterising that layer while the compaction button
// changed width left the previous frame's toolbar painted below the row.
if (/\.chat-input-transition-dock[^{]*\{[^}]*filter:/.test(css))
  failures.push("the composer dock must not use a filter (stale-frame ghost while compacting)");
if (
  !/\.chat-input-transition-dock\[data-position="conversation"\]\s+\.chat-composer-shell\s*\{[^}]*box-shadow:/.test(css)
)
  failures.push("the composer separation shadow must be painted on .chat-composer-shell");

if (failures.length) {
  console.error(`[renderer-theme] ${failures.length} invariant(s) failed`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  `[renderer-theme] ${TOKEN_OWNERS.length} owners use semantic status tokens; both themes define ${SEMANTIC_TOKENS.length} tokens and meet WCAG AA accent contrast; chat appearance scales, column ownership and the composer dock keep their contracts`,
);
