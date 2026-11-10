import type { RemoteControlConfig } from "../contract/desktop";

/**
 * Config forwarded from main to the agent-host child. The gateway — and with
 * it the E2EE identity — lives in that child process, so the keys must ride
 * along. Dropping them silently disables E2EE: hello carries no e2eePub, and
 * cipher-required devices refuse to connect.
 */
export function hostRemoteControlConfig(config: RemoteControlConfig): RemoteControlConfig {
  return {
    enabled: config.enabled,
    relayUrl: config.relayUrl,
    hostId: config.hostId,
    name: config.name,
    mode: config.mode ?? "lan",
    lanPort: config.lanPort,
    ...(config.e2eePublicKey ? { e2eePublicKey: config.e2eePublicKey } : {}),
    ...(config.e2eePrivateKey ? { e2eePrivateKey: config.e2eePrivateKey } : {}),
  };
}
