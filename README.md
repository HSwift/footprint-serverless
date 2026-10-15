# Footprint Serverless

个人位置上报、足迹查询 API 与地图控制台。API 运行于 Cloudflare Workers 和 D1。

项目提供两个独立 Cloudflare Worker：API 使用 Token 鉴权，Console 使用 Cloudflare Access。Console 使用 React、Mapbox GL JS 和虚拟表格，通过 Service Binding 在服务端携带 Token 调用 API。Access JWT 由 Console 校验，API 不信任 Access 请求头。两个 Worker 分别构建和部署。

## 目录

```text
worker/
  api/
    src/                 # 鉴权、校验、位置查询和项目读写
    migrations/          # D1 迁移，兼容旧表结构
    test/                # Worker / D1 集成测试
    .dev.vars.example
    wrangler.jsonc
  console/
    src/                 # 地图、浮动控件、点位详情与虚拟表格
    public/
    test/                # 数据逻辑测试与浏览器检查
    .dev.vars.example
    vite.config.ts
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
```

## 本地开发

使用 Node.js 24 或更新版本和 pnpm 11.28.5，推荐 Node.js 24（见 `.nvmrc`）。项目通过 `packageManager` 固定 pnpm 版本。

Wrangler 仅作为项目的 `devDependency` 安装，通过 `pnpm --dir worker exec wrangler ...` 或项目脚本调用，不需要全局安装。

在仓库根目录执行：

```bash
pnpm --dir worker install --frozen-lockfile
cp worker/api/.dev.vars.example worker/api/.dev.vars
pnpm --dir worker run db:migrate
pnpm --dir worker run dev:api
```

已有 `.dev.vars` 时保留自己的配置。文件中的 `INGEST_TOKEN` 是本地 API Token，不提交到 Git。

默认地址为 `http://localhost:8787`。上报一个位置：

```bash
export FOOTPRINT_TOKEN='local-development-only-change-me'
curl -X PUT http://localhost:8787/api/location \
  -H "Authorization: Bearer $FOOTPRINT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"longitude":0,"latitude":0,"datetime":"2024-01-01T00:00:00Z","timezone":0,"device":"example-device","city":"示例地点"}'
```

查询最新位置和轨迹：

```bash
curl http://localhost:8787/api/location -H "Authorization: Bearer $FOOTPRINT_TOKEN"
curl 'http://localhost:8787/api/locations?device=phone&limit=500' -H "Authorization: Bearer $FOOTPRINT_TOKEN"
```

## 控制台本地预览

在仓库根目录启动：

```bash
pnpm --dir worker run dev:console
```

打开 `http://127.0.0.1:5173`。控制台直接通过本地 API 加载位置和项目。历史坐标存储在本地数据库中，通过 API 读取。

前端以地图为主画面，使用白色、灰阶和信号橙。没有侧边栏或导航条，地图上放置筛选浮层、图层工具和点位详情。底部默认只显示“足迹数据”入口，提供弹窗和内嵌表格两种查看方式。内嵌表格沿用原来的高度：桌面 35vh，限制在 300–390px；手机 39dvh，最小 270px。两种视图均移除了表格 footer。

