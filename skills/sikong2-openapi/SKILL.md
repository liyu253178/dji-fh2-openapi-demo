---
name: 司空 2_open_api
description: 大疆司空 2（FlightHub 2 / DJI FlightHub 2）OpenAPI 二次开发总纲——鉴权（X-User-Token / X-Project-Uuid）、设备与物模型、控制权、图传直播、航线 KMZ 上下行、飞行任务记录、媒体下载、三维模型（3D Tiles / b3dm）预览，以及实测踩过的坑与修复方式。当用户提到司空2、司空 2、FlightHub 2、上云 API、es-flight-api、无人机管控平台、机场/机巢对接、KMZ 上传、航线下发、b3dm 解析时使用。直播专项排查可另见 dji-fh2-live-troubleshoot。
agent_created: true
---

# 司空 2 OpenAPI 二次开发

所有结论来自真实联调，**接口路径与枚举以官方文档 + 你自己的实测版本为准**，错误码是实测值、可能随版本变化。

## 0. 最小认知

| 项 | 值 |
|---|---|
| 公有云国内 | `https://es-flight-api-cn.djigate.com` |
| 公有云海外 | `https://es-flight-api-us.djigate.com` |
| 路径前缀 | `/openapi/v0.1`（**写路径时最容易漏**） |
| 请求头 | `X-User-Token`（组织 TK，JWT）、`X-Project-Uuid`、`X-Request-Id`、`X-Language` |
| 成功判据 | `code === 0` **且** HTTP 2xx —— 只看 `code` 会漏 |
| 响应 | 必须 `safeParse`：网关/登录页会返回 HTML，直接 `res.json()` 会抛 `Unexpected non-whitespace character after JSON` |

```js
// 统一网关：前缀自动补、非 JSON 不抛错、DELETE 支持带 body
const PREFIX = '/openapi/v0.1';
function buildUrl(path, query) {
  const p = path.startsWith('/openapi') ? path : PREFIX + (path.startsWith('/') ? path : '/' + path);
  /* ... */
}
```

## 1. 鉴权与组织切换（最容易埋雷）

- TK 是**组织密钥**，路径：司空 2 → 组织设置 → 云端互联 → 组织密钥。它是 JWT：

```js
// 不校验签名，只解 payload 做展示/校验
const json = Buffer.from(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8');
// payload: { user_id, organization_uuid, account, exp, ... }
```

- **复制不完整**（少了最后一段）会 200401，但语义是"token validation failed"，很容易误判成权限问题 → 前端录入时先 `decodeToken` 判空，直接提示"TK 不是合法 JWT，请检查是否复制完整"。
- **TK 与接入点不匹配**：国内 TK 打到 `us` 域名直接 200401。先切接入点再体检。
- **切换 TK / 项目必须清缓存**，否则设备列表"串味"（上一个组织的设备还在）：

```js
function invalidateOrgScoped() {
  invalidateTelemetry();
  clearCache('device:'); clearCache('state:');
  clearCache('wayline'); clearCache('task');
}
```

- 项目列表**不要用 `usage=simple`**，会漏项目；用分页全量 `?page=1&page_size=100`。
- 当前项目要持久化，否则重启后设备列表/物模型全空。

## 2. 设备、物模型与控制权

- `/device`（组织下）与 `/project/device`（项目下）不是一回事；设备**没绑项目**时物模型和地图位置都取不到，需绑：
  `PUT /openapi/v1.0/manage/api/v1/organizations/{org_uuid}/manage-devices/active-project`（注意这条是 **v1.0**，不是 v0.1，且不带 `X-Project-Uuid`）。
- `/device/{sn}/state` 返回 40+ 字段（height、horizontal_speed、attitude_head、battery、position…）。HUD 出现 `--` 时**先查项目是否选中**，不要先怀疑接口。
- 控制权：`POST /device/control` 获取，**释放是 `DELETE /device/control` + JSON Body**（`fetch` 默认不带 body，必须单独封装）。
  - `drone_sn` 必须是**飞行器 SN**，传机场 SN 报 Bad Request；
  - `payload_index` 必须是**数组**，如 `["81-0-0"]`。

