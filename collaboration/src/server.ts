import { Server } from "@hocuspocus/server";

import { validateDocumentTicket, validateOrigin } from "./auth.js";
import {
  defaultAllowedOrigins,
  defaultTicketSecret,
  type CollaborationConfig,
} from "./config.js";

export function createCollaborationServer(
  config: Partial<CollaborationConfig> = {},
): Server {
  return new Server({
    address: config.address ?? "127.0.0.1",
    name: "collaboration-server",
    port: config.port ?? 8082,
    timeout: config.authenticationTimeout ?? 60_000,
    quiet: true,
    stopOnSignals: false,
    async onAuthenticate({ documentName, requestHeaders, requestParameters, token }) {
      validateOrigin(
        requestHeaders.get("origin"),
        config.allowedOrigins ?? defaultAllowedOrigins,
      );
      return validateDocumentTicket(
        token,
        {
          documentId: documentName,
          organizationId: requestParameters.get("org_id"),
          teamId: requestParameters.get("team_id"),
        },
        config.ticketSecret ?? defaultTicketSecret,
      );
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
