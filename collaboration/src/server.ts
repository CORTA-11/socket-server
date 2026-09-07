import { Server } from "@hocuspocus/server";
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
import { CoreAPIStorage, type DocumentScope, type StoredDocumentState } from "./storage.js";

export function createCollaborationServer(
  config: Partial<CollaborationConfig> = {},
): Server<DocumentTicketClaims> {
  const storage = config.coreAPIURL === undefined && config.collaborationServiceSecret === undefined
    ? undefined
    : new CoreAPIStorage({
        baseURL: config.coreAPIURL ?? "http://127.0.0.1:8080",
        serviceSecret: config.collaborationServiceSecret ?? defaultCollaborationServiceSecret,
      });
  return new Server<DocumentTicketClaims>({
    address: config.address ?? "127.0.0.1",
    name: "collaboration-server",
    port: config.port ?? 8082,
    timeout: config.authenticationTimeout ?? 60_000,
    quiet: true,
    stopOnSignals: false,
    async onAuthenticate({ documentName, requestHeaders, requestParameters, token }) {
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
    async onLoadDocument({ context }) {
      return loadDocumentState(storage, context);
    },
    async onStoreDocument({ document, lastContext }) {
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
    },
  });
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
