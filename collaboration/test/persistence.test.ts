import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";

import { HocuspocusProvider } from "@hocuspocus/provider";
import { TiptapTransformer } from "@hocuspocus/transformer";
import StarterKit from "@tiptap/starter-kit";
import WebSocket from "ws";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";

import {
  createCollaborationServer,
  documentRoomName,
  loadDocumentState,
  storeDocumentState,
} from "../src/server.js";
import type { DocumentScope } from "../src/storage.js";

const ticketSecret = "test-document-ticket-secret-value-123";
const serviceSecret = "test-collaboration-service-secret-123";
const organizationId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";
const editorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const trustedOrigin = "https://app.example";
const defaultScope = { documentId, organizationId, teamId };

test("a Document without canonical state initializes its named fields from persisted projections", async (t) => {
  const coreAPIURL = await mockCoreAPI(t, async (_request, response) => {
    json(response, 200, stateResponse(""));
  });
  const server = createCollaborationServer({
    allowedOrigins: [trustedOrigin], collaborationServiceSecret: serviceSecret,
    coreAPIURL, port: 0, ticketSecret,
  });
  await server.listen();
  t.after(() => server.destroy());

  const provider = await connectedProvider(t, server.address.port);

  assert.match(JSON.stringify(TiptapTransformer.fromYdoc(provider.document, "title")), /Research notes/);
  assert.match(JSON.stringify(TiptapTransformer.fromYdoc(provider.document, "body")), /Persisted/);
});

