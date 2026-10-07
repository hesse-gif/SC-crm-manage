import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { assertLoopbackEmulator, resetEmulatorDelete } from "../scripts/emulator-reset.mjs";

// This suite creates a real loopback HTTP listener. Keep it out of the default
// sandbox-safe suite while still running it in the emulator/CI lane.
const requiresLoopbackListener = true;

const servers = new Set();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve) => {
          server.close(() => {
            servers.delete(server);
            resolve();
          });
        }),
    ),
  );
});

async function startServer(handler) {
  const server = http.createServer(handler);
  servers.add(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, host: `127.0.0.1:${address.port}` };
}

test("reset retries one transient connection reset and succeeds on the next attempt", async () => {
  let requests = 0;
  const { host } = await startServer((req, res) => {
    requests += 1;
    if (requests === 1) {
      req.socket.destroy(Object.assign(new Error("transient reset"), { code: "ECONNRESET" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  await resetEmulatorDelete({
    host,
    variableName: "FIREBASE_AUTH_EMULATOR_HOST",
    projectId: "demo-flu",
    path: "/emulator/v1/projects/demo-flu/accounts",
    targetName: "Auth emulator accounts",
    timeoutMs: 250,
  });

  assert.equal(requests, 2);
});

test("reset fails after three transient connection resets", async () => {
  let requests = 0;
  const { host } = await startServer((req) => {
    requests += 1;
    req.socket.destroy(Object.assign(new Error("persistent reset"), { code: "ECONNRESET" }));
  });

  await assert.rejects(
    resetEmulatorDelete({
      host,
      variableName: "FIREBASE_AUTH_EMULATOR_HOST",
      projectId: "demo-flu",
      path: "/emulator/v1/projects/demo-flu/accounts",
      targetName: "Auth emulator accounts",
      timeoutMs: 250,
    }),
    /attempt 3\/3: (ECONNRESET|UND_ERR_SOCKET)/,
  );
  assert.equal(requests, 3);
});

test("reset retries transient 503s and fails in a bounded way", async () => {
  let requests = 0;
  const { host } = await startServer((_req, res) => {
    requests += 1;
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("temporary failure body that must not leak");
  });

  await assert.rejects(
    resetEmulatorDelete({
      host,
      variableName: "FIRESTORE_EMULATOR_HOST",
      projectId: "demo-flu",
      path: "/emulator/v1/projects/demo-flu/databases/(default)/documents",
      targetName: "Firestore emulator database (default)",
      timeoutMs: 250,
    }),
    /attempt 3\/3: HTTP 503/,
  );
  assert.equal(requests, 3);
});

test("reset does not retry 4xx failures", async () => {
  let requests = 0;
  const { host } = await startServer((_req, res) => {
    requests += 1;
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
  });

  await assert.rejects(
    resetEmulatorDelete({
      host,
      variableName: "FIRESTORE_EMULATOR_HOST",
      projectId: "demo-flu",
      path: "/emulator/v1/projects/demo-flu/databases/(default)/documents",
      targetName: "Firestore emulator database (default)",
      timeoutMs: 250,
    }),
    /attempt 1\/3: HTTP 404/,
  );
  assert.equal(requests, 1);
});

test("2xx responses whose body read fails are retried and must be consumed before success", async () => {
  let requests = 0;
  const { host } = await startServer((_req, res) => {
    requests += 1;
    if (requests === 1) {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": "32",
      });
      res.write("{");
      res.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  await resetEmulatorDelete({
    host,
    variableName: "FIREBASE_AUTH_EMULATOR_HOST",
    projectId: "demo-flu",
    path: "/emulator/v1/projects/demo-flu/accounts",
    targetName: "Auth emulator accounts",
    timeoutMs: 250,
  });

  assert.equal(requests, 2);
});

test("nonretryable 2xx body read failures do not count as reset success", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        throw new TypeError("body parser failure");
      },
    };
  };

  try {
    await assert.rejects(
      resetEmulatorDelete({
        host: "127.0.0.1:9099",
        variableName: "FIREBASE_AUTH_EMULATOR_HOST",
        projectId: "demo-flu",
        path: "/emulator/v1/projects/demo-flu/accounts",
        targetName: "Auth emulator accounts",
        timeoutMs: 250,
      }),
      /attempt 1\/3: TypeError/,
    );
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loopback guard rejects remote, wildcard, credentialed, and malformed hosts", async () => {
  for (const invalidHost of [
    "192.168.0.10:8080",
    "example.com:8080",
    "0.0.0.0:8080",
    "*:8080",
    "user@localhost:8080",
    "user:pass@localhost:8080",
    "localhost:8080/path",
    "localhost:8080?reset=1",
    "localhost:8080#reset",
    "localhost",
    "localhost:",
    "localhost:abc",
    "localhost:0",
    "localhost:65536",
    " localhost:8080",
    "localhost:8080 ",
    "local host:8080",
  ]) {
    assert.throws(
      () => assertLoopbackEmulator(invalidHost, "FIRESTORE_EMULATOR_HOST", "demo-flu"),
      /loopback host|host:port|port/,
    );
  }

  for (const validHost of ["127.0.0.1:8080", "localhost:9099", "[::1]:9099"]) {
    assert.doesNotThrow(() =>
      assertLoopbackEmulator(validHost, "FIRESTORE_EMULATOR_HOST", "demo-flu"),
    );
  }

  assert.throws(
    () => assertLoopbackEmulator("127.0.0.1:8080", "FIRESTORE_EMULATOR_HOST", "prod-flu"),
    /pinned to demo-flu/,
  );
});
