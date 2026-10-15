import { ApiError, badRequest } from "./http";
import type { LocationInput } from "./types";

const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/i;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

export function timestamp(value: unknown, field: string, legacy = false): number {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0 || result > MAX_TIMESTAMP) {
      badRequest(field, `${field} must be a valid Unix timestamp in milliseconds`);
    }
    return result;
  }
  if (typeof value !== "string" || !value.trim() || (!legacy && !ISO_DATETIME.test(value))) {
    badRequest(field, `${field} must be milliseconds or an ISO 8601 datetime with a timezone`);
  }
  const parts = value.match(ISO_DATETIME);
  if (parts) {
    const [year, month, day, hour, minute, second, zoneHour = 0, zoneMinute = 0] = parts.slice(1).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) {
      badRequest(field, `${field} must be a valid datetime`);
    }
  }
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_TIMESTAMP) {
    badRequest(field, `${field} must be a valid datetime`);
  }
  return result;
}

function coordinate(value: unknown, field: string, min: number, max: number): number {
  if ((typeof value !== "string" && typeof value !== "number") || (typeof value === "string" && !value.trim())) {
    badRequest(field, `${field} is required and must be a number`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    badRequest(field, `${field} must be between ${min} and ${max}`);
  }
  return result;
}

function timezone(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const hours = coordinate(value, "timezone", -12, 14);
  const minutes = hours * 60, rounded = Math.round(minutes);
  if (Math.abs(minutes - rounded) > 1e-7) badRequest("timezone", "timezone must be a UTC hour offset with whole-minute precision");
  return rounded / 60;
}

export function text(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    badRequest(field, `${field} must be a nonempty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/x-www-form-urlencoded" && contentType !== "multipart/form-data") {
    throw new ApiError(415, "unsupported_media_type", "Use JSON or form data");
  }
  try {
    if (contentType === "application/json") {
      const value: unknown = await request.json();
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        badRequest("body", "body must be a JSON object");
      }
      return value as Record<string, unknown>;
    }
    return Object.fromEntries(await request.formData());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    badRequest("body", "Malformed request body");
  }
}

export async function locationInput(request: Request, legacy: boolean): Promise<LocationInput> {
  const body = await readBody(request);
  const city = body.city ?? "";
  if (typeof city !== "string" || city.length > 200) badRequest("city", "city must be a string of at most 200 characters");
  return {
    longitude: coordinate(body.longitude ?? body.lng, "longitude", -180, 180),
    latitude: coordinate(body.latitude ?? body.lat, "latitude", -90, 90),
    timestamp: timestamp(body.timestamp ?? body.datetime, "timestamp", legacy),
    timezone: timezone(body.timezone),
    device: text(body.device, "device", 200),
    city: city.trim(),
  };
}

export function integerParam(url: URL, field: string, fallback: number, min: number, max: number): number {
  const value = url.searchParams.get(field);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) badRequest(field, `${field} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    badRequest(field, `${field} must be between ${min} and ${max}`);
  }
  return result;
}
