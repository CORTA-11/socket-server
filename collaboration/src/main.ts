import { loadConfig } from "./config.js";
import { InMemoryRoomLifecycle } from "./room-lifecycle.js";
import { createCollaborationServer } from "./server.js";

const config = loadConfig();
const server = createCollaborationServer(process.env.NODE_ENV === "test"
  ? { ...config, roomLifecycle: new InMemoryRoomLifecycle() }
  : config);

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
