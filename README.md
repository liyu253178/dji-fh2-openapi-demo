# DUAV · 无人机巡检监管平台

> 面向自然资源 / 政务监管场景的无人机低空巡查平台。
> 底层对接 **大疆司空 2（DJI FlightHub 2）OpenAPI**，在其上构建「飞得起来 → 看得见 → 派得出去 → 闭得回来」的完整监管闭环。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
![Status](https://img.shields.io/badge/status-active%20development-orange.svg)

---

## 这是什么

DUAV 不是「无人机地图大屏」，而是一套**把空中发现转成可派发、可核查、可整改、可复核、可归档的自然资源监管流程**的系统。

它回答五个问题：

| 问题 | 由什么支撑 |
|---|---|
| **谁在飞** | 设备底账（一机一档，机场 + 飞行器 + 载荷 + 责任单位） |
| **飞到哪里** | 实时态势、航线库、飞行任务、遥测轨迹 |
| **看见了什么** | 成果资产库（原图 + GPS + RTK 状态 + 拍摄姿态） |
| **归谁处理** | 问题图斑 + 责任主体派发 + 邮件工单 |
| **处理完没有** | 整改闭环状态机 + 复核销号 + 台账统计 |

> 💡 **核心观点**：低空监管的价值不是把无人机图标放到地图上，而是把「空中发现」翻译成「业务可办」。
> 卫星看全域、低空看细节、套合判属性、平台管闭环。

---

## 能力概览

### 飞行与控制

| 能力 | 说明 |
|---|---|
| 虚拟座舱 | 机场/飞行器选择、控制权获取与释放、实时直播、作业地图、航线执行、实时指令（返航/暂停/恢复） |
| 多路直播 | 机场舱内/舱外相机、飞行器广角/变焦/红外三镜头；**volc / agora / srs 三引擎自适应** |
| 航线管理 | 列表、上传（STS 临时凭证 → 对象存储 → 上传通知）、下载、一键创建立即任务 |
| 任务管理 | 列表/筛选、详情、挂起/恢复、媒体资源、飞行轨迹 |
| 设备管理 | 物模型实时状态（47 字段）、HMS 异常、控制权、相机/镜头/清晰度控制、实时指令 |
| 监管大屏 | 架次、里程、时长、在线率、成功率等政务指标 |
| 最优机巢推荐 | 按目标点坐标与电量需求推荐起降机巢 |

### 成果资产（监管证据链）

| 能力 | 说明 |
|---|---|
| 媒体同步 | 按机场 / 项目 / 时间范围拉取飞行任务产物，自动下载原图 |
| **DJI 影像元数据解析** | 提取 GPS、RTK 定位质量、绝对/相对高度、云台与机身三轴角、飞行器 SN、相机 SN、镜头类型、飞行航线 ID |
| 地面覆盖估算 | 由高度 + FOV + 姿态角推算单张照片的地面覆盖范围（footprint），支持地图框选 |
| 多光谱配对 | 红外（`_T`）与可见光（`_V`）同架次自动配对，支持同屏比对 |
| 架次聚合 | 按 `FlightLineInfo` 自动聚合同一次飞行的所有照片 |

> ⚠️ **重要技术特性**：DJI 机型（M4TD 等）**不写标准 EXIF GPS IFD**，GPS 全部存放在 XMP 的 `drone-dji` 私有命名空间。
> 通用 exif 库会返回 `null`。本平台内置专用解析器，实测 **14/14 张 RTK 级坐标提取成功**。
> 详见 [`server/src/modules/asset/djiXmp.js`](./server/src/modules/asset/djiXmp.js)。

### 工单闭环

| 能力 | 说明 |
|---|---|
| 人工审核工作台 | 按架次批量处理、缩略图速览、地图定位、框选图斑、问题类型判定 |
| 图斑库 | 空间载体，可独立存在；AI 识别结果后续挂载到同一模型 |
| 工单状态机 | `草稿 → 已派发 → 已接收 → 整改中 → 已整改 → 待复核 → 已通过 → 已销号`（含退回分支） |
| 邮件派发 | 图片附件 + 位置示意图 + 空间描述 + 在线处理深链接 |
| 台账统计 | 按行政区、时间、状态、问题类型统计 |

### 系统管理

- **多组织 TK 切换** — 多组织密钥保存与热切换
- **多接入点** — 公有云国内 / 海外 / 私有云自定义
- **API 测试器** — 任意接口直连调试，无需改代码
- **实时日志** — SSE 推送的环形日志缓冲，原始 `code`/`message`/耗时可见
- **演示模式** — 无 TK 时以本地 mock 数据启动，可直接演示

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vue 3 · Vite · Pinia · Vue Router · Element Plus · Leaflet · ECharts |
| 地图 | 高德 / 吉林一号瓦片，WGS84 → GCJ-02 纠偏 |
| 直播 | `@volcengine/rtc`（火山）· `agora-rtc-sdk-ng`（声网）· 原生 WebRTC WHEP（SRS） |
| 后端 | Node.js · Express，统一注入 `X-User-Token / X-Project-Uuid / X-Request-Id / X-Language` |
| 存储 | `ali-oss` + STS 临时凭证（航线上传） |
| 影像解析 | 自研 XMP `drone-dji` 解析器，零外部依赖 |

**后端分层**：

```
routes/    薄路由：契约与校验
services/  领域服务：telemetry · device · wayline · task · live · stats · scheduler
modules/   业务模块：asset（成果资产）· review（审核）· ticket（工单）· notice（通知）
infra/     djiClient 网关 · cache(TTL) · events(SSE) · logger · store(TK) · mock
```

---

## 快速开始

```bash
# 1. 启动后端（端口 8787）
cd server
npm install
npm run dev

# 2. 启动前端（端口 5173）
cd web
npm install
npm run dev

# 3. 打开 http://localhost:5173
```

**TK 需要自备**，仓库不含任何内置密钥。两种方式二选一：

1. 启动后在「系统管理 → 添加 TK」中粘贴
   （TK 获取路径：大疆司空 2 → 我的组织 → 组织设置 → 云端互联 → 组织密钥）
2. 启动时用环境变量注入：

```bash
FH2_TOKEN=你的组织密钥 npm run dev
```

> 可选环境变量见 [.env.example](./.env.example)。无 TK 时平台以**演示模式**启动（接口走本地 mock）。

**使用流程**：系统管理 → 连通性体检 → 添加 TK → 选择项目 → 进入座舱 / 设备 / 航线 / 任务。

---

## 项目结构

```
duav/
├── ARCHITECTURE.md          架构设计（数据流、时序、接口清单、联调结论）
├── docs/
│   ├── ARCHITECTURE-v2.md   政务版信息架构与后端分层
│   └── 示例库对照与改进建议.md
├── server/                  后端 BFF :8787
│   ├── src/
│   │   ├── index.js         应用入口、路由挂载、SSE
│   │   ├── djiClient.js     司空 2 统一网关（鉴权、超时、safeParse）
│   │   ├── logger.js        环形日志缓冲 + SSE
│   │   ├── routes/          session device live wayline task model admin ops
│   │   ├── services/        领域服务
│   │   └── modules/
│   │       ├── asset/       成果资产（djiXmp.js 影像解析）
│   │       ├── drone/       无人机业务
│   │       └── system/
│   └── scripts/             probe-*.mjs 接口探针
├── web/                     前端 SPA :5173
│   └── src/
│       ├── views/           座舱 大屏 航线 设备 模型 系统管理
│       ├── components/      地图 播放器 模型查看 日志
│       └── api/dji.js       统一 HTTP + 错误归一化
├── skills/                  配套开发经验 Skill
├── tools/                   脱敏与密钥扫描
└── tests/                   回归测试
```

---

## 配套开发经验 Skill

联调过程中沉淀的经验已整理为可复用 Skill，位于 [`skills/sikong2-openapi/`](./skills/sikong2-openapi/)：

- 鉴权与组织切换的坑（TK 截断、接入点错配、缓存串味）
- 设备 / 物模型 / 控制权（DELETE + JSON Body、SN 校验）
- 图传直播三引擎适配与计费红线
- KMZ 航线上下行
- 飞行任务记录（缺参静默返回空列表）
- 媒体下载（签名 24h 过期、XMP GPS 解析）
- 3D Tiles / b3dm 解析与 LOD 策略
- 脱敏清单

附 `references/api-cheatsheet.md`（接口速查）与 `references/error-codes.md`（错误码与现象对照）。
安装到 `~/.workbuddy/skills/` 即可直接使用。

---

## 安全与脱敏

本仓库在导出前做了统一脱敏：

```bash
node tools/sanitize.mjs        # 批量替换 JWT / 设备 SN / 项目 UUID 为 YOUR_XXX 占位符
node tools/check-secrets.mjs   # 扫描残留敏感信息，有问题时以非 0 退出（可挂 CI / pre-commit）
```

**仓库内不包含任何真实组织密钥、设备 SN、项目 UUID、客户名称与坐标。**

`.gitignore` 已排除：

- `server/data/`（含 `tokens.json`）
- `docs/api/`（官方文档副本，含 Token 示例）
- `tests/report/`（截图可能含 SN 与客户项目名）
- `node_modules/` · `web/dist/` · `.env*`

> ⚠️ 组织密钥（TK）请只通过环境变量注入。**不要**写入源码、前端、日志、截图或 commit。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| `200401 Unauthorized` / `token validation failed` | TK 与接入点不匹配。在「系统管理 → 接入点」切换 国内/海外/私有云后重新体检；或在司空 2 重新生成组织密钥。TK 是 JWT，需三段完整 |
| 控制权获取 `Bad Request` | `drone_sn` 必须是**飞行器 SN**（不是机场 SN），`payload_index` 必须是数组，如 `["81-0-0"]` |
| 控制权释放 `internal server error` | 释放接口是 **DELETE + JSON Body**，需与获取时的 payload 一致 |
| 直播播放失败 | 司空 2 动态选择供应商（volc / agora / srs），本平台三引擎自适应。在「系统管理 → API 测试」直连 `/openapi/v0.1/live-stream/start` 查看原始 `url_type` 与 `url` |
| 飞行器镜头相关操作失败 | 飞行器**必须开机**才有 `camera_list`。司空 2 无远程开机接口，需现场开机或创建起飞任务触发上电 |
| 地图无机场 / 飞机 | 坐标来自物模型 `/device/{sn}/state`，需设备在线且已选择正确项目 |
| 媒体 URL 返回 403 | 媒体签名有效期约 24 小时。**每次使用前重新调用 media 接口取新签名，不要缓存 URL**；探测可用性用 `GET + Range: bytes=0-0`，不要用 `HEAD` |
| 影像读不出 GPS | DJI 机型不写标准 EXIF GPS，请用 `modules/asset/djiXmp.js` 解析 XMP；且必须用**原图**，缩略图已剥离元数据 |
| 航线上传失败 | 需已选择项目（STS 凭证按项目发放），文件为 .kmz，且压缩包内只含 `wpmz/template.kml` + `wpmz/waylines.wpml`（不要带 `__MACOSX/`、`.DS_Store`） |
| 飞行任务列表为空但确实飞过 | `/flight-task/list` 的 `sn` / `begin_at` / `end_at` 为**必填**，缺参数不报错但静默返回空列表。`sn` 用**机场 SN** |

---

## 已知边界

本项目聚焦「空中发现 → 业务闭环」，以下能力**不在 OpenAPI 范围内**，需通过其他途径实现：

| 能力 | 说明 |
|---|---|
| AI 算法接入 | 司空 2 OpenAPI 未开放算法下发与推理结果接口，AI 需自建后挂载到图斑模型 |
| 机载算法 | 需走大疆 PSDK / 行业应用 + 机载算力 |
| 航线规划 | 需在司空 2 或 Pilot 2 中完成，OpenAPI 只做上传 / 下载 / 执行 |
| 手动飞行控制 | 仅有实时指令下发与航线任务 |
| 远程开机 | 无此接口 |
| 飞行后自动建模 | 需在司空 2 侧触发 |

---

## 许可证

[MIT](./LICENSE)

本项目为独立实现，与 DJI 无隶属关系。大疆司空 2 / FlightHub 2 为大疆创新（DJI）旗下产品，其 API 能力边界以官方文档为准。
