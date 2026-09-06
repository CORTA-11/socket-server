import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";

import { HocuspocusProvider } from "@hocuspocus/provider";

import { createCollaborationServer } from "../src/server.js";

test("collaboration health is observable independently", async (t) => {
  const server = createCollaborationServer({ port: 0 });
  await server.listen();
  t.after(() => server.destroy());

  const response = await fetch(`http://127.0.0.1:${server.address.port}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "collaboration-server",
  });
});

test("an unauthenticated Editing Session is rejected", async (t) => {
  const server = createCollaborationServer({ port: 0 });
  await server.listen();
  t.after(() => server.destroy());

  const reason = await new Promise<string>((resolve, reject) => {
    const provider = new HocuspocusProvider({
      name: "document-smoke-test",
      token: "not-a-document-ticket",
      url: `ws://127.0.0.1:${server.address.port}/ws/docs`,
      onAuthenticationFailed: ({ reason: failureReason }) => {
        clearTimeout(timeout);
        provider.destroy();
        resolve(failureReason);
      },
    });
    t.after(() => provider.destroy());
    const timeout = setTimeout(
      () => reject(new Error("authentication rejection timed out")),
      2_000,
    );
  });

  assert.equal(reason, "permission-denied");
});

test("the collaboration process shuts down cleanly on SIGTERM", async (t) => {
  const port = await availablePort();
  const child = spawn(process.execPath, ["dist/src/main.js"], {
    cwd: process.cwd(),
    env: { ...process.env, COLLABORATION_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", () => resolve());
  });
  child.kill("SIGTERM");

  const exit = await new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  assert.deepEqual(exit, { code: 0, signal: null });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (address === null || typeof address === "string") {
    throw new Error("could not allocate a loopback port");
  }
  return address.port;
}
