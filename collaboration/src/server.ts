import { Server } from "@hocuspocus/server";
import { timingSafeEqual } from "node:crypto";
import { type Doc, encodeStateAsUpdate } from "yjs";

import { type DocumentTicketClaims, validateDocumentTicket, validateOrigin } from "./auth.js";
import {
  defaultAllowedOrigins,
  defaultCollaborationServiceSecret,
  defaultTicketSecret,
  type CollaborationConfig,
} from "./config.js";
import { materializeDocument } from "./projections.js";
import { initializeDocument } from "./initial-state.js";
import { CollaborationObservability, type HealthDependency } from "./observability.js";
import {
  enforceDocumentLimit,
  enforceSyncLimit,
  protectInboundQueue,
  protectSlowEditingSession,
} from "./resource-limits.js";
import {
  InMemoryRoomLifecycle,
  RedisRoomLifecycle,
  type RoomLifecycle,
} from "./room-lifecycle.js";
import { CoreAPIStorage, type DocumentScope, type StoredDocumentState } from "./storage.js";

const presenceColors = ["#2563eb", "#7c3aed", "#c026d3", "#db2777", "#ea580c", "#0d9488"] as const;

export function createCollaborationServer(
  config: Partial<CollaborationConfig> & { roomLifecycle?: RoomLifecycle } = {},
): Server<DocumentTicketClaims> {
  const dependencyTimeout = config.dependencyTimeout ?? 2_000;
  const roomLifecycle = config.roomLifecycle ?? (config.redisURL === undefined
    ? new InMemoryRoomLifecycle()
    : new RedisRoomLifecycle(config.redisURL, dependencyTimeout));
  const maxDocumentBytes = config.maxDocumentBytes ?? 6 * 1024 * 1024;
  const storage = config.coreAPIURL === undefined && config.collaborationServiceSecret === undefined
    ? undefined
    : new CoreAPIStorage({
        baseURL: config.coreAPIURL ?? "http://127.0.0.1:8080",
        maxDocumentBytes,
        maxResponseBytes: config.maxPersistenceResponseBytes ?? 16 * 1024 * 1024,
        requestTimeout: dependencyTimeout,
        serviceSecret: config.collaborationServiceSecret ?? defaultCollaborationServiceSecret,
      });
  const observability = new CollaborationObservability();
  const healthDependencies: HealthDependency[] = [
    { health: () => roomLifecycle.health(), name: "room_lifecycle" },
    ...(storage === undefined ? [] : [{ health: () => storage.health(), name: "core_api" }]),
  ];
  const refreshHealth = async () => {
    const failed = await failedDependencies(healthDependencies, dependencyTimeout);
    observability.healthResult(failed.length === 0);
    return failed;
  };
  const maxBackpressureBytes = config.maxBackpressureBytes ?? 8 * 1024 * 1024;
  const server = new Server<DocumentTicketClaims>({
    address: config.address ?? "127.0.0.1",
    name: "collaboration-server",
    port: config.port ?? 8082,
    timeout: config.authenticationTimeout ?? 60_000,
    debounce: config.persistenceDebounce ?? 2_000,
    maxDebounce: config.persistenceMaxDebounce ?? 10_000,
    maxPendingDocuments: config.maxPendingDocuments ?? 1,
    maxUnauthenticatedQueueMessages: config.maxUnauthenticatedQueueMessages ?? 64,
    maxUnauthenticatedQueueSize: config.maxUnauthenticatedQueueBytes ?? 256 * 1024,
    websocketOptions: {
      maxBufferedChunks: 64,
      maxFragments: 64,
      maxPayload: config.maxWebSocketMessageBytes ?? 6 * 1024 * 1024,
      perMessageDeflate: false,
    },
    quiet: true,
    stopOnSignals: false,
    async onListen() {
      try {
        await roomLifecycle.start((roomName) => terminateRoom(server, roomName));
      } catch {
        throw new Error("Document Room lifecycle failed to start");
      }
    },
    async onDestroy() {
      await roomLifecycle.destroy();
    },
    async onAuthenticate({ documentName, requestHeaders, requestParameters, token }) {
      try {
        if (await roomLifecycle.isDeleted(documentName)) {
          throw new Error("Invalid Document ticket");
        }
        const room = parseDocumentRoomName(documentName);
        if (
          room.organizationId !== requestParameters.get("org_id") ||
          room.teamId !== requestParameters.get("team_id")
        ) {
          throw new Error("Invalid Document ticket");
        }
        validateOrigin(
          requestHeaders.get("origin"),
          config.allowedOrigins ?? defaultAllowedOrigins,
        );
        return validateDocumentTicket(
          token,
          room,
          config.ticketSecret ?? defaultTicketSecret,
        );
      } catch {
        observability.increment("authenticationFailures");
        throw new Error("Invalid Document ticket");
      }
    },
    async beforeHandleAwareness({ context, socketId, states }) {
      if (context === undefined) {
        return;
      }
      const user = authenticatedPresence(context, socketId);
      for (const state of states.values()) {
        state.user = user;
      }
    },
    async beforeSync({ document, payload, type }) {
      enforceSyncLimit(document, payload, type, maxDocumentBytes);
    },
    async connected({ connection: editingSession, context }) {
      observability.authenticated(context);
      protectInboundQueue(
        editingSession,
        config.maxAuthenticatedQueueBytes ?? 12 * 1024 * 1024,
        config.maxAuthenticatedQueueMessages ?? 64,
      );
      protectSlowEditingSession(editingSession.webSocket, maxBackpressureBytes, () => {
        observability.increment("slowEditingSessions");
      });
    },
    async onLoadDocument({ context }) {
      try {
        return await loadDocumentState(storage, context, maxDocumentBytes);
      } catch {
        observability.increment("loadFailures");
        throw new Error("Document state load failed");
      }
    },
    async onStoreDocument({ document, lastContext }) {
      try {
        if (await roomLifecycle.isDeleted(document.name)) {
          return;
        }
        await storeDocumentState(storage, lastContext, document, maxDocumentBytes);
      } catch {
        observability.increment("storeFailures");
        throw new Error("Document state persistence failed");
      }
    },
    async onDisconnect({ context }) {
      observability.disconnected(context);
    },
    async onRequest({ instance, request, response }) {
      if (request.method === "GET" && request.url === "/health") {
        const failed = await refreshHealth();
        response.writeHead(failed.length === 0 ? 200 : 503, { "Content-Type": "application/json" });
        response.end(JSON.stringify(failed.length === 0
          ? { ok: true, service: "collaboration-server" }
          : {
              dependencies: Object.fromEntries(failed.map((name) => [name, "unavailable"])),
              ok: false,
              service: "collaboration-server",
            }));
        return Promise.reject();
      }
      if (request.method === "GET" && request.url === "/metrics") {
        await refreshHealth();
        response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
        response.end(observability.render(instance));
        return Promise.reject();
      }
      const room = privateRoomFromRequest(request.method, request.url);
      if (room !== undefined) {
        if (!hasServiceAuthentication(
          request.headers.authorization,
          config.collaborationServiceSecret ?? defaultCollaborationServiceSecret,
        )) {
          response.writeHead(401);
          response.end();
          return Promise.reject();
        }
        const roomName = documentRoomName(room);
        try {
          await roomLifecycle.delete(roomName);
        } catch {
          response.writeHead(503, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Document Room lifecycle unavailable" }));
          return Promise.reject();
        }
        response.writeHead(204);
        response.end();
        return Promise.reject();
      }
    },
  });
  return server;
}

async function failedDependencies(
  dependencies: HealthDependency[],
  timeoutMs: number,
): Promise<string[]> {
  const statuses = await Promise.all(dependencies.map(async (dependency) => {
    try {
      return { healthy: await within(timeoutMs, dependency.health()), name: dependency.name };
    } catch {
      return { healthy: false, name: dependency.name };
    }
  }));
  return statuses.filter(({ healthy }) => !healthy).map(({ name }) => name);
}

async function within<T>(timeoutMs: number, operation: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("dependency timed out")), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function authenticatedPresence(claims: DocumentTicketClaims, sessionId: string) {
  return {
    color: presenceColor(claims.userId),
    id: claims.userId,
    name: claims.displayName,
    sessionId,
  };
}

function presenceColor(userId: string): string {
  let hash = 0;
  for (const character of userId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return presenceColors[hash % presenceColors.length]!;
}

function terminateRoom(server: Server<DocumentTicketClaims>, roomName: string): void {
  server.hocuspocus.documents.get(roomName)?.broadcastStateless(
    JSON.stringify({ type: "document.deleted" }),
  );
  server.hocuspocus.closeConnections(roomName);
}

interface DocumentStateStorage {
  load(scope: DocumentScope): Promise<StoredDocumentState>;
  store(
    scope: DocumentScope,
    state: Uint8Array,
    projections: ReturnType<typeof materializeDocument>,
  ): Promise<void>;
}

export async function loadDocumentState(
  storage: DocumentStateStorage | undefined,
  claims: DocumentTicketClaims,
  maxDocumentBytes = Number.MAX_SAFE_INTEGER,
): Promise<Doc | Uint8Array | undefined> {
  if (storage === undefined) {
    return;
  }
  const state = await storage.load(documentScope(claims));
  enforceDocumentLimit(state.canonicalState, maxDocumentBytes);
  if (state.canonicalState.byteLength > 0) {
    return state.canonicalState;
  }
  const initialized = initializeDocument(state.title, state.bodyHTML);
  enforceDocumentLimit(initialized, maxDocumentBytes);
  return initialized;
}

export async function storeDocumentState(
  storage: DocumentStateStorage | undefined,
  claims: DocumentTicketClaims,
  document: Doc,
  maxDocumentBytes = Number.MAX_SAFE_INTEGER,
): Promise<void> {
  if (storage === undefined) {
    return;
  }
  const state = encodeStateAsUpdate(document);
  enforceDocumentLimit(state, maxDocumentBytes);
  await storage.store(
    documentScope(claims),
    state,
    materializeDocument(document),
  );
}

export function documentRoomName(scope: Pick<DocumentScope, "documentId" | "organizationId" | "teamId">): string {
  return `${scope.organizationId}:${scope.teamId}:${scope.documentId}`;
}

function parseDocumentRoomName(name: string): Pick<DocumentScope, "documentId" | "organizationId" | "teamId"> {
  const [organizationId, teamId, documentId, extra] = name.split(":");
  if (organizationId === undefined || teamId === undefined || documentId === undefined || extra !== undefined) {
    throw new Error("Invalid Document ticket");
  }
  return { documentId, organizationId, teamId };
}

function documentScope(claims: DocumentTicketClaims): DocumentScope {
  return {
    documentId: claims.documentId,
    editorId: claims.userId,
    organizationId: claims.organizationId,
    teamId: claims.teamId,
  };
}

function privateRoomFromRequest(method: string | undefined, requestURL: string | undefined) {
  if (method !== "DELETE" || requestURL === undefined) {
    return;
  }
  const match = new URL(requestURL, "http://collaboration.internal").pathname.match(
    /^\/internal\/v1\/orgs\/([^/]+)\/teams\/([^/]+)\/documents\/([^/]+)\/room$/,
  );
  if (match === null) {
    return;
  }
  return { organizationId: match[1]!, teamId: match[2]!, documentId: match[3]! };
}

function hasServiceAuthentication(header: string | undefined, secret: string): boolean {
  if (header === undefined) {
    return false;
  }
  const supplied = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}
