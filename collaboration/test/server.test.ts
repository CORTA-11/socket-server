import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { test, type TestContext } from "node:test";

import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";

import { defaultCollaborationServiceSecret } from "../src/config.js";
import { InMemoryRoomLifecycle } from "../src/room-lifecycle.js";
import {
  createCollaborationServer,
  documentRoomName,
} from "../src/server.js";
import {
  protectInboundQueue,
  protectSlowEditingSession,
} from "../src/resource-limits.js";

const ticketSecret = "test-document-ticket-secret-value-123";
const organizationId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";
const trustedOrigin = "https://app.example";
const roomName = documentRoomName({ documentId, organizationId, teamId });

test("collaboration health is observable independently", async (t) => {
  const server = createCollaborationServer({ port: 0 });
  await server.listen();
  t.after(() => server.destroy());

  const metrics = await fetch(`http://127.0.0.1:${server.address.port}/metrics`);
  assert.match(await metrics.text(), /corta_collaboration_healthy 1/);
  const response = await fetch(`http://127.0.0.1:${server.address.port}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "collaboration-server",
  });
});

test("collaboration health reports a required dependency failure without logging details", async (t) => {
  const roomLifecycle = {
    delete: async () => undefined,
    destroy: async () => undefined,
    health: async () => Promise.reject(new Error("redis-password-must-not-leak")),
    isDeleted: async () => false,
    start: async () => undefined,
  };
  const server = createCollaborationServer({ dependencyTimeout: 20, port: 0, roomLifecycle });
  await server.listen();
  t.after(() => server.destroy());

  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => logged.push(values);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${server.address.port}/health`);
  } finally {
    console.error = originalError;
  }

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    dependencies: { room_lifecycle: "unavailable" },
    ok: false,
    service: "collaboration-server",
  });
  const metrics = await fetch(`http://127.0.0.1:${server.address.port}/metrics`);
  assert.match(await metrics.text(), /corta_collaboration_healthy 0/);
  assert.doesNotMatch(JSON.stringify(logged), /redis-password-must-not-leak/);
});

test("collaboration health bounds a stalled dependency check", async (t) => {
  const roomLifecycle = {
    delete: async () => undefined,
    destroy: async () => undefined,
    health: async () => new Promise<boolean>(() => undefined),
    isDeleted: async () => false,
    start: async () => undefined,
  };
  const server = createCollaborationServer({ dependencyTimeout: 20, port: 0, roomLifecycle });
  await server.listen();
  t.after(() => server.destroy());
  const startedAt = Date.now();

  const response = await fetch(`http://127.0.0.1:${server.address.port}/health`);

  assert.equal(response.status, 503);
  assert.ok(Date.now() - startedAt < 500);
});

test("metrics expose collaboration activity and authentication failures", async (t) => {
  const server = createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    port: 0,
    ticketSecret,
  });
  await server.listen();
  t.after(() => server.destroy());

  const provider = await authenticatedEditingSession(
    t,
    server.address.port,
    roomName,
    validDocumentTicket(),
  );
  const privateTicket = signDocumentTicket({
    ...validClaims(),
    display_name: "private-editor@example.com",
    exp: Math.floor(Date.now() / 1_000) - 1,
  });
  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => logged.push(values);
  try {
    await rejectEditingSession(t, server.address.port, roomName, privateTicket);
  } finally {
    console.error = originalError;
  }

  const response = await fetch(`http://127.0.0.1:${server.address.port}/metrics`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(body, /corta_collaboration_active_rooms 1/);
  assert.match(body, /corta_collaboration_active_editing_sessions 1/);
  assert.match(body, /corta_collaboration_authentication_failures_total 1/);
  assert.doesNotMatch(body, /private-editor|Authenticated Editor/);
  assert.doesNotMatch(JSON.stringify(logged), /private-editor/);
  assert.ok(!JSON.stringify(logged).includes(privateTicket));
  provider.destroy();
  await waitFor(() => server.hocuspocus.getConnectionsCount() === 0);

  const reconnected = await authenticatedEditingSession(
    t,
    server.address.port,
    roomName,
    validDocumentTicket(),
  );
  const reconnectMetrics = await fetch(`http://127.0.0.1:${server.address.port}/metrics`);
  assert.match(await reconnectMetrics.text(), /corta_collaboration_reconnects_total 1/);
  reconnected.destroy();
});

