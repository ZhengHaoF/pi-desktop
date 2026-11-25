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

if (failures.length) {
  console.error(`[renderer-theme] ${failures.length} invariant(s) failed`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  `[renderer-theme] ${TOKEN_OWNERS.length} owners use semantic status tokens; both themes define ${SEMANTIC_TOKENS.length} tokens and meet WCAG AA accent contrast`,
);