test("a fresh collaboration process reloads the canonical state stored through core-api", async (t) => {
  let canonicalState = "";
  let storedBody: Record<string, unknown> | undefined;
  const coreAPIURL = await mockCoreAPI(t, async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${serviceSecret}`);
    assert.equal(request.headers["x-synodus-editor-id"], editorId);
    if (request.method === "GET") {
      json(response, 200, stateResponse(canonicalState, "", ""));
      return;
    }
    storedBody = await readJSON(request) as Record<string, unknown>;
    canonicalState = storedBody.canonical_state as string;
    json(response, 200, stateResponse(canonicalState));
  });

  const firstServer = createCollaborationServer({
    allowedOrigins: [trustedOrigin], collaborationServiceSecret: serviceSecret,
    coreAPIURL, port: 0, ticketSecret,
  });
  await firstServer.listen();
  const firstProvider = await connectedProvider(t, firstServer.address.port);
  applyUpdate(firstProvider.document, encodeStateAsUpdate(collaborativeContent()));
  await waitFor(() => storedBody !== undefined);
  firstProvider.destroy();
  await firstServer.destroy();

  assert.equal(storedBody?.title, "Research notes");
  assert.equal(storedBody?.body_html, "<h2>Results</h2><p><strong>Converged</strong></p>");
  assert.equal(typeof storedBody?.canonical_state, "string");
  assert.ok(canonicalState.length > 0);

  const secondServer = createCollaborationServer({
    allowedOrigins: [trustedOrigin], collaborationServiceSecret: serviceSecret,
    coreAPIURL, port: 0, ticketSecret,
  });
  await secondServer.listen();
  t.after(() => secondServer.destroy());
  const secondProvider = await connectedProvider(t, secondServer.address.port);
  const body = TiptapTransformer.fromYdoc(secondProvider.document, "body") as Record<string, unknown>;

  assert.match(JSON.stringify(body), /Results/);
  assert.match(JSON.stringify(body), /Converged/);
});

test("same Document UUIDs in different tenants use isolated in-memory rooms", async (t) => {
  const otherScope = {
    documentId,
    organizationId: "44444444-4444-4444-8444-444444444444",
    teamId: "55555555-5555-4555-8555-555555555555",
  };
  const states = new Map([
    [organizationId, encodedContent("Tenant alpha")],
    [otherScope.organizationId, encodedContent("Tenant beta")],
  ]);
  const coreAPIURL = await mockCoreAPI(t, async (request, response) => {
    if (request.method === "GET") {
      const tenant = request.url?.split("/")[4] ?? "";
      json(response, 200, stateResponse(states.get(tenant) ?? ""));
      return;
    }
    json(response, 200, stateResponse(""));
  });
  const server = createCollaborationServer({
    allowedOrigins: [trustedOrigin], collaborationServiceSecret: serviceSecret,
    coreAPIURL, port: 0, ticketSecret,
  });
  await server.listen();
  t.after(() => server.destroy());

  const alpha = await connectedProvider(t, server.address.port, defaultScope);
  const beta = await connectedProvider(t, server.address.port, otherScope);

  assert.match(JSON.stringify(TiptapTransformer.fromYdoc(alpha.document, "title")), /Tenant alpha/);
  assert.match(JSON.stringify(TiptapTransformer.fromYdoc(beta.document, "title")), /Tenant beta/);
});

test("Hocuspocus persistence callbacks surface load and store failures", async () => {
  const claims = ticketClaims(defaultScope);
  const loadFailure = new Error("load failed");
  const storeFailure = new Error("store failed");
  const storage = {
    load: async (_scope: DocumentScope) => Promise.reject(loadFailure),
    store: async (): Promise<void> => Promise.reject(storeFailure),
  };

  await assert.rejects(loadDocumentState(storage, claims), loadFailure);
  await assert.rejects(storeDocumentState(storage, claims, new Doc()), storeFailure);
});

test("persistence callbacks reject canonical state beyond the configured Document bound", async () => {
  let stores = 0;
  const claims = ticketClaims(defaultScope);
  const storage = {
    load: async () => ({
      bodyHTML: "",
      canonicalState: Uint8Array.from([0, 0]),
      title: "",
    }),
    store: async (): Promise<void> => {
      stores += 1;
    },
  };

  await assert.rejects(
    loadDocumentState(storage, claims, 1),
    /Document resource limit exceeded/,
  );
  await assert.rejects(
    storeDocumentState(storage, claims, new Doc(), 1),
    /Document resource limit exceeded/,
  );
  await assert.rejects(
    loadDocumentState({
      ...storage,
      load: async () => ({
        bodyHTML: `<p>${"x".repeat(1_000)}</p>`,
        canonicalState: new Uint8Array(),
        title: "Large projection",
      }),
    }, claims, 32),
    /Document resource limit exceeded/,
  );
  assert.equal(stores, 0);
});

function collaborativeContent() {
  const document = TiptapTransformer.toYdoc(tiptapDocument("Research notes"), "title", [StarterKit]);
  const body = TiptapTransformer.toYdoc({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Results" }] },
      { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "Converged" }] },
    ],
  }, "body", [StarterKit]);
  applyUpdate(document, encodeStateAsUpdate(body));
  return document;
}

interface RoomScope {
  documentId: string;
  organizationId: string;
  teamId: string;
}

async function connectedProvider(
  t: TestContext,
  port: number,
  scope: RoomScope = defaultScope,
): Promise<HocuspocusProvider> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Document synchronization timed out")), 3_000);
    const configuration = {
      name: documentRoomName(scope),
      onAuthenticationFailed: ({ reason }: { reason: string }) => reject(new Error(reason)),
      onSynced: () => {
        clearTimeout(timeout);
        resolve(provider);
      },
      token: signedTicket(scope),
      url: `ws://127.0.0.1:${port}/ws/docs?org_id=${scope.organizationId}&team_id=${scope.teamId}`,
      WebSocketPolyfill: webSocketWithOrigin(),
    };
    const provider = new HocuspocusProvider(configuration);
    t.after(() => provider.destroy());
  });
}

function signedTicket(scope: RoomScope = defaultScope): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    document_id: scope.documentId,
    display_name: "Authenticated Editor",
    exp: Math.floor(Date.now() / 1_000) + 60,
    org_id: scope.organizationId,
    purpose: "document",
    team_id: scope.teamId,
    user_id: editorId,
  })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", ticketSecret).update(unsigned).digest("base64url")}`;
}

function ticketClaims(scope: RoomScope) {
  return {
    documentId: scope.documentId,
    displayName: "Authenticated Editor",
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    userId: editorId,
  };
}

function encodedContent(text: string): string {
  return Buffer.from(encodeStateAsUpdate(
    TiptapTransformer.toYdoc(tiptapDocument(text), "title", [StarterKit]),
  )).toString("base64");
}

function webSocketWithOrigin() {
  return class extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { origin: trustedOrigin });
    }
  };
}

async function mockCoreAPI(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => void handler(request, response));
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

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("core-api did not receive stored Document state");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function stateResponse(
  state: string,
  title = "Research notes",
  bodyHTML = "<p>Persisted</p>",
) {
  return {
    canonical_state: state,
    title,
    body_html: bodyHTML,
    updated_by: editorId,
    updated_at: "2026-09-07T09:30:00Z",
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function tiptapDocument(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}