test("metrics count a room-lifecycle failure during persistence", async (t) => {
  let deletionChecks = 0;
  const roomLifecycle = {
    delete: async () => undefined,
    destroy: async () => undefined,
    health: async () => true,
    isDeleted: async () => {
      deletionChecks += 1;
      if (deletionChecks === 1) {
        return false;
      }
      throw new Error("redis-password-must-not-leak");
    },
    start: async () => undefined,
  };
  const server = createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    persistenceDebounce: 1,
    port: 0,
    roomLifecycle,
    ticketSecret,
  });
  await server.listen();
  t.after(() => server.destroy());
  const provider = await authenticatedEditingSession(
    t,
    server.address.port,
    roomName,
    validDocumentTicket(),
  );

  provider.document.getMap("operational-test").set("changed", true);

  await waitForMetric(server.address.port, /corta_collaboration_store_failures_total 1/);
  provider.destroy();
});

test("an oversized WebSocket message is isolated from valid Editing Sessions", async (t) => {
  const server = createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    maxWebSocketMessageBytes: 1_024,
    port: 0,
    ticketSecret,
  });
  await server.listen();
  t.after(() => server.destroy());

  const closeCode = await oversizedMessageCloseCode(t, server.address.port, 1_025);
  await connectEditingSession(t, server.address.port, roomName, validDocumentTicket());

  assert.equal(closeCode, 1009);
});

test("a slow Editing Session is closed without affecting another socket", () => {
  const slow = fakeBackpressureSocket(9);
  const healthy = fakeBackpressureSocket(0);
  let limited = 0;
  protectSlowEditingSession(slow, 8, () => limited += 1);
  protectSlowEditingSession(healthy, 8, () => limited += 1);

  assert.deepEqual(slow.closeEvents, [{ code: 1013, reason: "Editing Session is too slow" }]);
  slow.send(Buffer.from("first"));
  slow.send(Buffer.from("ignored"));
  healthy.send(Buffer.from("delivered"));

  assert.equal(slow.sent, 0);
  assert.equal(healthy.sent, 1);
  assert.equal(limited, 1);
});

test("an authenticated Editing Session has bounded inbound work", () => {
  const constrained = fakeInboundConnection();
  const healthy = fakeInboundConnection();
  protectInboundQueue(constrained, 4, 2);
  protectInboundQueue(healthy, 4, 2);

  constrained.handleMessage(Uint8Array.from([1, 2]));
  constrained.handleMessage(Uint8Array.from([3, 4]));
  constrained.handleMessage(Uint8Array.from([5]));
  healthy.handleMessage(Uint8Array.from([1]));

  assert.equal(constrained.handled, 2);
  assert.deepEqual(constrained.webSocket.closeEvents, [{
    code: 1008,
    reason: "Editing Session sent messages too quickly",
  }]);
  assert.equal(healthy.handled, 1);
});

test("missing and malformed Document tickets are rejected", async (t) => {
  const server = createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    authenticationTimeout: 100,
    port: 0,
    ticketSecret,
  });
  await server.listen();
  t.after(() => server.destroy());

  const reason = await rejectEditingSession(
    t,
    server.address.port,
    roomName,
    "not-a-document-ticket",
  );

  assert.equal(reason, "permission-denied");
  assert.equal(
    await closeCodeWithoutTicket(t, server.address.port, roomName),
    4408,
  );
});

test("a valid Document ticket joins only its intended Document Room", async (t) => {
  const server = createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    port: 0,
    ticketSecret,
  });
  await server.listen();
  t.after(() => server.destroy());
  const token = validDocumentTicket();

  await connectEditingSession(t, server.address.port, roomName, token);
  const rejection = await rejectEditingSession(
    t,
    server.address.port,
    documentRoomName({
      documentId: "44444444-4444-4444-8444-444444444444",
      organizationId,
      teamId,
    }),
    token,
  );

  assert.equal(rejection, "permission-denied");
});

