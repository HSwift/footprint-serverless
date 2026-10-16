# API 参考


除不包含位置数据的 `GET /health` 外，全部接口要求 `Authorization: Bearer <INGEST_TOKEN>`。未配置密钥返回 `503`，缺失或错误凭据返回 `401`。控制台经服务端代理调用 API，浏览器不持有 API Token。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 服务存活检查，不查询数据库 |
| GET | `/api/me` | 校验 Token |
| PUT | `/api/location` | 上报单个位置 |
| GET | `/api/location` | 查询观测时间最新的位置 |
| GET | `/api/locations` | 分页查询轨迹 |
| GET | `/api/projects` | 分页列出已有项目 |
| POST | `/api/projects` | 新增项目时间窗口 |
| GET | `/api/projects/:name` | 按名称查询项目时间窗口；名称使用 URL 编码 |
| PATCH | `/api/projects/:id` | 按 ID 修改项目名称或时间窗口 |

## 位置上报

支持 JSON、URL-encoded 表单和 multipart 表单：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `longitude` / `lng` | 数字 | 必填，范围 -180 到 180 |
| `latitude` / `lat` | 数字 | 必填，范围 -90 到 90 |
| `timestamp` / `datetime` | 数字或字符串 | 必填，非负 Unix 毫秒时间戳，或带时区的 ISO 日期时间 |
| `timezone` | 数字 | 可选，观测时刻的 UTC 偏移，单位小时，范围 -12 到 14，精确到整分钟；如 `8`、`-5`、`5.5`、`5.75`。省略或 `null` 保存为空 |
| `device` | 字符串 | 必填，最长 200 字符 |
| `city` | 字符串 | 可选，最长 200 字符，默认空字符串 |

坐标沿用旧项目的 WGS84 约定，不进行 GCJ02 转换。时间入库为毫秒时间戳。每次上报新增一条记录，与旧版一致；重试上报不会自动去重。

`timezone` 正值表示 UTC 以东，`0` 表示 UTC，允许小数表示半小时或四十五分钟等偏移。JavaScript 客户端可用 `-new Date(timestamp).getTimezoneOffset() / 60` 计算设备在观测时刻的偏移；补报历史记录时应保留当时采集的值，避免使用补报时的时区。API 直接保存该字段，不按坐标查询或增加 D1 请求，也不会从 ISO 时间字符串自动推断。当地显示使用原始时间戳加已保存偏移，不再转换一次夏令时。

成功返回 `201`：

```json
{
  "location": {
    "id": 1,
    "longitude": 0,
    "latitude": 0,
    "city": "示例地点",
    "device": "example-device",
    "timestamp": 1704067200000,
    "timezone": 0,
    "quality": {
      "status": "pending",
      "reason": "awaiting_context",
      "version": "excursion-v3-experimental",
      "checkedAt": 1704067200000,
      "evidence": {}
    }
  },
  "analysis": { "state": "updated", "windowPoints": 1, "updatedPoints": 0 }
}
```

每次录入会保存原始位置，再同步检测该设备在观测时间附近的有限窗口。最新位置通常先标为 `pending`，后续观测到达后更新之前位置的质量标记；特别大的单侧跳变先标为 `uncertain`。通常需要返回路径与再一个后续点，才能获得两侧证据，连续错误定位可能需要等更久。

