# 部署指南

Footprint 部署为两个独立的 Cloudflare Worker。API 接收客户端上报并访问 D1；Console 提供静态资源、校验 Access JWT，通过 Service Binding 调用 API。

## 前置条件

- Node.js 24+、pnpm 11.28.5。
- 可使用 Workers 和 D1 的 Cloudflare 账号。
- 用于地图底图的 Mapbox 公开 Token。
- 用于生产控制台登录的 Cloudflare Access 配置。
- 使用 Workers Builds 时，需要连接 GitHub 或 GitLab 仓库。

以下命令均在仓库根目录执行。Wrangler 使用项目内版本，不需要全局安装。

## 首次部署

### 1. 创建并绑定 D1

```bash
pnpm --dir worker install --frozen-lockfile
cp worker/api/wrangler.jsonc worker/api/wrangler.local.jsonc
pnpm --dir worker run wrangler login
pnpm --dir worker run wrangler d1 create footprint
```

将创建命令返回的 `database_id` 填入 `worker/api/wrangler.local.jsonc` 的 `d1_databases[0]`，保留绑定名 `DB`。如果复用已有数据库，填写该库的 ID 和名称。

项目的 API 开发和手动部署脚本优先读取 `wrangler.local.jsonc`；显式传入 `--config` 时使用指定文件。私有配置被 Git 忽略，公共模板保持通用。

### 2. 部署 API

```bash
pnpm --dir worker run deploy:api
pnpm --dir worker run wrangler secret put INGEST_TOKEN
```

为 `INGEST_TOKEN` 输入随机生成的生产 Token，客户端使用相同的 Bearer Token。`deploy:api` 先应用远程 D1 迁移，再发布 API；本地 `.dev.vars` 不会自动写入线上 Secret。

多账号环境可以通过 `CLOUDFLARE_ACCOUNT_ID` 选择账号。外部 CI 使用 `CLOUDFLARE_API_TOKEN`，凭据通过 CI Secret 注入。

### 3. 部署 Console

```bash
pnpm --dir worker run build:console
pnpm --dir worker run cf:render:console
pnpm --dir worker run cf:deploy:console
pnpm --dir worker run wrangler secret put INGEST_TOKEN --config console/wrangler.jsonc
```

Console 的 `INGEST_TOKEN` 必须与 API 一致。默认 Service Binding 名称为 `API`，目标为 `footprint-serverless-api`。

随后按下文配置 Console 的 Access 和 Mapbox 变量。配置完成前，Console 会拒绝访问。

## 运行时配置

在每个 Worker 的 **Settings → Variables and Secrets** 中设置：

| Worker | 名称 | 类型 | 用途 |
| --- | --- | --- | --- |
| API | `INGEST_TOKEN` | Secret | 客户端与 Console 调用 API 的 Token |
| Console | `INGEST_TOKEN` | Secret | 与 API 相同，由服务端添加到代理请求 |
| Console | `ACCESS_TEAM_DOMAIN` | Variable | 完整的 Access 团队 origin，如 `https://example.cloudflareaccess.com` |
| Console | `ACCESS_AUD` | Variable | 对应 Access 应用的 Audience Tag |
| Console | `MAPBOX_PUBLIC_TOKEN` | Variable | 以 `pk.` 开头的 Mapbox 浏览器公开 Token |
| Console | `MAPBOX_STYLE` | Variable，可选 | 默认 `mapbox://styles/mapbox/light-v11` |

API Worker 保持 Token 鉴权。Access 配置仅用于 Console，不用于客户端位置上报。

## Cloudflare Access

在 Console Worker 的 **Access** 页面启用 **Protect this Worker behind Access → All traffic**，配置允许登录的用户或组织策略。

从该 Access 应用及团队配置中取得 `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD`，写入 Console 的运行时变量。两者必须来自同一套 Access 配置；团队域名须与实际 Access 登录页使用的 origin 一致。

Console 校验 JWT 的签名、issuer、audience 和有效期，再转发 API 请求。API Token 只在服务端使用。Console 代理允许读取轨迹以及新增、编辑项目，不提供位置写入或删除代理。

如果使用基于 hostname 的 Access 应用，需要将 Console 的自定义域名加入该应用。Worker 级的 All traffic 保护范围及配置方式见 [Cloudflare Access 文档](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)。

