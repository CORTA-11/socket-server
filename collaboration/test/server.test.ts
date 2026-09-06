import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { test, type TestContext } from "node:test";

import { HocuspocusProvider } from "@hocuspocus/provider";

import { createCollaborationServer } from "../src/server.js";

const ticketSecret = "test-document-ticket-secret-value-123";
const organizationId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";

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
	const server = createCollaborationServer({ port: 0, ticketSecret });
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

test("a valid Document ticket joins only its intended Document Room", async (t) => {
	const server = createCollaborationServer({ port: 0, ticketSecret });
	await server.listen();
	t.after(() => server.destroy());
	const token = signDocumentTicket({
		document_id: documentId,
		exp: Math.floor(Date.now() / 1_000) + 60,
		org_id: organizationId,
		purpose: "document",
		team_id: teamId,
		user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	});

	await connectEditingSession(t, server.address.port, documentId, token);
	const rejection = await rejectEditingSession(
		t,
		server.address.port,
		"44444444-4444-4444-8444-444444444444",
		token,
	);

	assert.equal(rejection, "permission-denied");
});

test("altered and expired Document tickets are rejected", async (t) => {
	const server = createCollaborationServer({ port: 0, ticketSecret });
	await server.listen();
	t.after(() => server.destroy());
	const expired = signDocumentTicket({
		document_id: documentId,
		exp: Math.floor(Date.now() / 1_000) - 1,
		org_id: organizationId,
		purpose: "document",
		team_id: teamId,
		user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	});
	const altered = `${expired.slice(0, -1)}x`;

	assert.equal(
		await rejectEditingSession(t, server.address.port, documentId, expired),
		"permission-denied",
	);
	assert.equal(
		await rejectEditingSession(t, server.address.port, documentId, altered),
		"permission-denied",
	);
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

interface DocumentTicketClaims {
	document_id: string;
	exp: number;
	org_id: string;
	purpose: "document";
	team_id: string;
	user_id: string;
}

function signDocumentTicket(claims: DocumentTicketClaims): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const unsigned = `${header}.${payload}`;
	const signature = createHmac("sha256", ticketSecret).update(unsigned).digest("base64url");
	return `${unsigned}.${signature}`;
}

async function connectEditingSession(
	t: TestContext,
	port: number,
	name: string,
	token: string,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const provider = new HocuspocusProvider({
			name,
			token,
			url: `ws://127.0.0.1:${port}/ws/docs`,
			onAuthenticated: () => {
				clearTimeout(timeout);
				provider.destroy();
				resolve();
			},
			onAuthenticationFailed: ({ reason }) => reject(new Error(reason)),
		});
		t.after(() => provider.destroy());
		const timeout = setTimeout(() => reject(new Error("authentication timed out")), 2_000);
	});
}

async function rejectEditingSession(
	t: TestContext,
	port: number,
	name: string,
	token: string,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const provider = new HocuspocusProvider({
			name,
			token,
			url: `ws://127.0.0.1:${port}/ws/docs`,
			onAuthenticationFailed: ({ reason }) => {
				clearTimeout(timeout);
				provider.destroy();
				resolve(reason);
			},
		});
		t.after(() => provider.destroy());
		const timeout = setTimeout(() => reject(new Error("authentication rejection timed out")), 2_000);
	});
}
