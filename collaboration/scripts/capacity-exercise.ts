import { createHmac, randomBytes } from "node:crypto";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";

import { initializeDocument } from "../src/initial-state.js";
import { createCollaborationServer, documentRoomName } from "../src/server.js";

const ticketSecret = "capacity-document-ticket-secret-value";
const serviceSecret = "capacity-collaboration-service-secret";
const trustedOrigin = "https://capacity.example";
const organizationId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const mib = 1024 * 1024;
const exerciseMaximums: CapacityExerciseOptions = {
  activeRooms: 2_000,
  documentBytes: 16 * mib,
  editorsPerDocument: 250,
  timeoutMs: 10 * 60_000,
};

export interface CapacityExerciseOptions {
  activeRooms: number;
  documentBytes: number;
  editorsPerDocument: number;
  timeoutMs: number;
}

interface MetricSnapshot {
  activeEditingSessions: number;
  activeRooms: number;
}

interface ResourceSnapshot {
  externalBytes: number;
  heapUsedBytes: number;
  rssBytes: number;
}

export interface CapacityExerciseReport {
  collaborativeChanges: {
    convergedEditors: number;
    durationMs: number;
    metrics: MetricSnapshot;
  };
  failures: [];
  largeDocument: {
    changePersisted: true;
    durationMs: number;
    loadedBytes: number;
    persistedBytes: number;
    reloadedBytes: number;
  };
  resources: {
    end: ResourceSnapshot;
    peak: ResourceSnapshot;
    peakRssBytes: number;
    start: ResourceSnapshot;
    startRssBytes: number;
  };
  roomObservability: {
    durationMs: number;
    metrics: MetricSnapshot;
  };
  status: "passed";
  targets: CapacityExerciseOptions;
  totalDurationMs: number;
}

export async function runCapacityExercise(
  options: CapacityExerciseOptions,
): Promise<CapacityExerciseReport> {
  validateOptions(options);
  const startedAt = Date.now();
  const start = resources();
  let peak = start;
  const observeResources = () => {
    peak = maximumResources(peak, resources());
  };

  const collaborativeChanges = await exerciseCollaborativeChanges(options, observeResources);
  const largeDocument = await exerciseLargeDocument(options, observeResources);
  const roomObservability = await exerciseRoomObservability(options, observeResources);
  const end = resources();
  peak = maximumResources(peak, end);

  return {
    collaborativeChanges,
    failures: [],
    largeDocument,
    resources: {
      end,
      peak,
      peakRssBytes: peak.rssBytes,
      start,
      startRssBytes: start.rssBytes,
    },
    roomObservability,
    status: "passed",
    targets: options,
    totalDurationMs: Date.now() - startedAt,
  };
}

async function exerciseCollaborativeChanges(
  options: CapacityExerciseOptions,
  observeResources: () => void,
) {
  const startedAt = Date.now();
  const documentId = uuid(1);
  const roomName = room(documentId);
  const server = createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    port: 0,
    ticketSecret,
  });
  const providers: HocuspocusProvider[] = [];
  try {
    await server.listen();
    await collectProviders(Array.from(
      { length: options.editorsPerDocument },
      (_, index) => connectProvider(server.address.port, documentId, index, options.timeoutMs),
    ), providers);
    providers.forEach((provider, index) => {
      provider.document.getMap("capacity-changes").set(`editor-${index}`, `change-${index}`);
    });
    await waitFor(
      () => providers.every((provider) =>
        provider.document.getMap("capacity-changes").size === options.editorsPerDocument),
      options.timeoutMs,
      "Editing Sessions did not converge",
    );
    observeResources();
    const observedMetrics = await metrics(server.address.port, options.timeoutMs, roomName);
    if (observedMetrics.activeEditingSessions !== options.editorsPerDocument ||
        observedMetrics.activeRooms !== 1) {
      throw new Error("collaborative-change metrics did not match active sessions and rooms");
    }
    return {
      convergedEditors: providers.length,
      durationMs: Date.now() - startedAt,
      metrics: observedMetrics,
    };
  } finally {
    providers.forEach((provider) => provider.destroy());
    await server.destroy();
  }
}

