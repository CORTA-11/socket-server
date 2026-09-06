import { Server } from "@hocuspocus/server";

import { validateDocumentTicket } from "./auth.js";
import type { CollaborationConfig } from "./config.js";

export function createCollaborationServer(
  config: Partial<CollaborationConfig> = {},
): Server {
  return new Server({
    address: config.address ?? "127.0.0.1",
    name: "collaboration-server",
    port: config.port ?? 8082,
    quiet: true,
    stopOnSignals: false,
    async onAuthenticate({ documentName, token }) {
      return validateDocumentTicket(
        token,
        documentName,
        config.ticketSecret ?? "development-socket-ticket-secret-change-me",
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
