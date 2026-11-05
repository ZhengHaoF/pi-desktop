/**
 * Relay entrypoint: HTTP health endpoint + WS upgrade.
 */
import { createServer } from "node:http";
import { loadConfig } from "./config.ts";
import { RelayHub } from "./hub.ts";

const config = loadConfig();
const hub = new RelayHub(config);

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        hosts: hub.registry.onlineHosts().length,
        devices: hub.registry.onlineDevices().length,
        cipherRequired: config.cipherRequired,
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/ws") {
    hub.handleUpgrade(req, socket, head);
    return;
  }
  socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
  socket.destroy();
});

httpServer.listen(config.port, () => {
  console.log(`[relay] listening on :${config.port} cipherRequired=${config.cipherRequired}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    httpServer.close(() => process.exit(0));
  });
}