async function exerciseLargeDocument(
  options: CapacityExerciseOptions,
  observeResources: () => void,
) {
  const startedAt = Date.now();
  const documentId = uuid(2);
  let canonicalState = largeDocumentState(options.documentBytes);
  const loadedBytes = canonicalState.byteLength;
  let changePersisted = false;
  const coreAPI = await startStateAuthority({
    getState: () => canonicalState,
    storeState: (state) => {
      canonicalState = state;
      const stored = new Doc();
      applyUpdate(stored, state);
      changePersisted = stored.getMap("capacity").get("changed-after-load") === true;
    },
  }, Math.ceil((options.documentBytes + mib) / 3) * 4 + mib);
  const documentLimit = options.documentBytes + mib;
  let firstServer = createPersistentServer(coreAPI.url, documentLimit);
  let provider: HocuspocusProvider | undefined;
  try {
    await firstServer.listen();
    provider = await connectProvider(firstServer.address.port, documentId, 0, options.timeoutMs);
    const payload = provider.document.getMap("capacity").get("payload");
    if (!(payload instanceof Uint8Array) || payload.byteLength < options.documentBytes) {
      throw new Error("large Document payload did not load through the collaboration protocol");
    }
    provider.document.getMap("capacity").set("changed-after-load", true);
    await waitFor(
      () => changePersisted,
      options.timeoutMs,
      "large Document change did not persist",
    );
    observeResources();
    provider.destroy();
    provider = undefined;
    await firstServer.destroy();

    const persistedBytes = canonicalState.byteLength;
    const secondServer = createPersistentServer(coreAPI.url, documentLimit);
    firstServer = secondServer;
    await secondServer.listen();
    provider = await connectProvider(secondServer.address.port, documentId, 1, options.timeoutMs);
    const reloadedState = encodeStateAsUpdate(provider.document);
    if (provider.document.getMap("capacity").get("changed-after-load") !== true) {
      throw new Error("persisted large Document change did not reload");
    }
    observeResources();
    return {
      changePersisted: true as const,
      durationMs: Date.now() - startedAt,
      loadedBytes,
      persistedBytes,
      reloadedBytes: reloadedState.byteLength,
    };
  } finally {
    provider?.destroy();
    await firstServer.destroy();
    await coreAPI.close();
  }
}

async function exerciseRoomObservability(
  options: CapacityExerciseOptions,
  observeResources: () => void,
) {
  const startedAt = Date.now();
  const server = createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    port: 0,
    ticketSecret,
  });
  const providers: HocuspocusProvider[] = [];
  try {
    await server.listen();
    const batchSize = Math.min(25, options.activeRooms);
    for (let offset = 0; offset < options.activeRooms; offset += batchSize) {
      const batch = Array.from(
        { length: Math.min(batchSize, options.activeRooms - offset) },
        (_, index) => {
          const roomIndex = offset + index + 100;
          return connectProvider(
            server.address.port,
            uuid(roomIndex),
            roomIndex,
            options.timeoutMs,
          );
        },
      );
      await collectProviders(batch, providers);
      observeResources();
    }
    await waitFor(
      () => server.hocuspocus.getDocumentsCount() === options.activeRooms &&
        server.hocuspocus.getConnectionsCount() === options.activeRooms,
      options.timeoutMs,
      "room metrics did not reach the exercise target",
    );
    const observedMetrics = await metrics(server.address.port, options.timeoutMs);
    if (observedMetrics.activeEditingSessions !== options.activeRooms ||
        observedMetrics.activeRooms !== options.activeRooms) {
      throw new Error("public room metrics did not match the active Document Room target");
    }
    return {
      durationMs: Date.now() - startedAt,
      metrics: observedMetrics,
    };
  } finally {
    providers.forEach((provider) => provider.destroy());
    await server.destroy();
  }
}

