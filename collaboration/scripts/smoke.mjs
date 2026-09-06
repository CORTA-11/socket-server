import { HocuspocusProvider } from "@hocuspocus/provider";

const url =
  process.argv[2] ??
  process.env.COLLABORATION_WS_URL ??
  "ws://localhost:10000/ws/docs";

const timeout = setTimeout(() => {
  console.error("Timed out waiting for an authentication response");
  process.exitCode = 1;
  provider.destroy();
}, 5_000);

const provider = new HocuspocusProvider({
  name: "public-route-smoke-test",
  token: "not-a-document-ticket",
  url,
  onAuthenticationFailed: ({ reason }) => {
    clearTimeout(timeout);
    provider.destroy();
    if (reason !== "permission-denied") {
      console.error(`Unexpected authentication response: ${reason}`);
      process.exitCode = 1;
      return;
    }
    console.info("Document collaboration route rejected invalid credentials");
  },
});
