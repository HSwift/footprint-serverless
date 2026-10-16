# 开发指南

安装依赖和启动服务见 [README](../README.md#本地运行)。所有命令均在仓库根目录执行。

## 本地配置与数据

| 文件 | 用途 |
| --- | --- |
| `worker/api/.dev.vars` | 本地 API 的 `INGEST_TOKEN` |
| `worker/console/.dev.vars` | Mapbox 配置，以及可选的本地代理 Token 覆盖 |
| `worker/api/wrangler.local.jsonc` | 私有 D1 绑定、Worker 名称及手动部署配置 |

本地 Vite 代理将同源 `/api` 请求发送至 `127.0.0.1:8787`，在服务端附加 Token。它允许读取数据以及项目新增、编辑；不代理位置写入和删除。API Token 不发送到浏览器，本地预览不依赖生产 Access。

默认本地 D1 与线上数据库独立。需要隔离的数据预览库时使用：

```bash
pnpm --dir worker run dev:api:preview
```

该实例将数据保存在 `.local/console-preview/d1`。如需导入自己的 D1 导出文件，可先在空预览库中导入，再应用迁移：

```bash
pnpm --dir worker run wrangler d1 execute DB --local --persist-to ../.local/console-preview/d1 --file ../.local/snapshot.sql --yes
pnpm --dir worker run wrangler d1 migrations apply DB --local --persist-to ../.local/console-preview/d1
```

导出和离线分析过程见 [偏离点检测：可复现的本地分析](trajectory-outliers.md#可复现的本地分析)。仓库不附带轨迹数据或数据库快照。

## 自动化检查

```bash
pnpm --dir worker run check
pnpm --dir worker run build:console
pnpm --dir worker run build:api
```

`check` 包含类型检查、本地 D1 迁移、API 集成测试、Console 单元测试与部署脚本测试。`build:api` 使用 Wrangler dry run，不发布线上服务。

只运行部分检查：

```bash
pnpm --dir worker run typecheck
pnpm --dir worker run test:ci
pnpm --dir worker run test:console
pnpm --dir worker run test:tools
```

## 浏览器验证

先启动 API 和 Console 开发服务，并配置可用的 Mapbox Token。通过 `FOOTPRINT_BROWSER_PATH` 指定本机 Chromium 可执行文件：

```bash
export FOOTPRINT_BROWSER_PATH=/path/to/chromium

node worker/console/test/browser.mjs
node worker/console/test/view-all.mjs
node worker/console/test/projects.mjs
node worker/console/test/local-time.mjs
node worker/console/test/map-performance.mjs
node worker/console/test/map-selection.mjs
node worker/console/test/map-zoom.mjs
```

这些脚本验证真实 API、地图交互、时间轴、项目管理、时区显示及不同屏幕尺寸。结果和截图写入 `.local/console-preview/`。项目验证脚本使用隔离预览库，创建临时项目并在结束后清理。

浏览器检查会加载 Mapbox 底图并使用相应额度。帧率结果受 WebGL 渲染器影响，软件渲染的结果不能代表硬件加速表现。

## 历史数据处理

轨迹分析及质量标记回填使用 `scripts/trajectory/` 中的工具，流程与限制见 [偏离点检测文档](trajectory-outliers.md)。质量标记独立存储，不修改原始坐标。

历史时区可通过离线计算生成回填报告：

```bash
pnpm --dir worker run backfill:timezone
pnpm --dir worker run backfill:timezone --apply-local
```

不带参数时只生成报告和 SQL；`--apply-local` 备份后更新隔离预览库。脚本使用 `geo-tz` 查询坐标所属时区，再按观测日期计算含夏令时的 UTC 小时偏移；只填写空值，保留客户端已上报的偏移。

离线脚本不自动写入线上数据库。线上回填需要先备份并核对自己的数据快照。私有报告、SQL、数据库和轨迹文件保存在被 Git 忽略的 `.local/` 中。

## 数据显示约定

- 控制台默认隐藏 `outlier`、`review`、`uncertain`，可切换原始轨迹；API 的 `view=filtered` 仅排除 `outlier`。
- 位置详情使用记录中的 `timezone` 显示当地时间；表格、项目编辑和时间轴统一使用北京时间。
- 全量地图在 zoom ≤ 5 时聚合，zoom > 5 时展开；项目与时间筛选在所有缩放级别均不聚合。
- 手动时间选段最长 31 天；项目预览使用项目完整时间范围。
- 当前前端分页加载位置数据后在本地筛选，上限为 100,000 个点。