## 两个 Workers Builds

首次部署完成后，将同一 Git 仓库分别连接到 API 和 Console Worker。两个 Builder 使用独立的构建与部署命令。

| 配置 | API | Console |
| --- | --- | --- |
| Worker 名称 | `footprint-serverless-api` | `footprint-serverless-console` |
| 根目录 | `worker` | `worker` |
| 生产分支 | `main` | `main` |
| Build command | `pnpm run cf:render:api && pnpm run typecheck` | `pnpm run cf:render:console && pnpm run typecheck && pnpm run build:console` |
| Deploy command | `pnpm run cf:deploy:api` | `pnpm run cf:deploy:console` |

在两个 Builder 中设置 `NODE_VERSION=24` 和 `PNPM_VERSION=11.28.5`。

API 部署脚本通过 Wrangler 读取当前生产版本的 `DB` 绑定，将实际 ID 写入临时配置，用同一个数据库完成迁移与发布。已有绑定时不需要设置 `D1_DATABASE_ID`。缺少绑定，或承接流量的多个版本绑定了不同数据库时，部署会停止。

Console Builder 只部署 Console Worker、静态资源和 Service Binding，不执行数据库迁移。运行时配置由 `keep_vars` 保留，已有 Secret 在后续部署中保留。

可选构建变量：

| 变量 | 使用范围 | 说明 |
| --- | --- | --- |
| `API_WORKER_NAME` | 两个 Builder | 自定义 API Worker 名称时，两处保持一致 |
| `CONSOLE_WORKER_NAME` | Console | 自定义 Console Worker 名称 |
| `D1_DATABASE_ID` | API | 尚无线上绑定时，可用于首次部署 |
| `D1_DATABASE_NAME` | API | 显式指定数据库 ID 时，可设置对应名称 |
| `RUNTIME_INGEST_TOKEN` | 两个 Builder，Secret | 首次部署时写入相同的运行时 Token，完成后可移除此构建 Secret |

Console 也支持从构建变量读取 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`MAPBOX_PUBLIC_TOKEN` 和 `MAPBOX_STYLE`。Access 两项须同时提供；构建变量会写入运行时配置。如果已在 Worker 中管理这些值，Builder 不必重复设置。

生成的 `wrangler.generated.jsonc` 与首次部署 Secret 文件均被 Git 忽略，并在部署后清理。Git 连接、构建凭据和环境变量由 Cloudflare 管理。

## 自定义域名

分别进入两个 Worker 的 **Settings → Domains & Routes → Add → Custom Domain**，添加自己的域名，例如：

| Worker | 域名示例 |
| --- | --- |
| Console | `console.example.com` |
| API | `api.example.com` |

Cloudflare 会为 Custom Domain 创建 DNS 记录并签发证书，详见 [Custom Domains 文档](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。Console 通过 Service Binding 调用 API，其服务端连接不依赖 API 公网域名。

将 Console 域名加入 Mapbox 公开 Token 的允许访问范围。部署专属域名和账号资源信息保存在 Cloudflare 或私有配置中。

## 验证与排查

- **API**：`GET /health` 应返回 `200`；`GET /api/me` 无 Token 时返回 `401`，有效 Bearer Token 返回 `200`。
- **Console**：未登录时应进入 Access 登录流程，登录后可以加载地图和数据。
- **配置缺失返回 503**：核对两个 Worker 的 Token，以及 Console 的 Access 配置。
- **Access 登录成功后仍返回 401**：核对 Console 的 Team Domain 与实际登录域名，以及 Audience 是否属于该应用。
- **地图无法加载**：核对 Mapbox Token 类型、允许访问的域名和样式 URL。

两个 Worker 的应用层均提供 `/health`。启用 Access All traffic 后，Console 的健康检查也会受到边缘 Access 策略保护。

## 已有数据库

迁移保留原始位置和项目，并添加索引、数字时区字段及独立质量表。现有项目表需要使用 `StartTime` / `EndTime`；更早的 `StartID` / `EndID` 结构应先转换。应用迁移不等于全量回填历史质量标记或时区，这些操作见 [开发指南](development.md) 和 [偏离点检测文档](trajectory-outliers.md)。

轨迹快照、数据库文件、Token 和私有 Wrangler 配置均不纳入版本控制。
