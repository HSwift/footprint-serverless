import { ApiError, badRequest, json } from "./http";
import { projectJson, type ApiEnv, type ProjectRow } from "./types";
import { readBody, text, timestamp } from "./validate";

function projectInput(body: Record<string, unknown>, current?: ProjectRow) {
  const name = text(body.name === undefined ? current?.Name : body.name, "name", 200);
  const startTime = timestamp(body.startTime === undefined ? current?.StartTime : body.startTime, "startTime");
  const endTime = timestamp(body.endTime === undefined ? current?.EndTime : body.endTime, "endTime");
  if (startTime > endTime) badRequest("endTime", "endTime must be at or after startTime");
  return { name, startTime, endTime };
}

export async function createProject(request: Request, env: ApiEnv): Promise<Response> {
  const { name, startTime, endTime } = projectInput(await readBody(request));
  const row = await env.DB.prepare("INSERT INTO Projects (Name, StartTime, EndTime) VALUES (?, ?, ?) RETURNING ID, Name, StartTime, EndTime")
    .bind(name, startTime, endTime).first<ProjectRow>();
  if (!row) throw new Error("Project insert returned no row");
  return json({ project: projectJson(row) }, 201);
}

export async function updateProject(request: Request, env: ApiEnv, value: string): Promise<Response> {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) badRequest("id", "id must be a positive integer");
  const id = Number(value);
  const body = await readBody(request);
  if (!["name", "startTime", "endTime"].some(field => Object.hasOwn(body, field))) badRequest("body", "Provide name, startTime or endTime");
  const current = await env.DB.prepare("SELECT ID, Name, StartTime, EndTime FROM Projects WHERE ID = ?").bind(id).first<ProjectRow>();
  if (!current) throw new ApiError(404, "project_not_found", "Project not found", "id");
  const { name, startTime, endTime } = projectInput(body, current);
  const row = await env.DB.prepare("UPDATE Projects SET Name = ?, StartTime = ?, EndTime = ? WHERE ID = ? RETURNING ID, Name, StartTime, EndTime")
    .bind(name, startTime, endTime, id).first<ProjectRow>();
  if (!row) throw new ApiError(404, "project_not_found", "Project not found", "id");
  return json({ project: projectJson(row) });
}
