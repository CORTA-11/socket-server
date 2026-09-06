export interface CollaborationConfig {
  address: string;
  port: number;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CollaborationConfig {
  return {
    address: environment.COLLABORATION_HOST ?? "0.0.0.0",
    port: readPort(environment.COLLABORATION_PORT),
  };
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
