import { request as requestHttp, type IncomingMessage, type ServerResponse } from "node:http";

export type HttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

export function createFrontController({
  apiHandler,
  webOrigin,
  proxyTimeoutMs = 30_000,
}: {
  apiHandler: HttpHandler;
  webOrigin: URL;
  proxyTimeoutMs?: number;
}): HttpHandler {
  if (!["http:"].includes(webOrigin.protocol)) {
    throw new TypeError("The internal web origin must use HTTP.");
  }

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://planner.local");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      await apiHandler(request, response);
      return;
    }

    const upstream = requestHttp(
      {
        protocol: webOrigin.protocol,
        hostname: webOrigin.hostname,
        port: webOrigin.port,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: webOrigin.host },
        timeout: proxyTimeoutMs,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.once("timeout", () => upstream.destroy(new Error("Web upstream timed out.")));
    upstream.once("error", () => {
      if (!response.headersSent) {
        response.writeHead(503, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
      }
      if (!response.writableEnded) response.end("The meal planner web process is unavailable.");
    });
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
  };
}

