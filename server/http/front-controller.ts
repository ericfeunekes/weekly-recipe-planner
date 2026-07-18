import {
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded = { ...headers };
  const connection = Array.isArray(headers.connection)
    ? headers.connection.join(",")
    : headers.connection ?? "";
  for (const name of connection.split(",")) {
    const normalized = name.trim().toLowerCase();
    if (normalized) delete forwarded[normalized];
  }
  for (const name of HOP_BY_HOP_HEADERS) delete forwarded[name];
  return forwarded;
}

export type HttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

export function createFrontController({
  apiHandler,
  webOrigin,
  publicBasePath = "/",
  proxyTimeoutMs = 30_000,
}: {
  apiHandler: HttpHandler;
  webOrigin: URL;
  publicBasePath?: string;
  proxyTimeoutMs?: number;
}): HttpHandler {
  if (!["http:"].includes(webOrigin.protocol)) {
    throw new TypeError("The internal web origin must use HTTP.");
  }
  if (!publicBasePath.startsWith("/") || !publicBasePath.endsWith("/")) {
    throw new TypeError("The public base path must begin and end with '/'.");
  }
  const mountedApiPrefix = publicBasePath === "/"
    ? null
    : `${publicBasePath.slice(0, -1)}/api`;

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://planner.local");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      await apiHandler(request, response);
      return;
    }
    if (
      mountedApiPrefix !== null &&
      (url.pathname === mountedApiPrefix || url.pathname.startsWith(`${mountedApiPrefix}/`))
    ) {
      const originalUrl = request.url;
      request.url = `${url.pathname.slice(publicBasePath.length - 1)}${url.search}`;
      try {
        await apiHandler(request, response);
      } finally {
        request.url = originalUrl;
      }
      return;
    }

    const upstream = requestHttp(
      {
        protocol: webOrigin.protocol,
        hostname: webOrigin.hostname,
        port: webOrigin.port,
        method: request.method,
        path: request.url,
        headers: { ...forwardedHeaders(request.headers), host: webOrigin.host },
        timeout: proxyTimeoutMs,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          forwardedHeaders(upstreamResponse.headers),
        );
        upstreamResponse.once("aborted", () => response.destroy());
        upstreamResponse.once("error", () => response.destroy());
        upstreamResponse.pipe(response);
      },
    );
    upstream.once("timeout", () => upstream.destroy(new Error("Web upstream timed out.")));
    upstream.once("error", () => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
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
