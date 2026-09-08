export interface CollaborationConfig {
  address: string;
  allowedOrigins: string[];
  authenticationTimeout: number;
  collaborationServiceSecret: string;
  coreAPIURL: string;
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
  return {
    address: environment.COLLABORATION_HOST ?? "0.0.0.0",
    allowedOrigins: readOrigins(environment.SOCKET_ALLOWED_ORIGINS),
    authenticationTimeout: 60_000,
    collaborationServiceSecret: environment.COLLABORATION_SERVICE_SECRET ?? defaultCollaborationServiceSecret,
    coreAPIURL: environment.CORE_API_INTERNAL_URL ?? "http://127.0.0.1:8080",
    port: readPort(environment.COLLABORATION_PORT),
    redisURL: environment.REDIS_URL ?? "redis://127.0.0.1:6379/0",
    ticketSecret: environment.JWT_SECRET ?? defaultTicketSecret,
  };
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
