import { ApiError } from "./http";
import type { ApiEnv } from "./types";

function secureEqual(actual: string, expected: string): boolean {
  const a = new TextEncoder().encode(actual);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

// Access belongs to Console. The API never treats an Access header as a token.
export function authenticate(request: Request, env: ApiEnv, legacy = false): void {
  if (!env.INGEST_TOKEN) {
    throw new ApiError(503, "auth_not_configured", "INGEST_TOKEN secret is not set");
  }
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer (\S+)$/i)?.[1];
  // Preserve existing devices on legacy paths; an invalid Authorization header
  // never falls back to another credential.
  const token = authorization === null && legacy ? request.headers.get("token") : bearer;
  if (!token || !secureEqual(token, env.INGEST_TOKEN)) {
    throw new ApiError(401, "unauthorized", "A valid bearer token is required");
  }
}
