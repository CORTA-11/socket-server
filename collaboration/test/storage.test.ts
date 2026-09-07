import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";

import { CoreAPIStorage, type DocumentScope } from "../src/storage.js";

const scope: DocumentScope = {
  documentId: "33333333-3333-4333-8333-333333333333",
  editorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
};
const serviceSecret = "test-collaboration-service-secret-123";

test("core-api storage loads canonical Yjs bytes with service and Editor identity", async (t) => {
  const requests: RecordedRequest[] = [];
  const baseURL = await mockCoreAPI(t, requests, (_request, response) => {
    json(response, 200, {
      canonical_state: "AAA=",
      title: "Shared notes",
      body_html: "<p>Persisted</p>",
      updated_by: scope.editorId,
      updated_at: "2026-09-07T09:30:00Z",
    });
  });
  const storage = new CoreAPIStorage({ baseURL, serviceSecret });

  const state = await storage.load(scope);

  assert.deepEqual(state, Uint8Array.from([0, 0]));
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.url, documentStatePath());
  assert.equal(requests[0]?.authorization, `Bearer ${serviceSecret}`);
  assert.equal(requests[0]?.editorId, scope.editorId);
});

test("core-api storage atomically stores state and materialized projections", async (t) => {
  const requests: RecordedRequest[] = [];
  const baseURL = await mockCoreAPI(t, requests, async (request, response) => {
    const body = await readJSON(request);
    requests.at(-1)!.body = body;
    json(response, 200, { ...(body as Record<string, unknown>), updated_by: scope.editorId, updated_at: "2026-09-07T09:31:00Z" });
  });
  const storage = new CoreAPIStorage({ baseURL, serviceSecret });

  await storage.store(scope, Uint8Array.from([0, 0]), {
    bodyHTML: "<p>Converged body</p>",
    title: "Converged title",
  });

  assert.equal(requests[0]?.method, "PUT");
  assert.deepEqual(requests[0]?.body, {
    canonical_state: "AAA=",
    title: "Converged title",
    body_html: "<p>Converged body</p>",
  });
});

test("core-api storage rejects failed loads without exposing response content", async (t) => {
  const baseURL = await mockCoreAPI(t, [], (_request, response) => {
    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end("database-password-must-not-leak");
  });
  const storage = new CoreAPIStorage({ baseURL, serviceSecret });

  await assert.rejects(storage.load(scope), /^Error: core-api Document state request failed with status 500$/);
});

test("core-api storage rejects semantically invalid Yjs state", async (t) => {
  const baseURL = await mockCoreAPI(t, [], (_request, response) => {
    json(response, 200, { canonical_state: "AQID" });
  });
  const storage = new CoreAPIStorage({ baseURL, serviceSecret });

  await assert.rejects(storage.load(scope), /^Error: invalid encoded Yjs Document state$/);
});

test("core-api storage surfaces failed stores without exposing response content", async (t) => {
  const baseURL = await mockCoreAPI(t, [], async (request, response) => {
    await readJSON(request);
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("deleted-document-content-must-not-leak");
  });
  const storage = new CoreAPIStorage({ baseURL, serviceSecret });

  await assert.rejects(
    storage.store(scope, Uint8Array.from([0, 0]), { title: "Notes", bodyHTML: "<p>Body</p>" }),
    /^Error: core-api Document state request failed with status 404$/,
  );
});

interface RecordedRequest {
  authorization: string | undefined;
  body?: unknown;
  editorId: string | undefined;
  method: string | undefined;
  url: string | undefined;
}

async function mockCoreAPI(
  t: TestContext,
  requests: RecordedRequest[],
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer(async (request, response) => {
    const recorded: RecordedRequest = {
      authorization: request.headers.authorization,
      editorId: request.headers["x-synodus-editor-id"] as string | undefined,
      method: request.method,
      url: request.url,
    };
    requests.push(recorded);
    await handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock core-api did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function readJSON(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function documentStatePath(): string {
  return `/internal/v1/orgs/${scope.organizationId}/teams/${scope.teamId}/documents/${scope.documentId}/state`;
}
