export interface ApiEnv {
  DB: D1Database;
  INGEST_TOKEN?: string;
}

export interface LocationRow {
  ID: number;
  Longitude: number;
  Latitude: number;
  City: string | null;
  Device: string | null;
  Date: number;
  Timezone?: number | null;
}

export interface ProjectRow {
  ID: number;
  Name: string;
  StartTime: number;
  EndTime: number;
}

export interface LocationInput {
  longitude: number;
  latitude: number;
  city: string;
  device: string;
  timestamp: number;
  timezone: number | null;
}

export function locationJson(row: LocationRow) {
  return {
    id: row.ID,
    longitude: row.Longitude,
    latitude: row.Latitude,
    city: row.City,
    device: row.Device,
    timestamp: row.Date,
    timezone: row.Timezone ?? null,
  };
}

export function projectJson(row: ProjectRow) {
  return { id: row.ID, name: row.Name, startTime: row.StartTime, endTime: row.EndTime };
}
