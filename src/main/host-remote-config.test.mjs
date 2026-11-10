import assert from "node:assert/strict";
import test from "node:test";
import { hostRemoteControlConfig } from "./host-remote-config.ts";

const base = {
  enabled: true,
  mode: "custom",
  relayUrl: "ws://relay.example/ws",
  lanPort: 8788,
  hostId: "host-1234",
  name: "WORKSTATION",
};

test("keeps the E2EE identity in the config forwarded to the host child", () => {
  const forwarded = hostRemoteControlConfig({
    ...base,
    e2eePublicKey: "public-key",
    e2eePrivateKey: "private-key",
  });

  assert.equal(forwarded.e2eePublicKey, "public-key");
  assert.equal(forwarded.e2eePrivateKey, "private-key");
  assert.equal(forwarded.enabled, true);
  assert.equal(forwarded.relayUrl, base.relayUrl);
  assert.equal(forwarded.hostId, base.hostId);
  assert.equal(forwarded.name, base.name);
  assert.equal(forwarded.mode, "custom");
  assert.equal(forwarded.lanPort, 8788);
});

test("defaults mode to lan and omits absent E2EE keys", () => {
  const forwarded = hostRemoteControlConfig({ ...base, mode: undefined });

  assert.equal(forwarded.mode, "lan");
  assert.equal("e2eePublicKey" in forwarded, false);
  assert.equal("e2eePrivateKey" in forwarded, false);
});