test("Presence uses authenticated identity and distinct Editing Sessions", async (t) => {
  const server = createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    port: 0,
    ticketSecret,
  });
  await server.listen();
  t.after(() => server.destroy());
  const editorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const observerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const editorTicket = signDocumentTicket({
    ...validClaims(),
    display_name: "Ayesha Fernando",
    user_id: editorId,
  });
  const observerTicket = signDocumentTicket({
    ...validClaims(),
    display_name: "Malik Perera",
    user_id: observerId,
  });
  const firstSession = editingSession(t, server.address.port, roomName, editorTicket, {});
  const secondSession = editingSession(t, server.address.port, roomName, editorTicket, {});
  const observer = editingSession(t, server.address.port, roomName, observerTicket, {});
  await waitFor(() => server.hocuspocus.getConnectionsCount() === 3);

  for (const provider of [firstSession, secondSession]) {
    provider.setAwarenessField("user", {
      color: "#ffffff",
      email: "leaked@example.com",
      id: "forged-id",
      name: "Forged Name",
      sessionId: "forged-session",
    });
  }

  await waitFor(() => presenceFor(observer, editorId).length === 2);
  const sessions = presenceFor(observer, editorId);
  assert.deepEqual(new Set(sessions.map((presence) => presence.name)), new Set(["Ayesha Fernando"]));
  assert.equal(new Set(sessions.map((presence) => presence.color)).size, 1);
  assert.equal(new Set(sessions.map((presence) => presence.sessionId)).size, 2);
  assert.ok(sessions.every((presence) => presence.email === undefined));

  firstSession.destroy();
  await waitFor(() => presenceFor(observer, editorId).length === 1);
});

test("deleting a Document closes its room on every replica and rejects new Editing Sessions", async (t) => {
  const roomLifecycle = new InMemoryRoomLifecycle();
  const receivingServer = createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    port: 0,
    roomLifecycle,
    ticketSecret,
  });
  const deletingServer = createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    port: 0,
    roomLifecycle,
    ticketSecret,
  });
  await Promise.all([receivingServer.listen(), deletingServer.listen()]);
  t.after(() => Promise.all([receivingServer.destroy(), deletingServer.destroy()]));
  let resolveDeleted!: (payload: string) => void;
  const deleted = new Promise<string>((resolve) => {
    resolveDeleted = resolve;
  });
  const provider = editingSession(
    t,
    receivingServer.address.port,
    roomName,
    validDocumentTicket(),
    {},
    undefined,
    undefined,
    ({ payload }) => {
      resolveDeleted(payload);
      provider.destroy();
    },
  );
  await waitFor(() => receivingServer.hocuspocus.getConnectionsCount() === 1);

  const response = await fetch(
    `http://127.0.0.1:${deletingServer.address.port}/internal/v1/orgs/${organizationId}` +
      `/teams/${teamId}/documents/${documentId}/room`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${defaultCollaborationServiceSecret}` },
    },
  );

  assert.equal(response.status, 204);
  assert.deepEqual(JSON.parse(await deleted), { type: "document.deleted" });
  await waitFor(() => receivingServer.hocuspocus.getConnectionsCount() === 0);
  await waitFor(() => receivingServer.hocuspocus.getDocumentsCount() === 0);
  assert.equal(
    await rejectEditingSession(t, receivingServer.address.port, roomName, validDocumentTicket()),
    "permission-denied",
  );
});

test("closing a Document Room requires service authentication", async (t) => {
  const server = createCollaborationServer({
    port: 0,
  });
  await server.listen();
  t.after(() => server.destroy());

  const response = await fetch(
    `http://127.0.0.1:${server.address.port}/internal/v1/orgs/${organizationId}` +
      `/teams/${teamId}/documents/${documentId}/room`,
    { method: "DELETE" },
  );

  assert.equal(response.status, 401);
});

test("altered and expired Document tickets are rejected", async (t) => {
  const server = createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    port: 0,
    ticketSecret,
  });
  await server.listen();
  t.after(() => server.destroy());
  const expired = signDocumentTicket({
    ...validClaims(),
    exp: Math.floor(Date.now() / 1_000) - 1,
  });
  const altered = nonCanonicalSignature(validDocumentTicket());

  assert.equal(
    await rejectEditingSession(t, server.address.port, roomName, expired),
    "permission-denied",
  );
  assert.equal(
    await rejectEditingSession(t, server.address.port, roomName, altered),
    "permission-denied",
  );
});

