import { createServer, type Server } from "node:http";

import type { HttpHandler } from "./front-controller.ts";

export async function listenHttpServer({
  handler,
  host = "127.0.0.1",
  port,
}: {
  handler: HttpHandler;
  host?: string;
  port: number;
}): Promise<Server> {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new TypeError("The application server must bind to loopback.");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("The application port is invalid.");
  }
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      }
      if (!response.writableEnded) {
        response.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "The application server failed unexpectedly." } }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

export async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}