常规录入执行 5 条 SQL、3 次 D1 调用；新增历史位置查询每次分析最多 2 条，无重试时总计最多 7 条 SQL。计算仍在 Worker 内逐次进行，质量标记只在状态、原因、版本或证据变化时写回。同一候选的已完成历史证据可复用，补报和候选段变化会重新检查。`analysis.updatedPoints` 表示实际写回的变化数量，不含初始 `pending`；为零也可以表示检查已完成。预算、计费边界与局部限制见 [D1 请求与读写预算](trajectory-outliers.md#d1-请求与读写预算)。

质量标记独立保存在 `LocationQuality`，不修改原始坐标。`quality.status` 可为 `pending`（等待上下文）、`retained`（当前窗口未发现偏离）、`outlier`（高置信候选）、`review`（待复核候选）、`uncertain`（证据不足）或 `unassessed`（尚未分析的旧记录）。标记会随新观测或补报重新计算，不代表人工确认的真值。`checkedAt` 是最近一次保存该标记时的服务端检查时间；不变化时不会为刷新时间额外写入。`timestamp` 是设备观测时间。

检测失败或连续两次遇到并发版本变化时，已成功入库的请求仍返回成功，`analysis.state` 为 `deferred`，不会因为分析失败要求设备重复录入。该窗口暂未完成标注，后续邻近上报可以重新分析；此版本没有独立重试队列。数据库写入失败则返回错误，原始位置与初始质量标记通过同一个事务保存。

## 位置查询

`/api/location` 和 `/api/locations` 都支持以下筛选，多个条件取交集：

| 参数 | 说明 |
| --- | --- |
| `device` | 精确匹配设备名称 |
| `since` / `until` | 毫秒时间戳或带时区的 ISO 日期时间，包含两端 |
| `project` | 精确匹配 `Projects.Name`，按项目起止时间查询 |
| `view` | `raw`（默认）保留全部记录；`filtered` 只排除已标记为 `outlier` 的高置信候选 |

`/api/location` 返回 `{ "location": ... }`，无数据时为 `null`。每条位置包含 `quality` 标记。按 `Date DESC, ID DESC` 选取最新位置，补报历史位置不会改变最新位置。指定 `view=filtered` 时，从过滤后的记录中选择最新位置。

`/api/locations` 另支持 `limit`（默认 500，最大 5000）、`offset`（默认 0）和 `order`（默认 `asc`，可选 `desc`）。相同时间按 ID 排序。响应示例：

```json
{
  "locations": [],
  "pagination": { "limit": 500, "offset": 0, "hasMore": false }
}
```

加载下一页时增加 `offset`，直到 `hasMore` 为 `false`。最新位置和轨迹响应不缓存。

过滤发生在分页之前。`pending`、`review`、`uncertain` 和 `unassessed` 都保留，避免把未经充分支持的候选当成确定错点。旧数据迁移后不会自动全量标注，只在邻近新上报／补报触发的窗口内逐步分析。查询过滤轨迹：

```bash
curl 'http://localhost:8787/api/locations?device=phone&view=filtered' \
  -H "Authorization: Bearer $FOOTPRINT_TOKEN"
```

## 项目读写

项目沿用旧版的时间窗口模型，位置记录没有项目外键。项目列表返回 `{ "projects": [...], "pagination": ... }`，支持 `limit`（默认 100，最大 500）和 `offset`，按起始时间倒序排列。

按名称查询返回 `{ "project": { "id": 1, "name": "trip", "startTime": 1000, "endTime": 3000 } }`。项目时间与位置时间使用相同的毫秒单位。不存在的项目返回 `404`。旧表允许重复名称，按名称查询时使用 ID 最小的一条，不对历史数据强加唯一约束。

`POST /api/projects` 接收 `name`、`startTime`、`endTime`，成功返回 `201` 和 `{ "project": ... }`。名称去掉首尾空白后不能为空，最多 200 字符；时间支持毫秒时间戳或带时区的 ISO 8601 字符串，结束不得早于开始，允许起止时间相同、项目重叠及重复名称。

`PATCH /api/projects/:id` 接收上述字段的全部或部分，至少提供一个字段，成功返回 `200` 和保存后的项目。路径 ID 必须是正整数，项目不存在返回 `404`。编辑按 ID 定位，避免同名项目互相影响；原有 `GET /api/projects/:name` 仍按名称查找，包括纯数字名称。项目读写均要求 Bearer Token，不修改位置记录，也不重新运行偏离点检测。

## 错误响应

```json
{ "error": { "code": "bad_request", "message": "latitude must be between -90 and 90", "field": "latitude" } }
```

参数或请求体无效返回 `400`，路径或项目不存在返回 `404`，方法不支持返回 `405`，内容类型不支持返回 `415`。内部错误返回 `500`，不向调用者暴露数据库错误和密钥。

## 旧项目兼容

保留以下接口，方便已有设备逐步切换：

| 接口 | 行为 |
| --- | --- |
| `PUT /location` | 接收旧 `lat/lng/datetime/device/city` 表单，返回 `{ "success": true }` |
| `GET /location` | 保留旧响应字段，最新位置统一按观测时间选取 |
| `GET /locations` | 保留 D1 `data.results` 包装，按观测时间倒序返回全部记录 |
| `POST /data` | 接收旧 `project=current/all/项目名`，保留原字段数组；轨迹按时间正序返回 |

这三个旧路径既接受 Bearer Token，也接受旧 `Token` 请求头；都使用新 Worker 的 `INGEST_TOKEN` 值。若提供了 `Authorization`，只验证该凭据，不回退到 `Token`。新的 `/api/*` 只接受 Bearer Token。

旧上报也执行局部质量检测，但保持旧响应格式；旧查询继续返回原始记录。新客户端通过 `/api/*` 查询质量标记或使用 `view=filtered`。

`/location` 兼容旧的日期字符串解析；新接口要求毫秒时间戳或带时区的 ISO 日期时间，避免设备与服务端时区混淆。旧全量查询没有分页，新客户端应使用 `/api/locations`。

旧 `/data` 的项目查询现在也必须提供 Token，未授权不再返回轨迹。项目不存在返回 `404`，不再与空轨迹混淆。这些接口不提供公开分享访问。
