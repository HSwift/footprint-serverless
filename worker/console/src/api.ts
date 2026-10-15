import type { ConsoleConfig, LocationPoint, Project } from "./model";
import type { ProjectInput } from "./project";

async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: "no-store", credentials: "same-origin" });
  if (!response.ok) {
    if (response.status === 401) throw new Error("本地 API 鉴权未配置，请设置开发服务器的 INGEST_TOKEN。");
    throw new Error(`数据加载失败（${response.status}），请确认本地 API 已启动。`);
  }
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("API 返回了非 JSON 响应。");
  return response.json() as Promise<T>;
}
export const getConfig = (signal: AbortSignal) => get<ConsoleConfig>("/api/console-config", signal);
export async function saveProject(input: ProjectInput, id?: number): Promise<Project> {
  const response = await fetch(id === undefined ? "/api/projects" : `/api/projects/${id}`, {
    method: id === undefined ? "POST" : "PATCH", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("项目保存失败：API 返回了非 JSON 响应。");
  const result = await response.json() as { project?: Project; error?: { code?: string; field?: string } };
  if (!response.ok) {
    if (response.status === 401) throw new Error("本地 API 鉴权未配置，请设置开发服务器的 INGEST_TOKEN。");
    if (response.status === 404) throw new Error("项目已不存在，请刷新数据后重试。");
    if (response.status === 400) throw new Error(result.error?.field === "name" ? "请检查项目名称。" : "请检查项目的起止时间。");
    throw new Error(`项目保存失败（${response.status}），请稍后重试。`);
  }
  const project = result.project;
  if (!project || !Number.isSafeInteger(project.id) || typeof project.name !== "string"
    || !Number.isSafeInteger(project.startTime) || !Number.isSafeInteger(project.endTime)) throw new Error("API 返回的项目数据格式不正确。");
  return project;
}
export async function loadData(signal: AbortSignal, progress: (count: number) => void) {
  const locations: LocationPoint[] = [], projects: Project[] = [];
  let offset = 0, hasMore = true;
  while (hasMore) {
    const page = await get<{ locations: LocationPoint[]; pagination: { hasMore: boolean } }>(`/api/locations?view=raw&order=asc&limit=5000&offset=${offset}`, signal);
    if (!Array.isArray(page.locations) || !page.pagination) throw new Error("位置数据格式不正确。");
    locations.push(...page.locations); offset += page.locations.length;
    progress(locations.length); hasMore = page.pagination.hasMore;
    if (hasMore && !page.locations.length) throw new Error("位置分页数据不完整，无法继续加载。");
    if (hasMore && locations.length >= 100_000) throw new Error("当前预览最多加载 100,000 个位置点，数据量已超出范围。");
  }
  offset = 0; hasMore = true;
  while (hasMore) {
    const page = await get<{ projects: Project[]; pagination: { hasMore: boolean } }>(`/api/projects?limit=500&offset=${offset}`, signal);
    if (!Array.isArray(page.projects) || !page.pagination) throw new Error("项目数据格式不正确。");
    projects.push(...page.projects); offset += page.projects.length; hasMore = page.pagination.hasMore;
    if (hasMore && !page.projects.length) throw new Error("项目分页数据不完整，无法继续加载。");
    if (hasMore && projects.length >= 10_000) throw new Error("项目数据量超出当前预览范围。");
  }
  return { locations, projects };
}
