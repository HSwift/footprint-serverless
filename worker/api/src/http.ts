export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string, public headers: HeadersInit = {}) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

export function errorResponse(error: ApiError): Response {
  const headers = new Headers(error.headers);
  if (error.status === 401) headers.set("www-authenticate", 'Bearer realm="footprint-api"');
  return json({ error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } }, error.status, headers);
}

export function badRequest(field: string, message: string): never {
  throw new ApiError(400, "bad_request", message, field);
}

export function requireMethod(request: Request, allowed: string[]): void {
  if (!allowed.includes(request.method)) {
    throw new ApiError(405, "method_not_allowed", `Allowed methods: ${allowed.join(", ")}`, undefined, { allow: allowed.join(", ") });
  }
}