test("cross-organization, cross-team, malformed-user, and untrusted-origin sessions are rejected", async (t) => {
  const server = createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    port: 0,
    ticketSecret,
  });
  await server.listen();
  t.after(() => server.destroy());
  const token = validDocumentTicket();
  const malformedUser = signDocumentTicket({
    ...validClaims(),
    user_id: "not-a-user-id",
  });

  for (const options of [
    { organizationId: "44444444-4444-4444-8444-444444444444" },
    { teamId: "55555555-5555-4555-8555-555555555555" },
    { origin: "https://attacker.example" },
  ]) {
    assert.equal(
      await rejectEditingSession(t, server.address.port, roomName, token, options),
      "permission-denied",
    );
  }
  assert.equal(
    await rejectEditingSession(t, server.address.port, roomName, malformedUser),
    "permission-denied",
  );
});

test("the collaboration process shuts down cleanly on SIGTERM", async (t) => {
  const port = await availablePort();
  const child = spawn(process.execPath, ["dist/src/main.js"], {
    cwd: process.cwd(),
    env: { ...process.env, COLLABORATION_PORT: String(port), NODE_ENV: "test" },
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

interface DocumentTicketClaims {
	document_id: string;
	display_name: string;
	exp: number;
	org_id: string;
	purpose: "document";
	team_id: string;
	user_id: string;
}

interface ConnectionOptions {
  organizationId?: string;
  origin?: string;
  teamId?: string;
}

function validClaims(): DocumentTicketClaims {
  return {
    document_id: documentId,
    display_name: "Authenticated Editor",
    exp: Math.floor(Date.now() / 1_000) + 60,
    org_id: organizationId,
    purpose: "document",
    team_id: teamId,
    user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
}

type Presence = {
  color?: unknown;
  email?: unknown;
  id?: unknown;
  name?: unknown;
  sessionId?: unknown;
};

function presenceFor(provider: HocuspocusProvider, userId: string): Presence[] {
  return Array.from(provider.awareness?.getStates().values() ?? [])
    .map((state) => state.user as Presence | undefined)
    .filter((presence): presence is Presence => presence?.id === userId);
}

function validDocumentTicket(): string {
  return signDocumentTicket(validClaims());
}

function signDocumentTicket(claims: DocumentTicketClaims): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const unsigned = `${header}.${payload}`;
	const signature = createHmac("sha256", ticketSecret).update(unsigned).digest("base64url");
	return `${unsigned}.${signature}`;
}

function nonCanonicalSignature(token: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const signature = token.split(".")[2]!;
  const canonicalIndex = alphabet.indexOf(signature.at(-1)!);
  const equivalentIndex = canonicalIndex + 1;
  assert.equal(canonicalIndex % 4, 0);
  return `${token.slice(0, -1)}${alphabet[equivalentIndex]}`;
}

async function closeCodeWithoutTicket(
  t: TestContext,
  port: number,
  name: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/ws/docs?org_id=${organizationId}&team_id=${teamId}`;
    const configuration = {
      name,
      token: null,
      url,
      WebSocketPolyfill: webSocketWithOrigin(trustedOrigin),
      onClose: ({ event }: { event: { code: number } }) => {
        clearTimeout(timeout);
        provider.destroy();
        resolve(event.code);
      },
    };
    const provider = new HocuspocusProvider(configuration);
    t.after(() => provider.destroy());
    const timeout = setTimeout(() => {
      provider.destroy();
      reject(new Error("missing-ticket connection did not close"));
    }, 2_000);
  });
}

async function connectEditingSession(
  t: TestContext,
  port: number,
  name: string,
  token: string,
  options: ConnectionOptions = {},
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const authenticationTimeout = setTimeout(
			() => reject(new Error("authentication timed out")),
			2_000,
		);
		const provider = editingSession(t, port, name, token, options, ({ provider, timeout }) => {
			clearTimeout(authenticationTimeout);
			clearTimeout(timeout);
			provider.destroy();
			resolve();
		}, ({ reason, timeout }) => {
			clearTimeout(authenticationTimeout);
			clearTimeout(timeout);
			reject(new Error(reason));
		});
	});
}

async function authenticatedEditingSession(
  t: TestContext,
  port: number,
  name: string,
  token: string,
): Promise<HocuspocusProvider> {
  return new Promise((resolve, reject) => {
    const authenticationTimeout = setTimeout(
      () => reject(new Error("authentication timed out")),
      2_000,
    );
    editingSession(t, port, name, token, {}, ({ provider, timeout }) => {
      clearTimeout(authenticationTimeout);
      clearTimeout(timeout);
      resolve(provider);
    }, ({ reason, timeout }) => {
      clearTimeout(authenticationTimeout);
      clearTimeout(timeout);
      reject(new Error(reason));
    });
  });
}

async function rejectEditingSession(
	t: TestContext,
	port: number,
	name: string,
	token: string,
	options: ConnectionOptions = {},
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const rejectionTimeout = setTimeout(
			() => reject(new Error("authentication rejection timed out")),
			2_000,
		);
		editingSession(t, port, name, token, options, undefined, ({ provider, reason, timeout }) => {
			clearTimeout(rejectionTimeout);
			clearTimeout(timeout);
			provider.destroy();
			resolve(reason);
		});
	});
}

type AuthenticationEvent = {
  provider: HocuspocusProvider;
  timeout: NodeJS.Timeout;
};

function editingSession(
  t: TestContext,
  port: number,
  name: string,
  token: string,
  options: ConnectionOptions,
  authenticated?: (event: AuthenticationEvent) => void,
  rejected?: (event: AuthenticationEvent & { reason: string }) => void,
  stateless?: (event: { payload: string }) => void,
): HocuspocusProvider {
  const org = options.organizationId ?? organizationId;
  const team = options.teamId ?? teamId;
  const url = `ws://127.0.0.1:${port}/ws/docs?org_id=${org}&team_id=${team}`;
  let timeout: NodeJS.Timeout;
  const configuration = {
    name,
    token,
    url,
    WebSocketPolyfill: webSocketWithOrigin(options.origin ?? trustedOrigin),
    onAuthenticated: () => authenticated?.({ provider, timeout }),
    onAuthenticationFailed: ({ reason }: { reason: string }) =>
      rejected?.({ provider, reason, timeout }),
    ...(stateless === undefined ? {} : { onStateless: stateless }),
  };
  const provider = new HocuspocusProvider(configuration);
  timeout = setTimeout(() => provider.destroy(), 2_000);
  t.after(() => {
    provider.destroy();
  });
  return provider;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("collaboration state did not settle");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForMetric(port: number, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    if (pattern.test(await response.text())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`metric did not match ${pattern}`);
}

type WebSocketConstructor = new (
  address: string | URL,
  protocols?: string | string[],
) => WebSocket;

function webSocketWithOrigin(origin: string): WebSocketConstructor {
  return class extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { origin });
    }
  };
}

async function oversizedMessageCloseCode(
  t: TestContext,
  port: number,
  bytes: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/docs?org_id=${organizationId}&team_id=${teamId}`,
      { origin: trustedOrigin },
    );
    t.after(() => socket.terminate());
    const timeout = setTimeout(() => reject(new Error("oversized message was not closed")), 2_000);
    socket.once("open", () => socket.send(Buffer.alloc(bytes)));
    socket.once("error", () => undefined);
    socket.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function fakeBackpressureSocket(bufferedAmount: number) {
  return {
    bufferedAmount,
    closeEvents: [] as Array<{ code: number | undefined; reason: string | undefined }>,
    sent: 0,
    close(code?: number, reason?: string) {
      this.closeEvents.push({ code, reason });
    },
    send(_data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      this.sent += 1;
    },
  };
}

function fakeInboundConnection() {
  const webSocket = fakeBackpressureSocket(0);
  return {
    handled: 0,
    webSocket,
    handleMessage(_data: Uint8Array) {
      this.handled += 1;
    },
    waitForPendingMessages: () => new Promise<void>(() => undefined),
  };
}