- 地图点位与表格双向选择，可沿时间顺序查看前后点。
- 点位卡片读取记录中的数字 `timezone`，显示当地日期、时间及 UTC 偏移；单位为小时，例如 `8`、`-5`、`5.5`、`5.75`。客户端上报观测时刻的偏移，历史数据离线计算并回填，浏览器直接格式化，不加载时区边界或添加 API / D1 请求。未保存偏移的记录明确显示 UTC 和“未记录时区”。表格、时间轴和项目编辑仍统一使用北京时间，原始时间戳与前后 24 小时窗口保持原样。
- 左上角只有两行概览：zoom ≥ 9 时读取已加载底图的附近地名，选中点位时优先显示其地点，其余显示 footprint logo；第二行显示当前可见点数和天数。底图地名在移动结束、瓦片加载完毕后读取，不调用逆地理编码，也不触发 D1 查询或表格重算。高倍缩放地名标签消失时，可沿用距上次查询位置 2 公里内的名称，否则尝试已加载的地名数据；暂时没有新名称时保留上一个标题，避免切回 logo 闪烁。旧数据的城市字段混有区县、街区和乡镇，暂不以去重地名数显示“城市数”。
- 界面和底图共用 Noto Sans 字体回退，补充中文、阿拉伯文和希伯来文，字体文件由项目自托管并按字符范围加载。logo 与地名使用相同字号、字重、行高和图标尺寸。Mapbox RTL 插件作为项目依赖自托管，只有遇到从右向左书写的文字时才加载其处理代码，支持阿拉伯文和希伯来文的字形与排版。
- 全量地图在 zoom ≤ 5 时聚合，zoom > 5 时直接显示全部可见点；项目和时间筛选在所有缩放级别都不聚合。自动隐藏点位不会使默认概览进入不聚合模式。跨过阈值只切换图层显示，不重新请求 API、不提交整份点数据、不重建地图。
- 图层菜单提供“显示位置点”“显示国境线”和“显示地名”。国境线默认关闭，地名默认开启；地名开关控制国家、省份、城市、乡镇和街区名称，左上角的当前位置概览仍可从已加载底图获取名称。连线由项目行预览、时间轴选段或详情卡的“前后 24 小时轨迹”触发，通过清除项目或时间范围、关闭 24 小时轨迹卡片或“查看全部轨迹并清空连线”清空。当前 Light v11 底图的国家级边界实线、虚线和背景描边一起切换；图层列表在底图加载时缓存，开关只调整可见性，不重建地图、不重新提交轨迹数据，也不调整地图视角。
- 选中点的详情卡提供“前后 24 小时轨迹”：以该点时间为中心，精确显示前后各 24 小时的点和连续连线，保留项目和原始轨迹显示设置。关闭详情卡会清除此窗口和连线，恢复全部时间，顶部“清除”也可恢复；重新拖动时间轴手柄则切回按天选择，此后关闭卡片保留手动选段。
- 点击顶部日期展开两行长条时间轴：第一行是年月选择、“今天／本周／本月”、选段信息和“清除”，第二行显示完整的三个日历月。快捷范围按上海时区选择当天、周一至周日、当月首日至末日；没有数据的当前日期会显示空轨迹，不回退到最新记录日期。为完整选中 31 天的月份，连续选段上限为 31 天。每天均有等宽刻度，桌面每五天标注日期，手机标注月初和月中；无数据的日期也保留，柱高按整个数据范围统一缩放。
- 默认静默隐藏 `outlier`、`review`、`uncertain`，保留 `retained`、`pending` 和 `unassessed`；连线默认关闭。拖动手柄或轴身时只预览，松手后更新地图和表格并自动开启连线。已选区间与可视窗口平移相同时间，保持时长和屏幕位置；精确 48 小时窗口保留具体时分秒。清除范围后恢复全部时间并关闭连线，仍保留点位显示设置。
- 所有清除入口保留地图当前中心和缩放：时间轴“清除”、关闭点位卡片、关闭点位图层和清空项目。清除时停止尚未结束的定位动画；选择新范围或项目仍会自动取景，切换原始轨迹显示也保留视角。地图工具的“查看全部轨迹并清空连线”会清空项目、时间范围、24 小时窗口和两种表格搜索，将“显示原始轨迹”恢复为关闭，关闭点位卡片及所有连线标记、开启位置点，再用重置后的全部可见点位调整视野；即使筛选结果为空也可使用此按钮。
- 连线按时间顺序使用浅橙到深橙的渐变，并叠加稀疏方向箭头；左下角的“较早／较晚”说明颜色方向。箭头复用线的 GeoJSON source，用原生 symbol 图层沿线放置，约 180 像素间隔并避开碰撞。超过 1,000 个去重后的线顶点时只显示渐变，避免密集符号布局；平移、缩放不重算轨迹、不追加 API 请求。渐变表示沿路径的先后顺序，不表示等时间间隔或速度。
- 轨迹起点、终点分别显示浅橙和深橙的空心圆，只有两个原生地图标记；两端坐标完全重合时显示同心圈。可以点击圆圈查看对应点位，清空连线时同步移除圆圈。
- 表格分为“位置点”和“项目”两个标签页，内嵌与弹窗共享当前标签。“项目”显示名称、起止时间及当前显示模式下的点数，并提供编辑和新增；点击项目整行在地图预览并自动连线，也支持聚焦行后按 Enter 或空格。编辑按钮单独处理，不触发行预览。项目名称和时间范围通过 API 保存。时间统一按北京时间编辑，修改名称时保留历史时间戳的毫秒精度。项目点数复用已加载的位置，保存后只更新项目列表，不重新加载所有位置点。
- 项目行预览会清空时间、位置点搜索和点位选择，恢复默认点位清理，在地图显示项目时间内的全部可见点并按时间顺序连线，自动取景；整个项目预览没有一个月上限，时间轴手动选段仍限制为不超过 31 天。“清除项目筛选”同时清空连线并保留地图视角。搜索栏旁的“显示原始轨迹”按钮直接切换原始数据，位置点与项目标签页均可使用，点数和连线同步更新；设备筛选按钮与弹窗已移除。所选范围内的可见点按时间、编号排序连续连线，跨设备和长时间间隔也连接；隐藏点不进入连线。线段连接观测点，不表示实际走过的道路。
- 表格提供“弹窗查看表格”和“打开表格／收起表格”，弹窗支持关闭按钮、Escape 和点击遮罩关闭；点击弹窗中的点位会关闭弹窗并在地图定位。两个视图共享搜索、筛选和排序，同一时间只挂载一份虚拟表格。搜索保留地图上下文。界面不显示质量列、异常计数、算法提示或历史匹配证据。即使临时查看原始点，地图点位也统一使用橙色。

