import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";

test("collaboration resource bounds have explicit production defaults", () => {
  const config = loadConfig({});

  assert.deepEqual({
    authenticationTimeout: config.authenticationTimeout,
    dependencyTimeout: config.dependencyTimeout,
    maxAuthenticatedQueueBytes: config.maxAuthenticatedQueueBytes,
    maxAuthenticatedQueueMessages: config.maxAuthenticatedQueueMessages,
    maxBackpressureBytes: config.maxBackpressureBytes,
    maxDocumentBytes: config.maxDocumentBytes,
    maxPendingDocuments: config.maxPendingDocuments,
    maxPersistenceResponseBytes: config.maxPersistenceResponseBytes,
    maxUnauthenticatedQueueBytes: config.maxUnauthenticatedQueueBytes,
    maxUnauthenticatedQueueMessages: config.maxUnauthenticatedQueueMessages,
    maxWebSocketMessageBytes: config.maxWebSocketMessageBytes,
    persistenceDebounce: config.persistenceDebounce,
    persistenceMaxDebounce: config.persistenceMaxDebounce,
  }, {
    authenticationTimeout: 60_000,
    dependencyTimeout: 2_000,
    maxAuthenticatedQueueBytes: 12 * 1024 * 1024,
    maxAuthenticatedQueueMessages: 64,
    maxBackpressureBytes: 8 * 1024 * 1024,
    maxDocumentBytes: 6 * 1024 * 1024,
    maxPendingDocuments: 1,
    maxPersistenceResponseBytes: 16 * 1024 * 1024,
    maxUnauthenticatedQueueBytes: 256 * 1024,
    maxUnauthenticatedQueueMessages: 64,
    maxWebSocketMessageBytes: 6 * 1024 * 1024,
    persistenceDebounce: 2_000,
    persistenceMaxDebounce: 10_000,
  });
});

test("collaboration resource bounds reject invalid environment values", () => {
  assert.throws(
    () => loadConfig({ COLLABORATION_MAX_DOCUMENT_BYTES: "0" }),
    /COLLABORATION_MAX_DOCUMENT_BYTES must be a positive integer/,
  );
  assert.throws(
    () => loadConfig({
      COLLABORATION_MAX_DOCUMENT_BYTES: "7000000",
      COLLABORATION_MAX_WEBSOCKET_MESSAGE_BYTES: "6000000",
    }),
    /COLLABORATION_MAX_WEBSOCKET_MESSAGE_BYTES must be at least COLLABORATION_MAX_DOCUMENT_BYTES/,
  );
});
