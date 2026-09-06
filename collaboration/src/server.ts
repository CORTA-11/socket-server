import { Server } from "@hocuspocus/server";

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
    async onAuthenticate() {
      throw new Error("Document ticket validation is not available yet");
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
