import { applyUpdate, Doc } from "yjs";

export interface DocumentScope {
  documentId: string;
  editorId: string;
  organizationId: string;
  teamId: string;
}

export interface DocumentProjections {
  bodyHTML: string;
  title: string;
}

export interface CoreAPIStorageConfig {
  baseURL: string;
  serviceSecret: string;
}

interface DocumentStateResponse {
  canonical_state: string;
}

export class CoreAPIStorage {
  private readonly baseURL: string;
  private readonly serviceSecret: string;

  constructor(config: CoreAPIStorageConfig) {
    const baseURL = new URL(config.baseURL);
    if (!(["http:", "https:"] as string[]).includes(baseURL.protocol) ||
        baseURL.username !== "" || baseURL.password !== "" ||
        baseURL.search !== "" || baseURL.hash !== "") {
      throw new Error("CORE_API_INTERNAL_URL must be an HTTP origin or base URL");
    }
    if (Buffer.byteLength(config.serviceSecret) < 32) {
      throw new Error("COLLABORATION_SERVICE_SECRET must contain at least 32 bytes");
    }
    this.baseURL = baseURL.toString().replace(/\/$/, "");
    this.serviceSecret = config.serviceSecret;
  }

  async load(scope: DocumentScope): Promise<Uint8Array> {
    const response = await this.request(scope, "GET");
    const payload: unknown = await response.json();
    if (!isDocumentStateResponse(payload)) {
      throw new Error("core-api returned an invalid Document state response");
    }
    const state = decodeCanonicalBase64(payload.canonical_state);
    validateYjsState(state);
    return state;
  }

  async store(
    scope: DocumentScope,
    state: Uint8Array,
    projections: DocumentProjections,
  ): Promise<void> {
    validateYjsState(state);
    const response = await this.request(scope, "PUT", {
      body: JSON.stringify({
        body_html: projections.bodyHTML,
        canonical_state: Buffer.from(state).toString("base64"),
        title: projections.title,
      }),
      headers: { "Content-Type": "application/json" },
    });
    await response.body?.cancel();
  }

  private async request(
    scope: DocumentScope,
    method: "GET" | "PUT",
    init: Pick<RequestInit, "body" | "headers"> = {},
  ): Promise<Response> {
    const path = `internal/v1/orgs/${encodeURIComponent(scope.organizationId)}` +
      `/teams/${encodeURIComponent(scope.teamId)}` +
      `/documents/${encodeURIComponent(scope.documentId)}/state`;
    const response = await fetch(`${this.baseURL}/${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${this.serviceSecret}`,
        "X-Synodus-Editor-ID": scope.editorId,
      },
      method,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`core-api Document state request failed with status ${response.status}`);
    }
    return response;
  }
}

function validateYjsState(state: Uint8Array): void {
  if (state.byteLength === 0) {
    return;
  }
  try {
    applyUpdate(new Doc(), state);
  } catch {
    throw new Error("invalid encoded Yjs Document state");
  }
}

function isDocumentStateResponse(value: unknown): value is DocumentStateResponse {
  return value !== null && typeof value === "object" &&
    typeof (value as Record<string, unknown>).canonical_state === "string";
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (value === "") {
    return new Uint8Array();
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("core-api returned an invalid Document state response");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("core-api returned an invalid Document state response");
  }
  return new Uint8Array(decoded);
}
