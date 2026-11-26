import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

// react-markdown stays real here: the bug under test is its default URL sanitizer
// blanking Windows drive paths, so stubbing it would hide the regression.
const { MarkdownBody } = await importTestBundle("markdown-body-local-image", {
  stdin: {
    contents: 'export { MarkdownBody } from "./MarkdownBody.tsx";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  jsx: "automatic",
  tsconfig: path.resolve(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react/jsx-runtime", "react-markdown", "react-dom", "mermaid"],
  plugins: [
    {
      name: "markdown-body-local-image",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/file-links$/ }, () => ({
          path: path.resolve(import.meta.dirname, "../lib/file-links.ts"),
        }));
        build.onResolve({ filter: /^@shared\/(.*)$/ }, (args) => {
          const resolved = path.resolve(import.meta.dirname, "../../shared", args.path.replace(/^@shared\//, ""));
          return { path: path.extname(resolved) ? resolved : `${resolved}.ts` };
        });
        build.onResolve({ filter: /^@\/lib\/streaming-markdown$/ }, () => ({
          path: path.resolve(import.meta.dirname, "../lib/streaming-markdown.ts"),
        }));
        build.onResolve({ filter: /^@\// }, (args) => ({ path: args.path, namespace: "stub" }));
        build.onResolve({ filter: /^\.\/SessionProfiler$/ }, () => ({ path: "profiler", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          loader: "js",
          contents:
            args.path === "@/lib/file-blob"
              ? 'export async function fileToObjectUrl(filePath){return {url:`blob:test:${filePath}`,mime:"image/png",size:1,revoke(){}};}'
              : args.path === "@/hooks/useTheme"
                ? "export const useTheme = () => ({ isDark: false });"
                : args.path === "@/i18n"
                  ? "export const useI18n = () => ({ language: 'en-US', t: (_key, fallback) => fallback });"
                  : args.path === "@/lib/markdown"
                    ? "export const useMarkdownPlugins = () => ({ remarkPlugins: [], rehypePlugins: [] });"
                    : args.path === "@/lib/code-highlight-policy"
                      ? "export const shouldHighlightCode = () => false;"
                      : args.path === "@/lib/chat-appearance"
                        ? "export const scaledChatFont = (value) => `${value}px`;"
                        : args.path === "@/lib/mermaid-renderer"
                          ? "export const mermaidCacheKey = () => 'key'; export const renderMermaidSvg = async () => '<svg />';"
                          : args.path === "@/hooks/useCopyFeedback"
                            ? "export const useCopyFeedback = () => ({ copied: false, copy: async () => true });"
                            : args.path === "@/lib/syntax-highlight"
                              ? "export const SyntaxHighlighter = 'pre'; export const vs = {}; export const vscDarkPlus = {};"
                              : args.path === "@/components/ui/Button"
                                ? "export const Button = (props) => null;"
                                : "export const SessionProfiler = ({ children }) => children;",
        }));
      },
    },
  ],
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("Markdown images escape URL sanitizing and load Windows drive paths from disk", async (t) => {
  const oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    if (oldAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct;
  });

  await act(async () => {
    renderer = create(createElement(MarkdownBody, null, "![car](D:/work/carhome/icon-512.png)"));
  });
  await settle();

  // Before the fix the drive path was sanitized to "" and the keyboard never got
  // past the pulsing placeholder.
  assert.equal(renderer.root.findAllByProps({ className: "markdown-image-loading" }).length, 0);
  const image = renderer.root.findByType("img");
  assert.equal(image.props.src, "blob:test:D:/work/carhome/icon-512.png");
  assert.equal(image.props.alt, "car");
});

test("Markdown images with an unsupported protocol report the failure instead of loading forever", async (t) => {
  const oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    if (oldAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct;
  });

  await act(async () => {
    renderer = create(createElement(MarkdownBody, null, "![oops](ftp://example.com/a.png)"));
  });
  await settle();

  assert.equal(renderer.root.findAllByType("img").length, 0);
  assert.equal(renderer.root.findAllByProps({ className: "markdown-image-loading" }).length, 0);
  const error = renderer.root.findAllByProps({ className: "markdown-image-error" });
  assert.equal(error.length, 1);
  assert.equal(error[0].children.join(""), "oops");
});