## 3. 图传直播

```js
POST /openapi/v0.1/live-stream/start
{ sn, camera_index, video_expire, quality_type }
→ { url, url_type, expire_ts }
```

- `camera_index` **因设备而异**，必须从设备上报的 `camera_list` 解析（机场舱内/舱外、飞行器广角/变焦/红外各不同），别写死成某个"通用值"。
- `url_type` 有 `volc` / `agora` / `srs` / `demo`，供应商由司空 2 **动态选择**，前端要三引擎自适应；`url` 有时不是地址而是 `app_id=..&room_id=..&token=..` 参数串，要能解析。
- **计费红线**：官方文档说"没有拉流观众 5 分钟后将停止推流"——**这 5 分钟照样计费**。`video_expire` 才是唯一能自己掐的闸（别偷懒填 7200），页面关闭/无人观看时后端要主动调停止接口，并向用户说明停止有延迟。
- 常见错误码：

| code | 含义 |
|---|---|
| 213003 | 飞行器未开机，图传通道不存在（**司空 2 没有远程开机接口**，需先起飞任务或现场开机；此时只能看机场舱内相机） |
| 213002 | 直播路数达上限 |
| 213001 / 200610 | `camera_index` 无效或设备不支持该路 |
| 219014 | 设备不属于当前项目 |
| 200401 | TK 失效或无权限 |

## 4. 航线：下载 / 上传 / 下发

**下载**：`GET /wayline/{id}` 拿 `download_url`（签名有时效，每次都要重新取）→ **必须后端代理**给前端同域下载，否则 `window.open` 被拦、跨域无法 `download`。

```js
// 只写 filename*=UTF-8'' 时，部分下载器退化成无后缀文件名，
// 用户再上传就被 accept=".kmz" 挡住 —— 必须双写
res.set('Content-Disposition',
  `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
// Node 22：Readable.fromWeb(upstream.body).pipe(res)，不能直接 .pipe
```

**上传（STS 三步）**：

```
GET /project/sts-token → OSS PUT → POST /wayline/finish-upload → POST /flight-task
```

- STS 返回的 `region` 是**简写**（`hz`/`bj`/`sh`…），要映射成 `oss-cn-hangzhou` 这类标准 region，否则报"bucket 不存在"。
- `object_key` 必须拼 `object_key_prefix`。
- `resumable_status` 是必填枚举（`''` / `auto` / `manual`）。
- **非蛙跳任务不要传 `landing_dock_sn`**，会 200101。
- **KMZ 本质是 zip**，里面只允许 `wpmz/template.kml` + `wpmz/waylines.wpml`。macOS 打包带进去的 `__MACOSX/`、`.DS_Store` 会让上传成功但航线不可用。

## 5. 飞行任务记录

- `GET /flight-task/list` **必填 `sn` / `begin_at` / `end_at`（数字时间戳）**。
- **缺参数时不报错，返回 `code=0` + 空列表** —— 这是最大的坑，表现为"今天明明飞了却查不到"，很容易误判成接口坏了。
- `sn` 用**机场 SN**（不是飞行器 SN）。
- `task_type === 'others'`（`FlyToTask_*`）这类任务**没有航拍照片**，调 `/media` 会返回 219021。
- 架次/时长/里程要在自己这侧聚合，司空只给原始任务。

## 6. 媒体文件

- 照片/视频 URL 带 `auth_key` 签名，**每次调用重新签发**，前端不能缓存 → 走后端代理下载。

## 7. 三维模型预览（3D Tiles / b3dm）

- `GET /model` 拿模型列表 → 下载解压 → 找到根 `tileset.json`。
- **根 tileset 不能靠"第一个 `tileset*.json`"猜**：一个包里有 30 个 json、655 个 b3dm，根是外部 tileset（`BlockA/tileset.json`…）层层嵌套的入口。做法是把所有 tileset **按引用关系求差集**，没被别人引用的那个才是根；再对外部 tileset 多轮展开（并发 8、最多 10 轮）。否则只渲染出 10/655 块，看起来像"加载了但很糊"。
- **b3dm 不是"跳 28 字节就是 GLB"**：

```
b3dm = 28B 头 + featureTable(JSON+BIN) + batchTable(JSON+BIN) + 内嵌 GLB
头里偏移 12/16/20/24（小端）分别是 ftJson/ftBin/btJson/btBin 四个长度
start = 28 + ftJson + ftBin + btJson + btBin
```

```js
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const start = 28 + dv.getUint32(12, true) + dv.getUint32(16, true)
                  + dv.getUint32(20, true) + dv.getUint32(24, true);
