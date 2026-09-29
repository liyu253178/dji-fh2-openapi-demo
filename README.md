# 大疆司空 2 无人机管理与控制平台

基于 **大疆司空 2 OpenAPI V1.0**（Apifox 文档：<https://fh2-api.apifox.cn/llms.txt> ）开发的无人机管理与控制平台。  
架构设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

> ⚠️ **这是一个「可演示 / 可试用」的原型项目**，不是生产级系统：大屏里部分执行记录仍是演示数据、机场相机切换提示未接住、没有手动飞行控制、飞行后自动建模也没做。接口路径与枚举值请以官方文档和你自己实测的版本为准。
>
> 🔒 **本仓库已做脱敏**：不包含任何真实 TK、设备 SN、项目 UUID、客户名称与坐标。启动前请自备司空 2 组织密钥，详见下方「安全与脱敏」。

## 功能模块

| 模块    | 能力                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------ |
| 虚拟座舱  | 机场/飞行器选择、**获取/释放控制权**、实时直播（机场舱内·舱外相机、飞行器广角/变焦/红外）、作业地图（机场/飞机实时位置 + 底图切换）、航线选择执行、实时控制指令（返航/暂停/恢复）、图传清晰度 |
| 可视化大屏 | 设备统计、状态分布、近 7 日任务趋势、设备分布地图、设备清单                                                                        |
| 航线管理  | 航线列表、**上传（STS→存储桶→上传通知）**、**下载**、一键创建立即任务                                                              |
| 任务管理  | 任务列表/筛选、详情、挂起/恢复、媒体资源、飞行轨迹地图                                                                           |
| 设备管理  | 物模型实时状态、HMS 异常、控制权、相机/镜头/清晰度控制、实时指令、设备位置地图                                                             |
| 司空管理  | **OpenAPI TK 多组织切换**、接入点切换（公有云国内/海外/私有云自定义）、项目选择、连通性体检、**API 测试器**（任意接口直连调试）、实时日志输出                    |

## 快速启动

```bash
# 1. 启动后端 BFF（端口 8787）
cd server
npm install
npm run dev

# 2. 启动前端（端口 5173）
cd web
npm install
npm run dev

# 3. 浏览器打开 http://localhost:5173
```

> **TK 需要你自己提供**，仓库里没有任何内置密钥。两种方式二选一：
>
> 1. 启动后在 **司空管理 → 添加 TK** 里粘贴（司空 2「组织设置 → 云端互联 → 组织密钥」），可保存多个 TK 并随时切换组织；
> 2. 启动时用环境变量注入：
>
> ```bash
> FH2_TOKEN=你的组织密钥 npm run dev
> ```
>
> 其它可选环境变量见 [.env.example](./.env.example)。没有 TK 时平台会以「演示模式」启动（接口走本地 mock 数据）。

## 安全与脱敏

本仓库在导出前做了统一脱敏，脚本保留在 `tools/`：

```bash
node tools/sanitize.mjs        # 批量替换 JWT / 设备 SN / 项目 UUID 为 YOUR_XXX 占位符
node tools/check-secrets.mjs   # 扫描残留敏感信息，有问题时以非 0 退出（可挂进 CI / pre-commit）
```

脱敏范围包括：`server/src/store.js` 里硬编码的 TK 已移除（改为只读 `FH2_TOKEN`）、`server/scripts/probe-*.mjs` 中的设备 SN 与项目 UUID、`ARCHITECTURE.md` 中的组织 UUID / 客户名 / 坐标、以及所有可能带 SN 与客户名的截图。

**仍然建议你在公开仓库前再自查一遍**：`.gitignore` 已排除 `server/data/`（含 `tokens.json`）、`docs/api/`、`tests/report/`、`node_modules/`、`web/dist/` 与 `.env*`；如果你本地跑过项目，别把 `server/data/` 手动提交上去。

## 使用流程（严格按序）

1. **司空管理 → 连接**：确认接入点（公有云国内 / 海外 / 私有云自定义），点击「连通性体检」。
2. **添加 TK**：粘贴司空 2「组织设置 → 云端互联 → 组织密钥」，可保存多个 TK 随时切换组织。
3. **选择项目**：顶栏或司空管理页选择项目（`X-Project-Uuid`）。
4. 进入虚拟座舱/设备管理操作设备；进入航线/任务管理执行任务。

