import { createHmac, timingSafeEqual } from "node:crypto";

export interface DocumentTicketClaims {
  documentId: string;
  expiresAt: number;
  organizationId: string;
  teamId: string;
  userId: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateDocumentTicket(
  token: string,
  documentName: string,
  secret: string,
  now: Date = new Date(),
): DocumentTicketClaims {
  if (Buffer.byteLength(secret) < 32) {
    throw new Error("Document ticket validation is not configured");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid Document ticket");
  }
  const encodedHeader = parts[0]!;
  const encodedPayload = parts[1]!;
  const encodedSignature = parts[2]!;
  const signature = Buffer.from(encodedSignature, "base64url");
  const expected = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    throw new Error("Invalid Document ticket");
  }

  const header = parseRecord(encodedHeader);
  const payload = parseRecord(encodedPayload);
  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw new Error("Invalid Document ticket");
  }
  const claims = readClaims(payload);
  if (claims.documentId !== documentName || claims.expiresAt <= Math.floor(now.getTime() / 1_000)) {
    throw new Error("Invalid Document ticket");
  }
  return claims;
}

function parseRecord(encoded: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Authentication failures deliberately share one public error.
  }
  throw new Error("Invalid Document ticket");
}

function readClaims(payload: Record<string, unknown>): DocumentTicketClaims {
  const { document_id, exp, org_id, purpose, team_id, user_id } = payload;
  if (
    purpose !== "document" ||
    !validUUID(document_id) ||
    !validUUID(org_id) ||
    !validUUID(team_id) ||
    !validUUID(user_id) ||
    !Number.isSafeInteger(exp)
  ) {
    throw new Error("Invalid Document ticket");
  }
  return {
    documentId: document_id,
    expiresAt: exp as number,
    organizationId: org_id,
    teamId: team_id,
    userId: user_id,
  };
}

function validUUID(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}
