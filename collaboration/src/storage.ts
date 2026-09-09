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
  maxDocumentBytes?: number;
  maxResponseBytes?: number;
  requestTimeout?: number;
  serviceSecret: string;
}

interface DocumentStateResponse {
  body_html: string;
  canonical_state: string;
  title: string;
}

export interface StoredDocumentState {
  bodyHTML: string;
  canonicalState: Uint8Array;
  title: string;
}

export class CoreAPIStorage {
  private readonly baseURL: string;
  private readonly maxDocumentBytes: number;
  private readonly maxResponseBytes: number;
  private readonly requestTimeout: number;
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
    this.maxDocumentBytes = config.maxDocumentBytes ?? 6 * 1024 * 1024;
    this.maxResponseBytes = config.maxResponseBytes ?? 16 * 1024 * 1024;
    this.requestTimeout = config.requestTimeout ?? 2_000;
    this.serviceSecret = config.serviceSecret;
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseURL}/health/ready`, {
        signal: AbortSignal.timeout(this.requestTimeout),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  async load(scope: DocumentScope): Promise<StoredDocumentState> {
    const response = await this.request(scope, "GET");
    const payload = await readBoundedJSON(response, this.maxResponseBytes);
    if (!isDocumentStateResponse(payload)) {
      throw new Error("core-api returned an invalid Document state response");
    }
    validateProjectionSize(payload.title, payload.body_html, this.maxDocumentBytes);
    const canonicalState = decodeCanonicalBase64(payload.canonical_state, this.maxDocumentBytes);
    validateYjsState(canonicalState);
    return {
      bodyHTML: payload.body_html,
      canonicalState,
      title: payload.title,
    };
  }

  async store(
    scope: DocumentScope,
    state: Uint8Array,
    projections: DocumentProjections,
  ): Promise<void> {
    validateYjsState(state);
    if (state.byteLength > this.maxDocumentBytes) {
      throw new Error("Document resource limit exceeded");
    }
    validateProjectionSize(projections.title, projections.bodyHTML, this.maxDocumentBytes);
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
      signal: AbortSignal.timeout(this.requestTimeout),
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
    typeof (value as Record<string, unknown>).body_html === "string" &&
    typeof (value as Record<string, unknown>).canonical_state === "string" &&
    typeof (value as Record<string, unknown>).title === "string";
}

function decodeCanonicalBase64(value: string, maxBytes: number): Uint8Array {
  if (value === "") {
    return new Uint8Array();
  }
  if (value.length > Math.ceil(maxBytes / 3) * 4) {
    throw new Error("Document resource limit exceeded");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("core-api returned an invalid Document state response");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maxBytes) {
    throw new Error("Document resource limit exceeded");
  }
  if (decoded.toString("base64") !== value) {
    throw new Error("core-api returned an invalid Document state response");
  }
  return new Uint8Array(decoded);
}

function validateProjectionSize(title: string, bodyHTML: string, maxBytes: number): void {
  if (Buffer.byteLength(title) > maxBytes || Buffer.byteLength(bodyHTML) > maxBytes) {
    throw new Error("Document resource limit exceeded");
  }
}

async function readBoundedJSON(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("core-api Document state response exceeded the resource limit");
  }
  if (response.body === null) {
    throw new Error("core-api returned an invalid Document state response");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      throw new Error("core-api Document state response exceeded the resource limit");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("core-api returned an invalid Document state response");
  }
}
