import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
const {
  ChannelConfigStore,
  ChannelStateStore,
  LaneScheduler,
  splitChannelText,
  evaluateInboundPolicy,
  parseChannelCommand,
} = await importTestBundle("src/agent-host/channels/channel-core", {
  packages: "external",
  stdin: {
    contents: [
      'export { ChannelConfigStore } from "./config-store.ts";',
      'export { ChannelStateStore } from "./state-store.ts";',
      'export { LaneScheduler } from "./lane-scheduler.ts";',
      'export { splitChannelText } from "./outbound-renderer.ts";',
      'export { evaluateInboundPolicy } from "./policy.ts";',
      'export { parseChannelCommand } from "./channel-commands.ts";',
      'export { redactChannelValue, safeChannelError } from "./redaction.ts";',
    ].join("\n"),
    resolveDir: import.meta.dirname,
    sourcefile: "channel-core-test-entry.ts",
    loader: "ts",
  },
});

function account(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: "wx-one",
    channel: "weixin",
    name: "Weixin",
    enabled: true,
    dmPolicy: "pairing",
    allowFrom: [],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    toolNames: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function envelope(overrides = {}) {
  return {
    id: "m1",
    channel: "weixin",
    accountId: "wx-one",
    peer: { kind: "dm", id: "user-one" },
    sender: { id: "user-one" },
    text: "hello",
    mentionsBot: false,
    attachments: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

test("channel config preserves Feishu App ID and normalizes the Feishu/Lark domain", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-feishu-config-"));
  const file = path.join(dir, "channels.json");
  const store = new ChannelConfigStore(file);
  const saved = store.upsertAccount(
    account({
      id: "feishu-one",
      channel: "feishu",
      name: "",
      appId: " cli_1234567890abcdef ",
      domain: "lark",
    }),
  );
  assert.equal(saved.channel, "feishu");
  assert.equal(saved.name, "飞书 / Lark");
  assert.equal(saved.appId, "cli_1234567890abcdef");
  assert.equal(saved.domain, "lark");

  const reopened = new ChannelConfigStore(file).listAccounts()[0];
  assert.equal(reopened.appId, "cli_1234567890abcdef");
  assert.equal(reopened.domain, "lark");
});

test("channel command parser recognizes only the additive built-in command set", () => {
  assert.deepEqual(parseChannelCommand("/help"), { name: "help", args: "" });
  assert.deepEqual(parseChannelCommand(" /status@pi_bot "), { name: "status", args: "" });
  assert.deepEqual(parseChannelCommand("/new"), { name: "new", args: "" });
  assert.deepEqual(parseChannelCommand("/compact keep decisions"), {
    name: "compact",
    args: "keep decisions",
  });
  assert.deepEqual(parseChannelCommand("/reload"), { name: "reload", args: "" });
  assert.equal(parseChannelCommand("/unknown"), null);
  assert.equal(parseChannelCommand("please /help"), null);
  assert.equal(parseChannelCommand("/help/extra"), null);
});

test("state checkpoints cursor, context, dedupe, pairing, and redacted activity", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channels-state-"));
  const file = path.join(dir, "state.json");
  const state = new ChannelStateStore(file);
  state.setCursor("wx-one", "cursor-1");
  state.setContextToken("wx-one", "user-one", "context-secret");
  state.markProcessed("wx-one", "event-one");
  const now = Date.now();
  state.upsertPairing({
    id: "pair-one",
    code: "123456",
    channel: "weixin",
    accountId: "wx-one",
    peerId: "user-one",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  state.addActivity({
    id: "activity",
    channel: "weixin",
    accountId: "wx-one",
    direction: "system",
    outcome: "accepted",
    at: new Date().toISOString(),
  });

  const reopened = new ChannelStateStore(file);
  assert.equal(reopened.getCursor("wx-one"), "cursor-1");
  assert.equal(reopened.getContextToken("wx-one", "user-one"), "context-secret");
  assert.equal(reopened.isProcessed("wx-one", "event-one"), true);
  assert.equal(reopened.listPairings()[0].code, "123456");
  assert.equal(reopened.listActivities()[0].id, "activity");
});

test("policy defaults to pairing and keeps group authorization independent", () => {
  assert.equal(evaluateInboundPolicy(account(), envelope()), "pair");
  assert.equal(evaluateInboundPolicy(account({ allowFrom: ["user-one"] }), envelope()), "allow");
  assert.equal(evaluateInboundPolicy(account({ dmPolicy: "allowlist" }), envelope()), "ignore");
  assert.equal(
    evaluateInboundPolicy(
      account({ groupPolicy: "allowlist", groupIds: ["group"], groupAllowFrom: ["user-one"], requireMention: true }),
      envelope({ peer: { kind: "group", id: "group" }, mentionsBot: false }),
    ),
    "ignore",
  );
  assert.equal(
    evaluateInboundPolicy(
      account({ groupPolicy: "allowlist", groupIds: ["group"], groupAllowFrom: ["user-one"], requireMention: true }),
      envelope({ peer: { kind: "group", id: "group" }, mentionsBot: true }),
    ),
    "allow",
  );
  assert.equal(
    evaluateInboundPolicy(
      account({
        groupPolicy: "allowlist",
        groupIds: ["another-group"],
        groupAllowFrom: ["user-one"],
        requireMention: true,
      }),
      envelope({ peer: { kind: "group", id: "group" }, mentionsBot: true }),
    ),
    "ignore",
  );
});

test("lane scheduler serializes a route while allowing other routes to progress", async () => {
  const scheduler = new LaneScheduler();
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = scheduler.run("same", async () => {
    order.push("first-start");
    await gate;
    order.push("first-end");
  });
  const second = scheduler.run("same", async () => order.push("second"));
  const other = scheduler.run("other", async () => order.push("other"));
  await other;
  assert.deepEqual(order, ["first-start", "other"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "other", "first-end", "second"]);
});

test("lane scheduler bounds concurrency across independent routes", async () => {
  const scheduler = new LaneScheduler(2);
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tasks = ["a", "b", "c", "d"].map((key) =>
    scheduler.run(key, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  release();
  await Promise.all(tasks);
  assert.equal(peak, 2);
});

test("outbound text splitting preserves Unicode and readable boundaries", () => {
  const text = `${"你".repeat(8)}\n\n${"🙂".repeat(8)}`;
  const chunks = splitChannelText(text, 10);
  assert.deepEqual(chunks, [`${"你".repeat(8)}\n\n`, "🙂".repeat(8)]);
  assert.equal(chunks.join(""), text);
  assert.equal(chunks.join("").includes("�"), false);
});