function createPersistentServer(coreAPIURL: string, maxDocumentBytes: number) {
  return createCollaborationServer({
    allowedOrigins: [trustedOrigin],
    collaborationServiceSecret: serviceSecret,
    coreAPIURL,
    dependencyTimeout: 10_000,
    maxDocumentBytes,
    maxPersistenceResponseBytes: Math.ceil(maxDocumentBytes / 3) * 4 + 1024,
    maxWebSocketMessageBytes: maxDocumentBytes,
    persistenceDebounce: 1,
    persistenceMaxDebounce: 10,
    port: 0,
    ticketSecret,
  });
}

function largeDocumentState(targetBytes: number): Uint8Array {
  const document = initializeDocument("Capacity exercise", "<p>Large Document</p>");
  document.getMap("capacity").set("payload", new Uint8Array(randomBytes(targetBytes)));
  const state = encodeStateAsUpdate(document);
  if (state.byteLength < targetBytes) {
    throw new Error("could not construct the requested encoded Document size");
  }
  return state;
}

async function connectProvider(
  port: number,
  documentId: string,
  editorIndex: number,
  timeoutMs: number,
): Promise<HocuspocusProvider> {
  return new Promise((resolve, reject) => {
    let provider: HocuspocusProvider;
    const timeout = setTimeout(() => {
      provider?.destroy();
      reject(new Error("Editing Session synchronization timed out"));
    }, timeoutMs);
    const configuration = {
      name: room(documentId),
      onAuthenticationFailed: ({ reason }: { reason: string }) => {
        clearTimeout(timeout);
        provider.destroy();
        reject(new Error(`Editing Session authentication failed: ${reason}`));
      },
      onSynced: () => {
        clearTimeout(timeout);
        resolve(provider);
      },
      token: signedTicket(documentId, editorIndex),
      url: `ws://127.0.0.1:${port}/ws/docs?org_id=${organizationId}&team_id=${teamId}`,
      WebSocketPolyfill: webSocketWithOrigin(),
    };
    provider = new HocuspocusProvider(configuration);
  });
}

function signedTicket(documentId: string, editorIndex: number): string {
  const claims = {
    document_id: documentId,
    display_name: `Capacity Editor ${editorIndex + 1}`,
    exp: Math.floor(Date.now() / 1_000) + 15 * 60,
    org_id: organizationId,
    purpose: "document",
    team_id: teamId,
    user_id: uuid(10_000 + editorIndex),
  };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", ticketSecret).update(unsigned).digest("base64url")}`;
}

function webSocketWithOrigin() {
  return class extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { origin: trustedOrigin });
    }
  };
}

function room(documentId: string): string {
  return documentRoomName({ documentId, organizationId, teamId });
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

async function metrics(
  port: number,
  timeoutMs: number,
  expectedRoom?: string,
): Promise<MetricSnapshot> {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`metrics request failed with status ${response.status}`);
  }
  const body = await response.text();
  if (expectedRoom !== undefined && body.includes(expectedRoom)) {
    throw new Error("metrics exposed a Document Room identity");
  }
  return {
    activeEditingSessions: metricValue(body, "corta_collaboration_active_editing_sessions"),
    activeRooms: metricValue(body, "corta_collaboration_active_rooms"),
  };
}

function metricValue(body: string, name: string): number {
  const match = body.match(new RegExp(`^${name} (\\d+)$`, "m"));
  if (match?.[1] === undefined) {
    throw new Error(`metrics response omitted ${name}`);
  }
  return Number(match[1]);
}

interface StateAuthority {
  close(): Promise<void>;
  url: string;
}

