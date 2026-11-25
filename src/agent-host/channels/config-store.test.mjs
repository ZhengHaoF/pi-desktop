import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ChannelConfigStore } from "./config-store.ts";

function account(overrides = {}) {
  return {
    id: " telegram-main ",
    channel: "telegram",
    name: "",
    enabled: true,
    dmPolicy: "allowlist",
    allowFrom: [" alice ", "alice", ""],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    commandsEnabled: false,
    toolNames: [" read ", "read"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("channel config persists normalized accounts and cascades account deletion", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-channel-config-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "channels.json");
  const store = new ChannelConfigStore(file);
  const saved = store.upsertAccount(account());
  assert.equal(saved.id, "telegram-main");
  assert.equal(saved.name, "Telegram");
  assert.deepEqual(saved.allowFrom, ["alice"]);
  assert.deepEqual(saved.toolNames, ["read"]);

  store.upsertBinding({
    id: " binding ",
    channel: "telegram",
    accountId: saved.id,
    peerKind: "dm",
    peerId: " alice ",
    cwd: directory,
    toolNames: ["read"],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(new ChannelConfigStore(file).listBindings()[0].id, "binding");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // A command toggle persists across a reopen, and the file stays at version 1.
  store.upsertAccount({ ...saved, commandsEnabled: true });
  assert.equal(new ChannelConfigStore(file).listAccounts()[0].commandsEnabled, true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 1);

  store.deleteAccount(saved.id);
  assert.deepEqual(new ChannelConfigStore(file).listBindings(), []);
});

test("versionless config migrates to the current version in place", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-channel-config-migrate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "channels.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      accounts: [account({ id: "tg-one", channel: "telegram", name: "", groupIds: undefined })],
      bindings: [],
    }),
  );
  const migrated = new ChannelConfigStore(file).listAccounts();
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].channel, "telegram");
  assert.equal(migrated[0].name, "Telegram");
  assert.deepEqual(migrated[0].groupIds, []);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 1);
});

test("corrupt configs are quarantined while unsupported versions fail closed", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-channel-config-corrupt-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "channels.json");
  fs.writeFileSync(file, "{broken", "utf8");
  assert.deepEqual(new ChannelConfigStore(file).listAccounts(), []);
  assert.equal(
    fs.readdirSync(directory).some((name) => name.startsWith("channels.json.corrupt-")),
    true,
  );

  fs.writeFileSync(file, JSON.stringify({ version: 2, accounts: [], bindings: [] }), "utf8");
  assert.throws(() => new ChannelConfigStore(file), /Unsupported channels config version: 2/);
});
