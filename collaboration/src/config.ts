export interface CollaborationConfig {
  address: string;
  allowedOrigins: string[];
  authenticationTimeout: number;
  collaborationServiceSecret: string;
  coreAPIURL: string;
  dependencyTimeout: number;
  maxAuthenticatedQueueBytes: number;
  maxAuthenticatedQueueMessages: number;
  maxBackpressureBytes: number;
  maxDocumentBytes: number;
  maxPendingDocuments: number;
  maxPersistenceResponseBytes: number;
  maxUnauthenticatedQueueBytes: number;
  maxUnauthenticatedQueueMessages: number;
  maxWebSocketMessageBytes: number;
  persistenceDebounce: number;
  persistenceMaxDebounce: number;
  port: number;
  redisURL: string;
  ticketSecret: string;
}

export const defaultAllowedOrigins = [
  "http://localhost:10000",
  "http://127.0.0.1:10000",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
export const defaultTicketSecret = "development-socket-ticket-secret-change-me";
export const defaultCollaborationServiceSecret = "development-collaboration-service-secret-change-me";

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CollaborationConfig {
  const maxDocumentBytes = readPositiveInteger(
    environment.COLLABORATION_MAX_DOCUMENT_BYTES,
    "COLLABORATION_MAX_DOCUMENT_BYTES",
    6 * 1024 * 1024,
  );
  const maxWebSocketMessageBytes = readPositiveInteger(
    environment.COLLABORATION_MAX_WEBSOCKET_MESSAGE_BYTES,
    "COLLABORATION_MAX_WEBSOCKET_MESSAGE_BYTES",
    6 * 1024 * 1024,
  );
  if (maxWebSocketMessageBytes < maxDocumentBytes) {
    throw new Error("COLLABORATION_MAX_WEBSOCKET_MESSAGE_BYTES must be at least COLLABORATION_MAX_DOCUMENT_BYTES");
  }
  const config = {
    address: environment.COLLABORATION_HOST ?? "0.0.0.0",
    allowedOrigins: readOrigins(environment.SOCKET_ALLOWED_ORIGINS),
    authenticationTimeout: readPositiveInteger(environment.COLLABORATION_AUTHENTICATION_TIMEOUT_MS, "COLLABORATION_AUTHENTICATION_TIMEOUT_MS", 60_000),
    collaborationServiceSecret: environment.COLLABORATION_SERVICE_SECRET ?? defaultCollaborationServiceSecret,
    coreAPIURL: environment.CORE_API_INTERNAL_URL ?? "http://127.0.0.1:8080",
    dependencyTimeout: readPositiveInteger(environment.COLLABORATION_DEPENDENCY_TIMEOUT_MS, "COLLABORATION_DEPENDENCY_TIMEOUT_MS", 2_000),
    maxAuthenticatedQueueBytes: readPositiveInteger(environment.COLLABORATION_MAX_AUTHENTICATED_QUEUE_BYTES, "COLLABORATION_MAX_AUTHENTICATED_QUEUE_BYTES", 12 * 1024 * 1024),
    maxAuthenticatedQueueMessages: readPositiveInteger(environment.COLLABORATION_MAX_AUTHENTICATED_QUEUE_MESSAGES, "COLLABORATION_MAX_AUTHENTICATED_QUEUE_MESSAGES", 64),
    maxBackpressureBytes: readPositiveInteger(environment.COLLABORATION_MAX_BACKPRESSURE_BYTES, "COLLABORATION_MAX_BACKPRESSURE_BYTES", 8 * 1024 * 1024),
    maxDocumentBytes,
    maxPendingDocuments: readPositiveInteger(environment.COLLABORATION_MAX_PENDING_DOCUMENTS, "COLLABORATION_MAX_PENDING_DOCUMENTS", 1),
    maxPersistenceResponseBytes: readPositiveInteger(environment.COLLABORATION_MAX_PERSISTENCE_RESPONSE_BYTES, "COLLABORATION_MAX_PERSISTENCE_RESPONSE_BYTES", 16 * 1024 * 1024),
    maxUnauthenticatedQueueBytes: readPositiveInteger(environment.COLLABORATION_MAX_UNAUTHENTICATED_QUEUE_BYTES, "COLLABORATION_MAX_UNAUTHENTICATED_QUEUE_BYTES", 256 * 1024),
    maxUnauthenticatedQueueMessages: readPositiveInteger(environment.COLLABORATION_MAX_UNAUTHENTICATED_QUEUE_MESSAGES, "COLLABORATION_MAX_UNAUTHENTICATED_QUEUE_MESSAGES", 64),
    maxWebSocketMessageBytes,
    persistenceDebounce: readPositiveInteger(environment.COLLABORATION_PERSISTENCE_DEBOUNCE_MS, "COLLABORATION_PERSISTENCE_DEBOUNCE_MS", 2_000),
    persistenceMaxDebounce: readPositiveInteger(environment.COLLABORATION_PERSISTENCE_MAX_DEBOUNCE_MS, "COLLABORATION_PERSISTENCE_MAX_DEBOUNCE_MS", 10_000),
    port: readPort(environment.COLLABORATION_PORT),
    redisURL: environment.REDIS_URL ?? "redis://127.0.0.1:6379/0",
    ticketSecret: environment.JWT_SECRET ?? defaultTicketSecret,
  };
  const minimumStateResponseBytes = Math.ceil(maxDocumentBytes / 3) * 4;
  if (config.maxPersistenceResponseBytes < minimumStateResponseBytes) {
    throw new Error("COLLABORATION_MAX_PERSISTENCE_RESPONSE_BYTES must hold a base64-encoded maximum Document");
  }
  if (config.persistenceMaxDebounce < config.persistenceDebounce) {
    throw new Error("COLLABORATION_PERSISTENCE_MAX_DEBOUNCE_MS must be at least COLLABORATION_PERSISTENCE_DEBOUNCE_MS");
  }
  return config;
}

function readOrigins(value: string | undefined): string[] {
  if (value === undefined) {
    return [...defaultAllowedOrigins];
  }
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) {
    throw new Error("SOCKET_ALLOWED_ORIGINS must contain at least one origin");
  }
  return origins;
}

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return 8082;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("COLLABORATION_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function readPositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