const glb = buf.subarray(start);            // 注意 buf 若来自 slice()，byteOffset 非 0
```

- Draco 压缩（`KHR_draco_mesh_compression`）要挂 `DRACOLoader`。
- `gltfUpAxis: 'Z'` 的旋转**必须在 ECEF 变换之后**整体做（外层 group 旋转 `-π/2` X，内层 group 做 `-origin` 平移），每个 tile 各自转会导致模型散架。
- 司空产物的 `geometricError` 常常是 `1e10` 这种垃圾值，**不能用来做 LOD 判据**。改用屏幕投影像素：

```js
const pixels = (radius * viewportHeight) / (dist * 2 * Math.tan(fov / 2)); // 阈值 ~220px 则细分
```
- 配套上限：`MAX_LOADED=900`、`MAX_PARALLEL=8`；`mustRefine = hasChildren && !node.uri`（避免空洞）。
- 没有可渲染文件时降级成图片预览。

## 8. 前端呈现的几个细节

- Element Plus 暗色主题下 `stripe` 会让斑马纹看起来像"空行"，别用。
- Leaflet 自己带缩放按钮会和页面打架：`zoomControl: false`。
- 物模型字段 40+ 时按「运行信息 / 设备指标 / 舱内环境」分组展示，比平铺长列表好用得多。

## 9. 排查工具箱（先造轮子再调接口）

- 后端内置 **API 测试器**（`routes/admin.js` 里的接口清单 + 任意接口直连调试）+ 环形日志缓冲 + SSE 实时日志，能看原始 `code/message/耗时`。
- `server/scripts/probe-*.mjs` 一类探针脚本：单独验证相机列表、控制权、飞行任务参数、字段全集。**先 probe 再写业务**，比在 UI 上盲试快一个数量级。
- 回归测试脚本对关键链路做**数值断言**（如"LOD 细化后 tile 数 4 → 78"），不要只截图。

## 10. 交付 / 开源前必做

代码里最容易泄的是这几样，导出前统一脱敏（`tools/sanitize.mjs` + `tools/check-secrets.mjs`）：

| 类型 | 处理 |
|---|---|
| TK（JWT `eyJ...`） | 源码里**不要内置**，改成读 `FH2_TOKEN`；仓库只放 `.env.example` |
| 设备 SN、项目 UUID | 换成 `YOUR_DEVICE_SN` / `YOUR_PROJECT_UUID` 或走环境变量 |
| 客户名、真实坐标 | 从文档和脚本里删掉 |
| 截图 | 界面截图常带 SN 和客户名，直接不导出 |
| `server/data/tokens.json`、日志、测试报告 | 写进 `.gitignore` |

## 红线 / 别做

- 不要把 TK 写进前端、日志、截图、commit。
- 不要假设 `camera_index`、`url_type`、错误码是固定值——它们是**实测值**，随时可能变。
- 不要只判 `code === 0`，要同时看 HTTP 状态与响应体是否为 JSON。
- 不要指望 OpenAPI 能**画航线**：只有上传/下载/执行，规划必须在司空 2 或 Pilot 2 里做；同理也没有手动飞行控制、没有飞行后自动建模。

> 详细接口清单见 `references/api-cheatsheet.md`，错误码与现象对照见 `references/error-codes.md`。
