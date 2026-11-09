import { createServer } from "node:http";
import { DemoRunner } from "./demo.js";
import { readControlState } from "./control-plane.js";
import { handleApiRequest, TRUSTED_DASHBOARD_ORIGIN } from "./router.js";
import { NearNetworkService, resolveNetworkConfig } from "./network.js";

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid local TCP port");
// Chain telemetry is network configurable, but the server and privileged demo
// remain loopback/local-sandbox only. Network routes are read-only.
const network = new NearNetworkService();
const runner = new DemoRunner();

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []; let size = 0;
  if (req.method === "POST") {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
      if (size > 1024) {
        const cors = req.headers.origin === TRUSTED_DASHBOARD_ORIGIN ? { "Access-Control-Allow-Origin": TRUSTED_DASHBOARD_ORIGIN, Vary: "Origin" } : {};
        res.writeHead(413, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", ...cors });
        res.end(JSON.stringify({ error: "Request too large" })); return;
      }
      chunks.push(buffer);
    }
  }
  const headers: Record<string, string | undefined> = {};
  for (const name of ["origin", "content-type", "access-control-request-method", "access-control-request-headers"]) {
    const value = req.headers[name]; headers[name] = Array.isArray(value) ? value.join(",") : value;
  }
  try {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    const response = await handleApiRequest({ method: req.method ?? "GET", url: `${parsed.pathname}${parsed.search}`, headers, body: Buffer.concat(chunks).toString("utf8") }, {
      runner, controlState: () => readControlState(), network,
    });
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  } catch {
    const cors = req.headers.origin === TRUSTED_DASHBOARD_ORIGIN ? { "Access-Control-Allow-Origin": TRUSTED_DASHBOARD_ORIGIN, Vary: "Origin" } : {};
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", ...cors });
    res.end(JSON.stringify({ error: "Control Plane request failed" }));
  }
});
server.listen(port, "127.0.0.1", () => {
  let networkLabel = "invalid network configuration";
  try { networkLabel = resolveNetworkConfig().network; } catch (error) { networkLabel = error instanceof Error ? error.message : networkLabel; }
  console.log(`PHOENIX Control Plane listening at http://127.0.0.1:${port} (trusted UI: ${TRUSTED_DASHBOARD_ORIGIN}; chain: ${networkLabel})`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void runner.stop().finally(() => server.close(() => process.exit(0)));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
