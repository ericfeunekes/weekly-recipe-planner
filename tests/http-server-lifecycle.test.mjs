import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import test from "node:test";

import {
  closeHttpServer,
  listenHttpServer,
} from "../server/http/server.ts";

test("HTTP shutdown bounds a partially sent request body", async () => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const server = await listenHttpServer({
    port: 0,
    handler: async (request, response) => {
      markStarted();
      for await (const chunk of request) {
        // The client deliberately never sends the declared remainder.
        void chunk;
      }
      if (!response.writableEnded) response.end("done");
    },
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  const socket = connect(address.port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    "POST /slow HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\nConnection: keep-alive\r\n\r\n{",
  );
  await started;

  const before = Date.now();
  await closeHttpServer(server, { gracePeriodMs: 20 });
  const elapsed = Date.now() - before;
  socket.destroy();
  assert.ok(elapsed >= 15, `shutdown forced too early after ${elapsed} ms`);
  assert.ok(elapsed < 500, `shutdown exceeded its bound at ${elapsed} ms`);
  assert.equal(server.listening, false);
});

test("HTTP shutdown validates its grace period", async () => {
  const server = await listenHttpServer({
    port: 0,
    handler: (_request, response) => response.end("ok"),
  });
  await assert.rejects(
    closeHttpServer(server, { gracePeriodMs: -1 }),
    /non-negative integer/,
  );
  await closeHttpServer(server);
});