### Mapbox 配置

创建 `worker/console/.dev.vars`（已有文件时保留）：

```bash
cp worker/console/.dev.vars.example worker/console/.dev.vars
```

填写 Mapbox 浏览器公开 Token 后重启开发服务器：

```dotenv
MAPBOX_PUBLIC_TOKEN="pk.…"
MAPBOX_STYLE="mapbox://styles/mapbox/light-v11"
```

也可填写自己的 Studio 样式 URL。默认 Light 底图调整为灰阶，自定义样式保留其自身配色。使用限定站点域名的公开 Token，不使用 `sk.` 私密 Token。Mapbox Logo 和署名保持可见。

地图使用 Mapbox GL JS 底图。未配置 Token 时，地图区域显示配置提示，数据表仍读取 API 记录。全量点位在 zoom ≤ 5 时聚合，zoom > 5 时与筛选点位复用不聚合数据源和批量 `circle` 图层，轨迹使用 `line` 图层，选中点单独更新。地图实例在筛选、排序和选择时复用，SDK 延迟加载。

地图性能调整参考 Mapbox 的 [渲染性能指南](https://docs.mapbox.com/help/troubleshooting/mapbox-gl-js-performance/) 和 [大 GeoJSON 指南](https://docs.mapbox.com/help/troubleshooting/working-with-large-geojson-data/)：

- 全量浏览的聚合半径为 48px，聚合索引只构建至 zoom 5；zoom > 5 时精确切换到不聚合的点位图层，zoom ≤ 5 时恢复聚合，点击聚合可继续放大。筛选时在所有缩放级别直接显示点。两个点数据源在数据变化时更新，缩放事件仅在显示模式改变时切换图层，不逐帧更新 React、提交 GeoJSON 或重建地图。选中点使用独立图层。
- 点、线数据源的瓦片缓冲从默认 128 调为 64，轨迹简化容差为 1。所选范围内的轨迹使用一个连续 `LineString`，跳过连续重复坐标；展示用坐标精度限制为小数点后 6 位，API 和表格保留原始精度。
- 拖动和缩放期间跳过悬停命中检测，静止时每 80ms 最多查询一次。地图中心与缩放级别在地图组件内更新，地图移动不会引起页面统计和表格重绘。
- 连线关闭时不构建轨迹 GeoJSON；开启时只更新线数据源，保留当前地图位置和点位数据源。
- 本地 API 数据仍然一次读完。Mapbox 在客户端将 GeoJSON 切成瓦片并按视野绘制；移动地图不会重新请求位置列表，也不会重新提交完整点、线数据源。服务端瓦片或按范围增量加载用于后续更大的数据规模。

使用配置好的 Mapbox Token，对运行中的开发预览做交互检查：

```bash
node worker/console/test/map-performance.mjs
node worker/console/test/map-selection.mjs
node worker/console/test/map-zoom.mjs
```

该命令实际加载 Mapbox 底图，记录可见点与聚合数、GeoJSON 大小、拖动命中检测和移动期间的数据源更新；会使用 Mapbox 地图额度。地图实例仅在检查浏览器中通过拦截开发模块暴露，应用本身没有全局地图调试对象。结果写入 Git 忽略的 `.local/console-preview/map-performance.json`，同时记录 WebGL 渲染器。当前自动化 Chromium 使用 SwiftShader 软件渲染，测得帧率不能作为用户浏览器硬件加速后的性能结论。

`map-selection.mjs` 另外核对真实筛选点位不聚合、连续连线的全部顶点与 API 顺序一致、平移时选段位置固定且仅在松手后提交一次地图数据、精确 48 小时窗口平移后保持具体时刻，以及清除时间范围后恢复全量聚合。

`map-zoom.mjs` 使用全量真实数据核对 5、5.0001 等缩放边界、反复缩放不提交点或线数据、不重绘表格、不重新请求 API、原始点可点击，以及前后 24 小时窗口在低 zoom 下仍不聚合。

### 使用本地 API 数据

按前面的 API 开发步骤设置 `worker/api/.dev.vars` 并启动 `dev:api`。Vite 在服务端读取 API `.dev.vars` 中的 `INGEST_TOKEN`；也可在 Console `.dev.vars` 中指定同名值覆盖。该 Token 不发送到浏览器，API 请求通过同源 `/api` 代理至 `127.0.0.1:8787`。预览代理允许读取 API，并仅放行项目新增与编辑写请求。

需要独立的数据预览库时，使用 `.local/console-preview/d1`：

```bash
pnpm --dir worker run dev:api:preview
pnpm --dir worker run dev:console
```

仓库不包含任何人的轨迹、数据库快照或复核清单。可使用自己的 D1 导出文件初始化空预览库，并应用迁移：

```bash
pnpm --dir worker run wrangler d1 execute DB --local --persist-to ../.local/console-preview/d1 --file ../.local/trajectory-analysis/new-snapshot/snapshot.sql --yes
pnpm --dir worker run wrangler d1 migrations apply DB --local --persist-to ../.local/console-preview/d1
```

导出与离线分析流程见 [轨迹偏离点检测](docs/trajectory-outliers.md#可复现的本地分析)。分析完成后，可向空的质量表回填标记：

```bash
pnpm --dir worker exec node ../scripts/trajectory/backfill-local.mjs ../.local/trajectory-analysis/new-snapshot
```

脚本只访问独立预览库，检查分析输入与数据库一致，备份后以事务写入独立质量表；原始位置和项目不变。已有完整旧版本标记时，可显式传入 `--replace-version <旧版本>`，同版本或混杂版本不会被覆盖。备份和报告保存在被 Git 忽略的 `.local/`。

历史时区采用离线计算，数据库字段 `Timezone` 保存观测时刻的 UTC 小时偏移：

```bash
pnpm --dir worker run backfill:timezone
pnpm --dir worker run backfill:timezone --apply-local
```

不带参数只生成报告和 SQL；`--apply-local` 备份后更新预览库。脚本使用开发依赖 `geo-tz` 查询坐标所在时区，再按记录日期计算偏移，包含夏令时；中国重叠时区采用北京时间。仅填写空值，保留客户端已上报的偏移。无法确定的记录保留空值并列入本地报告。脚本不连接远程数据库；线上回填应先备份、核对自己的快照并验证生成的 SQL。

刷新页面后，自动隐藏已标记点，点击编号定位，用详情卡的“前后 24 小时轨迹”浏览附近行程；“查看全部轨迹并清空连线”重置全部数据筛选和搜索，移除连线及其方向、起终点标记，然后展示全部可见足迹。搜索栏旁可临时打开“显示原始轨迹”。原始坐标、全部记录和后端标记保持原样，API 的 `view=filtered` 仍按其原有约定仅排除 `outlier`；前端默认清理三类标记是独立的显示策略。

前端顺序读取所有位置分页（每页 5,000 条）和项目分页，再在本地筛选。首次读取需要加载全部位置；刷新期间只会读取本地 API，不写入或删除记录。当前预览上限为 100,000 个点；大规模数据的服务端范围查询与增量加载后续再加入。

本地开发服务器只监听 `127.0.0.1`，通过 Vite 代理访问 API。生产部署使用独立 Console Worker 提供相同的配置端点与 Service Binding 代理，不使用 Vite 开发服务器。

本地代理只放行同源的 `POST /api/projects` 和 `PATCH /api/projects/:id` 写请求，API Token 仍由服务端添加。新增与编辑写入当前本地 API 使用的数据库；历史预览脚本使用独立的 `.local/console-preview/d1`。位置写入和删除请求仍由预览代理阻止。

### 前端验证

```bash
pnpm --dir worker run build:console
pnpm --dir worker run test:console
# 先保持 dev:console 运行；指定本机 Chromium 可执行文件。
FOOTPRINT_BROWSER_PATH=/opt/google/chrome/chrome node worker/console/test/browser.mjs
FOOTPRINT_BROWSER_PATH=/opt/google/chrome/chrome node worker/console/test/view-all.mjs
FOOTPRINT_BROWSER_PATH=/opt/google/chrome/chrome node worker/console/test/projects.mjs
FOOTPRINT_BROWSER_PATH=/opt/google/chrome/chrome node worker/console/test/local-time.mjs
```

浏览器检查直接访问运行中的本地 API 和配置好的 Mapbox，覆盖点表联动、时间轴拖动与 31 天上限、历史月份和快捷范围选择、自动隐藏与原始点切换、图层开关、弹窗与内嵌表格、320px / 390px / 1440px 布局，以及全量位置分页和虚拟表格。检查使用 Mapbox 地图额度，截图和结果位于 Git 忽略的 `.local/console-preview/`。

`view-all.mjs` 验证“查看全部轨迹”从项目筛选、组合筛选、空结果、时间轴选段和手机视图恢复全部可见点，并核对取景使用完整数据的边界、每次只取景一次且不追加位置 API 请求。

`projects.mjs` 仅针对独立的本地历史预览库检查项目标签、地图预览、编辑弹窗、真实 API 新增与修改、刷新持久化和手机布局。它创建一个临时项目，只编辑该项目，结束后清理并核对原有项目未变；另在纽约时区的浏览器中检查北京时间输入，确认保存与预览不追加位置请求。

`local-time.mjs` 从当前预览数据中按不同的已保存偏移选择点位，在与应用不同的浏览器时区中检查卡片当地时间、数字偏移、原始时间戳及表格北京时间，并验证选点不加载时区边界数据、不追加 API 请求。单元测试覆盖冬夏令时偏移、夏令时结束后的重复钟点、跨日、分钟偏移、零偏移和未记录时区。

可通过 `FOOTPRINT_SNAPSHOT` 指定私有历史 `locations.json`，额外逐条比较真实 API 记录与快照：

```bash
FOOTPRINT_SNAPSHOT="$PWD/.local/trajectory-analysis/new-snapshot/locations.json" node worker/console/test/browser.mjs
```

## API

除不包含位置数据的 `GET /health` 外，全部接口要求 `Authorization: Bearer <INGEST_TOKEN>`。未配置密钥返回 `503`，缺失或错误凭据返回 `401`。浏览器以后通过 Console 调用，不需要保存 API Token。

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

### 位置上报

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

常规录入执行 5 条 SQL、3 次 D1 调用；新增历史位置查询每次分析最多 2 条，无重试时总计最多 7 条 SQL。计算仍在 Worker 内逐次进行，质量标记只在状态、原因、版本或证据变化时写回。同一候选的已完成历史证据可复用，补报和候选段变化会重新检查。`analysis.updatedPoints` 表示实际写回的变化数量，不含初始 `pending`；为零也可以表示检查已完成。预算、计费边界与局部限制见 [D1 请求与读写预算](docs/trajectory-outliers.md#d1-请求与读写预算)。

质量标记独立保存在 `LocationQuality`，不修改原始坐标。`quality.status` 可为 `pending`（等待上下文）、`retained`（当前窗口未发现偏离）、`outlier`（高置信候选）、`review`（待复核候选）、`uncertain`（证据不足）或 `unassessed`（尚未分析的旧记录）。标记会随新观测或补报重新计算，不代表人工确认的真值。`checkedAt` 是最近一次保存该标记时的服务端检查时间；不变化时不会为刷新时间额外写入。`timestamp` 是设备观测时间。

检测失败或连续两次遇到并发版本变化时，已成功入库的请求仍返回成功，`analysis.state` 为 `deferred`，不会因为分析失败要求设备重复录入。该窗口暂未完成标注，后续邻近上报可以重新分析；此版本没有独立重试队列。数据库写入失败则返回错误，原始位置与初始质量标记通过同一个事务保存。

### 位置查询

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

### 项目读写

项目沿用旧版的时间窗口模型，位置记录没有项目外键。项目列表返回 `{ "projects": [...], "pagination": ... }`，支持 `limit`（默认 100，最大 500）和 `offset`，按起始时间倒序排列。

按名称查询返回 `{ "project": { "id": 1, "name": "trip", "startTime": 1000, "endTime": 3000 } }`。项目时间与位置时间使用相同的毫秒单位。不存在的项目返回 `404`。旧表允许重复名称，按名称查询时使用 ID 最小的一条，不对历史数据强加唯一约束。

`POST /api/projects` 接收 `name`、`startTime`、`endTime`，成功返回 `201` 和 `{ "project": ... }`。名称去掉首尾空白后不能为空，最多 200 字符；时间支持毫秒时间戳或带时区的 ISO 8601 字符串，结束不得早于开始，允许起止时间相同、项目重叠及重复名称。

`PATCH /api/projects/:id` 接收上述字段的全部或部分，至少提供一个字段，成功返回 `200` 和保存后的项目。路径 ID 必须是正整数，项目不存在返回 `404`。编辑按 ID 定位，避免同名项目互相影响；原有 `GET /api/projects/:name` 仍按名称查找，包括纯数字名称。项目读写均要求 Bearer Token，不修改位置记录，也不重新运行偏离点检测。

### 错误响应

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

旧 `/data` 的项目查询现在也必须提供 Token，未授权不再返回轨迹。项目不存在返回 `404`，不再与空轨迹混淆。公开分享留到后续 Console 功能设计时单独处理。

## 数据库与部署

公共模板 `worker/api/wrangler.jsonc` 使用通用 Worker 名称、D1 名称 `footprint` 和绑定 `DB`，不包含账号 ID、数据库 ID、自定义域名或凭据。项目脚本优先读取被 Git 忽略的 `worker/api/wrangler.local.jsonc`；没有私有配置时使用公共模板。显式传入 `--config` 可以覆盖此选择。

使用自己的 Cloudflare 账号部署 API：

```bash
pnpm --dir worker install --frozen-lockfile
cp worker/api/wrangler.jsonc worker/api/wrangler.local.jsonc
pnpm --dir worker run wrangler login
pnpm --dir worker run wrangler d1 create footprint
```

将创建命令返回的 `database_id` 填入私有配置的 `d1_databases[0]`，需要时修改其中的 Worker 名称和 `database_name`。多账号可在本地环境或 CI Secret 中设置 `CLOUDFLARE_ACCOUNT_ID`；CI 的 `CLOUDFLARE_API_TOKEN` 也通过 Secret 注入。不要把这些值写入公共模板。

```bash
pnpm --dir worker run deploy:api
pnpm --dir worker run wrangler secret put INGEST_TOKEN
```

`deploy:api` 先应用远程迁移，再发布 API；随后用自己的随机 Token 设置运行时 Secret，客户端使用相同的 Bearer Token。未设置 Secret 时 API 拒绝授权请求。本地 `.dev.vars` 不会自动成为线上 Secret。迁移兼容现有 `StartTime/EndTime` 项目表，保留原始位置和项目，添加查询索引、数字时区字段及独立质量表；更早的 `StartID/EndID` 表需要先转换。迁移记录通过 [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) 管理。

自定义域名和部署绑定只配置在私有 Wrangler 文件或 Cloudflare 控制台。直接使用 `pnpm exec wrangler` 时需自行传入配置路径；`pnpm run wrangler` 及仓库的开发、构建、迁移和部署脚本会自动选择配置。公开仓库不记录个人部署状态、数据库内容或账号信息。

### 两个独立的 Cloudflare Builders

将同一 GitHub 仓库分别连接到两个 Worker，各自创建一个生产 Builder。生产分支使用 `main`，根目录使用 `worker`，Node.js 为 `24`，pnpm 为 `11.28.5`。Cloudflare 负责安装锁定的依赖。

| 配置 | API Builder | Console Builder |
| --- | --- | --- |
| Worker 名称 | `footprint-serverless-api` | `footprint-serverless-console` |
| Build command | `pnpm run cf:render:api && pnpm run typecheck` | `pnpm run cf:render:console && pnpm run typecheck && pnpm run build:console` |
| Deploy command | `pnpm run cf:deploy:api` | `pnpm run cf:deploy:console` |
| 必需 Build Variable | 无，复用 API Worker 已有的 `DB` 绑定 | 无，Access 及地图配置也可直接在 Worker 运行时设置 |
| 可选 Build Variables | `API_WORKER_NAME`；首次部署尚无绑定时可提供 `D1_DATABASE_ID`、`D1_DATABASE_NAME` | `API_WORKER_NAME`、`CONSOLE_WORKER_NAME`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`MAPBOX_PUBLIC_TOKEN`、`MAPBOX_STYLE` |

先部署 API，再部署 Console。API Builder 应用 D1 迁移并部署 API；Console Builder 只发布前端静态资源、Console Worker 和 Service Binding，不迁移数据库、不部署 API。自定义 Worker 名称时，两个 Builder 的 `API_WORKER_NAME` 必须一致。

API Worker 的 **Bindings** 中将现有 D1 数据库绑定为 `DB` 即可，不需要在 Builder 重复填写数据库 ID。部署脚本通过 Wrangler 的 `deployments status --json` 和 `versions view --json` 读取当前生产版本的 `DB`，只在临时配置中填入实际 ID，让迁移和发布使用同一个数据库。缺少绑定或正在承接流量的版本绑定了不同数据库时，部署停止，不自动创建或改接数据库。首次部署可以按上面的本地部署步骤建立绑定，也可临时提供 `D1_DATABASE_ID`，绑定建立后移除该 Build Variable。

构建脚本从通用模板生成临时 `wrangler.generated.jsonc`，部署后清理，账号资源信息不进入 Git。运行时 Secret 在后续发布中保留。两个 Worker 都需要相同的 `INGEST_TOKEN`，通过各自 Worker 的 **Settings → Variables and Secrets** 设置；首次引导也可在两个 Builder 中临时提供相同的 Secret `RUNTIME_INGEST_TOKEN`，初次发布成功后移除该 Build Secret。

### Console Access 配置

在 Console Worker 的 **Access** 页面选择 **Protect this Worker behind Access → All traffic**，设置自己的允许策略。不要把 API Worker 一起放到这个 Access 应用中，API 继续使用 Bearer Token 接收客户端上报。

将 Access Team Domain（HTTPS origin）及应用 Audience Tag 分别配置为 Console Worker 的 `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD`，或放到其 Builder 的同名变量后重新构建。Console 在服务端校验 JWT 的签名、issuer、audience 和有效期；只伪造身份请求头不能访问数据。没有配置 Access 时，除无数据的健康检查外均拒绝访问。

Console Worker 同时配置 `MAPBOX_PUBLIC_TOKEN` 和可选的 `MAPBOX_STYLE`。地图 Token 可以是普通运行时变量，API Token 必须是 Secret；浏览器只会收到公开的 Mapbox 配置。项目新增和编辑要求同源请求；位置写入与删除不通过 Console 代理。

Workers Builds 的 Git 连接、构建变量和 Access 允许名单均保存在自己的 Cloudflare 账号，不提交到仓库。部署流程不需要 GitHub Actions。两个 Worker 发布后都提供 `/health` 健康检查。

## 检查

```bash
pnpm --dir worker run check
pnpm --dir worker run build:api
```

`check` 包含类型检查、本地数据库迁移、配置选择测试和 [Workers 运行时集成测试](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)。测试覆盖 Token 鉴权、上报校验、时间排序、分页、筛选、旧接口、已有数据保留、录入后的标记更新、历史补报、并发保护、持续高速行程及检测故障时的原始数据保留。`build:api` 使用 Wrangler `--dry-run`，不部署线上服务。

## 轨迹偏离点分析

API 每次录入都执行基于速度约束与最长相容子序列的局部检测，独立保存质量标记；同一检测器也可离线分析全量数据。论文依据、实时处理窗口、限制及全量 D1 导出／分析命令见 [轨迹偏离点检测](docs/trajectory-outliers.md)。原始副本与分析结果放在 Git 忽略的 `.local/` 下。
