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
  const roomLifecycle = config.roomLifecycle ?? (config.redisURL === undefined
    ? new InMemoryRoomLifecycle()
    : new RedisRoomLifecycle(config.redisURL));
  const storage = config.coreAPIURL === undefined && config.collaborationServiceSecret === undefined
    ? undefined
    : new CoreAPIStorage({
        baseURL: config.coreAPIURL ?? "http://127.0.0.1:8080",
        serviceSecret: config.collaborationServiceSecret ?? defaultCollaborationServiceSecret,
      });
  const server = new Server<DocumentTicketClaims>({
    address: config.address ?? "127.0.0.1",
    name: "collaboration-server",
    port: config.port ?? 8082,
    timeout: config.authenticationTimeout ?? 60_000,
    quiet: true,
    stopOnSignals: false,
    async onListen() {
      await roomLifecycle.start((roomName) => terminateRoom(server, roomName));
    },
    async onDestroy() {
      await roomLifecycle.destroy();
    },
    async onAuthenticate({ documentName, requestHeaders, requestParameters, token }) {
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
    async onLoadDocument({ context }) {
      return loadDocumentState(storage, context);
    },
    async onStoreDocument({ document, lastContext }) {
      if (await roomLifecycle.isDeleted(document.name)) {
        return;
      }
      await storeDocumentState(storage, lastContext, document);
    },
    async onRequest({ request, response }) {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ ok: true, service: "collaboration-server" }),
        );
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
        await roomLifecycle.delete(roomName);
        response.writeHead(204);
        response.end();
        return Promise.reject();
      }
    },
  });
  return server;
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
): Promise<Doc | Uint8Array | undefined> {
  if (storage === undefined) {
    return;
  }
  const state = await storage.load(documentScope(claims));
  return state.canonicalState.byteLength === 0
    ? initializeDocument(state.title, state.bodyHTML)
    : state.canonicalState;
}

export async function storeDocumentState(
  storage: DocumentStateStorage | undefined,
  claims: DocumentTicketClaims,
  document: Doc,
): Promise<void> {
  if (storage === undefined) {
    return;
  }
  await storage.store(
    documentScope(claims),
    encodeStateAsUpdate(document),
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
