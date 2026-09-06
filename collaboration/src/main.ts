import { loadConfig } from "./config.js";
import { createCollaborationServer } from "./server.js";

const config = loadConfig();
const server = createCollaborationServer(config);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.destroy().finally(() => process.exit(0));
  });
}

await server.listen();
console.info(
  JSON.stringify({
    address: config.address,
    event: "collaboration_server_listening",
    port: config.port,
    service: "collaboration-server",
  }),
);