## 常见问题排查

| 现象                                                | 处理                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `200401 Unauthorized` / `token validation failed` | TK 与接入点不匹配：在「司空管理 → 接入点」切换 国内/海外/私有云 后重新体检；或在司空 2 重新生成组织密钥后更新 TK                                                          |
| 控制权获取 `Bad Request`                               | `drone_sn` 必须是**飞行器 SN**（不是机场 SN），`payload_index` 必须是数组，如 `["81-0-0"]`                                                    |
| 控制权释放 `internal server error`                     | 释放接口是 **DELETE + JSON Body**（本平台已按文档实现）；确认释放的 payload 与获取时一致                                                              |
| 直播播放失败                                            | 司空 2 动态选择直播供应商（volc / agora / srs），本平台三引擎自适应；在「司空管理 → API 测试」直连 `/openapi/v0.1/live-stream/start` 查看原始 `url_type` 与 `url` |
| 地图无机场/飞机                                          | 坐标来自物模型 `/device/{sn}/state`，需设备在线；飞行器未起飞时显示 Home 点                                                                       |
| 航线上传失败                                            | 需已选择项目（STS 凭证按项目发放），且文件为 .kmz/.kml                                                                                        |

## 技术栈

- 前端：Vue 3 + Vite + Pinia + Vue Router + Element Plus + Leaflet（高德/吉林一号瓦片，WGS84→GCJ02 纠偏）+ ECharts
- 播放器：`@volcengine/rtc`（火山）· `agora-rtc-sdk-ng`（声网）· 原生 WebRTC WHEP（SRS），按司空 2 返回的 `url_type` 自适应
- 后端：Node.js + Express，统一注入 `X-User-Token / X-Project-Uuid / X-Request-Id / X-Language`，非 JSON 响应安全归一化（不再出现 `Unexpected non-whitespace character after JSON` 类报错）
- 航线上传：`ali-oss` + STS 临时凭证 + `wayline/finish-upload` 通知

---

# 架构 V2：一网统飞 · 无人机巡检政务平台

重构方案见 [docs/ARCHITECTURE-v2.md](./docs/ARCHITECTURE-v2.md)（依据《大疆司空 2 使用说明》+ OpenAPI 能力边界 + 政务一网统飞业务模型）。

## 信息架构（重构后）

| 路由           | 页面       | 说明                            |
| ------------ | -------- | ----------------------------- |
| `/monitor`   | 飞行监控（首屏） | 地图为核：机场/飞行器实时位置、设备态势、最优机巢推荐   |
| `/cockpit`   | 虚拟座舱     | 直播（舱内/舱外 + 镜头）、控制权、遥测、指令、航线执行 |
| `/wayline`   | 航线库      | 列表、上传（STS）、下载、下发为计划           |
| `/plan`      | 计划库      | 任务列表/创建/状态机/媒体/轨迹             |
| `/data`      | 数据中心     | 任务媒体归集、轨迹、模型与标注说明             |
| `/assets`    | 设备资产     | 机场/飞行器台账、物模型、HMS、控制           |
| `/dashboard` | 监管大屏     | 架次/里程/时长/在线率/成功率等政务指标         |
| `/admin`     | 系统管理     | TK 与接入点、项目、API 测试器、日志、演示模式    |

## 后端分层（重构后）

```
routes/    薄路由：契约与校验
services/  领域服务：telemetry（遥测聚合+状态归一化+缓存）· device · wayline · task · live（供应商自适应）
           stats（监管指标）· scheduler（最优机巢推荐 + 巡检编排）
infra/     djiClient 网关 · cache(TTL) · events(SSE) · logger · store(TK) · mock
```

新增接口：

```
GET  /api/ops/snapshot          统一遥测快照（监控/座舱/大屏复用，TTL 8s）
POST /api/ops/snapshot/refresh  强制刷新
GET  /api/ops/overview          监管总览（设备/飞行/资源/趋势）
POST /api/ops/recommend-nest    最优机巢推荐 {lat,lng,minBattery}
POST /api/ops/plan              批量巡检编排 {targets}
GET  /api/events/stream         领域事件 SSE（设备上下线）
GET  /api/ops/cache             缓存运维
```

回归测试：`./tests/full-test.sh`（覆盖后端 API + 八大模块浏览器驱动断言）。