async function startStateAuthority(storage: {
  getState(): Uint8Array;
  storeState(state: Uint8Array): void;
}, maxRequestBytes: number): Promise<StateAuthority> {
  const server = createHTTPServer((request, response) => {
    void handleStateRequest(request, response, storage, maxRequestBytes).catch(() => {
      if (!response.headersSent) {
        response.writeHead(413);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("capacity state authority did not bind a TCP port");
  }
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error === undefined ? resolve() : reject(error)));
    },
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function handleStateRequest(
  request: IncomingMessage,
  response: ServerResponse,
  storage: { getState(): Uint8Array; storeState(state: Uint8Array): void },
  maxRequestBytes: number,
): Promise<void> {
  if (request.url === "/health/ready") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "PUT") {
    const body = await readJSON(request, maxRequestBytes);
    const canonicalState = body.canonical_state;
    if (typeof canonicalState !== "string") {
      response.writeHead(400);
      response.end();
      return;
    }
    storage.storeState(new Uint8Array(Buffer.from(canonicalState, "base64")));
  }
  const state = storage.getState();
  const payload = JSON.stringify({
    body_html: "<p>Capacity Document</p>",
    canonical_state: Buffer.from(state).toString("base64"),
    title: "Capacity exercise",
  });
  response.writeHead(200, {
    "Content-Length": Buffer.byteLength(payload),
    "Content-Type": "application/json",
  });
  response.end(payload);
}

async function readJSON(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("capacity state request exceeded its resource bound");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      throw new Error("capacity state request exceeded its resource bound");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function resources(): ResourceSnapshot {
  const usage = process.memoryUsage();
  return {
    externalBytes: usage.external,
    heapUsedBytes: usage.heapUsed,
    rssBytes: usage.rss,
  };
}

function maximumResources(left: ResourceSnapshot, right: ResourceSnapshot): ResourceSnapshot {
  return {
    externalBytes: Math.max(left.externalBytes, right.externalBytes),
    heapUsedBytes: Math.max(left.heapUsedBytes, right.heapUsedBytes),
    rssBytes: Math.max(left.rssBytes, right.rssBytes),
  };
}

function validateOptions(options: CapacityExerciseOptions): void {
  positiveInteger("activeRooms", options.activeRooms, exerciseMaximums.activeRooms);
  positiveInteger("documentBytes", options.documentBytes, exerciseMaximums.documentBytes);
  positiveInteger(
    "editorsPerDocument",
    options.editorsPerDocument,
    exerciseMaximums.editorsPerDocument,
  );
  positiveInteger("timeoutMs", options.timeoutMs, exerciseMaximums.timeoutMs);
}

async function main(): Promise<void> {
  const targets: CapacityExerciseOptions = {
    activeRooms: readTarget("CAPACITY_ACTIVE_ROOMS", 500, exerciseMaximums.activeRooms),
    documentBytes: readTarget(
      "CAPACITY_DOCUMENT_BYTES",
      5 * mib,
      exerciseMaximums.documentBytes,
    ),
    editorsPerDocument: readTarget(
      "CAPACITY_EDITORS_PER_DOCUMENT",
      25,
      exerciseMaximums.editorsPerDocument,
    ),
    timeoutMs: readTarget("CAPACITY_TIMEOUT_MS", 120_000, exerciseMaximums.timeoutMs),
  };
  const startedAt = Date.now();
  try {
    console.log(JSON.stringify(await runCapacityExercise(targets), null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      failure: error instanceof Error ? error.message : "unknown failure",
      resources: resources(),
      status: "failed",
      targets,
      totalDurationMs: Date.now() - startedAt,
    }, null, 2));
    process.exitCode = 1;
  }
}

function readTarget(name: string, fallback: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return positiveInteger(name, Number(value), maximum);
}

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (value > maximum) {
    throw new Error(`${name} must not exceed the exercise safety maximum ${maximum}`);
  }
  return value;
}

async function collectProviders(
  connections: Promise<HocuspocusProvider>[],
  providers: HocuspocusProvider[],
): Promise<void> {
  const results = await Promise.allSettled(connections);
  for (const result of results) {
    if (result.status === "fulfilled") {
      providers.push(result.value);
    }
  }
  const failure = results.find((result): result is PromiseRejectedResult =>
    result.status === "rejected");
  if (failure !== undefined) {
    throw failure.reason;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
