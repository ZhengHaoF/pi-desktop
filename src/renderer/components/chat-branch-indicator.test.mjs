import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { ChatBranchIndicator } = await importTestBundle("chat-branch-indicator", {
  stdin: {
    contents: 'export {ChatBranchIndicator} from "./ChatBranchIndicator.tsx";',
    resolveDir: import.meta.dirname,
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "..", "..", "..", "tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "branch-indicator-fixture",
      setup(build) {
        build.onResolve({ filter: /^@\/(i18n|lib\/display-path)$/ }, ({ path }) => ({
          path,
          namespace: "branch-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "branch-test" }, ({ path }) => ({
          loader: "js",
          contents:
            path === "@/i18n"
              ? 'const t = (_key, fallback) => fallback; export const useI18n = () => ({t, language: "en-US"});'
              : 'export function abbreviateHomePath(cwd, homeDir) { return homeDir && cwd.startsWith(homeDir) ? "~" + cwd.slice(homeDir.length) : cwd; }',
        }));
      },
    },
  ],
});

const status = (overrides = {}) => ({
  forCwd: "/repo",
  isGit: true,
  branch: "main",
  clean: true,
  staged: 0,
  modified: 0,
  untracked: 0,
  conflicted: 0,
  ...overrides,
});

async function mount(t, props) {
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const previous = new Map(
    ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  globalThis.window = {
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  let renderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });
  await act(async () => {
    renderer = create(createElement(ChatBranchIndicator, props));
  });
  return renderer;
}

const textOf = (renderer) => {
  const texts = [];
  for (const node of renderer.root.findAll(() => true)) {
    if (typeof node.props?.children === "string") texts.push(node.props.children);
    if (Array.isArray(node.props?.children)) {
      for (const child of node.props.children) if (typeof child === "string") texts.push(child);
    }
  }
  if (renderer.root.props?.children === undefined && renderer.toJSON() === null) return "";
  return texts.join(" ");
};

test("renders nothing when status is null", async (t) => {
  const renderer = await mount(t, { status: null, cwd: "/repo", homeDir: "/home" });
  assert.equal(renderer.toJSON(), null);
});

test("renders nothing when the cwd is not a git repo", async (t) => {
  const renderer = await mount(t, { status: status({ isGit: false }), cwd: "/repo", homeDir: "/home" });
  assert.equal(renderer.toJSON(), null);
});

test("renders the branch name for a plain git checkout", async (t) => {
  const renderer = await mount(t, { status: status(), cwd: "/repo", homeDir: "/home" });
  const text = textOf(renderer);
  assert.ok(text.includes("main"), `expected branch in: ${text}`);
  assert.ok(!text.includes("worktree"), `expected no badge in: ${text}`);
});

test("shows the worktree badge when the session worktree branch matches", async (t) => {
  const renderer = await mount(t, {
    status: status({ branch: "fix/wt" }),
    cwd: "/repo-worktrees/fix-wt",
    worktreeBranch: "fix/wt",
    homeDir: "/home",
  });
  const text = textOf(renderer);
  assert.ok(text.includes("fix/wt"), `expected branch in: ${text}`);
  assert.ok(text.includes("worktree"), `expected badge in: ${text}`);
});

test("hides the worktree badge when git branch disagrees with the session label", async (t) => {
  const renderer = await mount(t, {
    status: status({ branch: "other" }),
    cwd: "/repo-worktrees/fix-wt",
    worktreeBranch: "fix/wt",
    homeDir: "/home",
  });
  const text = textOf(renderer);
  assert.ok(text.includes("other"));
  assert.ok(!text.includes("worktree"), `expected no badge in: ${text}`);
});

test("shows the dirty marker when the worktree has uncommitted changes", async (t) => {
  const renderer = await mount(t, {
    status: status({ clean: false, modified: 2 }),
    cwd: "/repo",
    homeDir: "/home",
  });
  // The dirty dot is a text-less span; assert the branch renders and the
  // marker's tooltip carries the uncommitted count.
  assert.ok(textOf(renderer).includes("main"));
  const tooltipNodes = renderer.root.findAll((node) => node.props?.title === "2 uncommitted changes");
  assert.equal(tooltipNodes.length, 1, "expected the dirty dot with its tooltip");
});

test("shows detached placeholder when branch is null", async (t) => {
  const renderer = await mount(t, { status: status({ branch: null }), cwd: "/repo", homeDir: "/home" });
  const text = textOf(renderer);
  assert.ok(text.includes("detached"), `expected detached in: ${text}`);
});
