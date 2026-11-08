/**
 * LAN address enumeration for the 局域网 relay mode: pick real network
 * interfaces (WLAN / Ethernet), skip loopback, link-local and virtual
 * adapters (WSL/Hyper-V/VMware/Docker/ZeroTier/Tailscale), and build
 * ws:// URLs the phone can dial.
 */
import os from "node:os";
import type { LanAddress } from "../contract/desktop";

const VIRTUAL_IFACE_PATTERNS = [
  /wsl/i,
  /hyper-?v/i,
  /vmware/i,
  /virtualbox/i,
  /vbox/i,
  /docker/i,
  /zerotier/i,
  /tailscale/i,
  /loopback/i,
  /vethernet/i,
  /bluetooth/i,
  /vpn/i,
  /tap\b/i,
  /teredo/i,
  /isatap/i,
];

/** Physical interfaces rank first; stable order otherwise. */
function interfaceRank(name: string, internal: boolean, cidr: string | null): number {
  if (internal) return 100;
  if (!cidr) return 90;
  const lower = name.toLowerCase();
  if (/wi-?fi|wlan|wireless/i.test(lower)) return 0;
  if (/ethernet|以太网|eth[0-9]|en[0-9]/i.test(lower)) return 1;
  if (VIRTUAL_IFACE_PATTERNS.some((p) => p.test(lower))) return 80;
  return 10;
}

export function listLanAddresses(port: number): LanAddress[] {
  const addresses: Array<LanAddress & { rank: number }> = [];
  const interfaces = os.networkInterfaces();
  for (const [iface, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      // IPv4 only — phones on the same LAN join via IPv4; skip internal and
      // link-local (169.254.*) which are useless across devices.
      if (info.family !== "IPv4" || info.internal) continue;
      const ip = info.address;
      if (ip.startsWith("169.254.")) continue;
      const lower = iface.toLowerCase();
      const virtual = VIRTUAL_IFACE_PATTERNS.some((p) => p.test(lower));
      const rank = interfaceRank(iface, info.internal, info.cidr ?? null) + (virtual ? 50 : 0);
      addresses.push({
        iface,
        url: `ws://${ip}:${port}/ws`,
        preferred: false,
        rank,
      });
    }
  }
  addresses.sort((a, b) => a.rank - b.rank || a.iface.localeCompare(b.iface));
  return addresses.map((entry, index) => ({ ...entry, preferred: index === 0 }));
}
