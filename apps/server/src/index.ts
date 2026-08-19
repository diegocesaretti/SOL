import { createServer } from "node:http";
import { InMemoryEventBus } from "./core/event-bus.js";

const host = process.env.SOL_HOST ?? "0.0.0.0";
const port = Number(process.env.SOL_PORT ?? 3000);

export const eventBus = new InMemoryEventBus();

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "sol-core" }));
    return;
  }

  if (request.method === "GET" && request.url === "/v1/system") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: "SOL",
        architecture: "family-first modular monolith",
        version: "0.1.0",
      }),
    );
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, host, () => {
  console.log(`SOL Core listening on http://${host}:${port}`);
});
