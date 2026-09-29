# 司空 2 OpenAPI 接口速查（实测）

Base：`https://es-flight-api-cn.djigate.com`（国内公有云）｜前缀：`/openapi/v0.1`
Headers：`X-User-Token` / `X-Project-Uuid` / `X-Request-Id` / `X-Language`

## 组织与项目

| 方法 | 路径 | 说明 / 坑 |
|---|---|---|
| GET | `/project` | 项目列表。**别用 `usage=simple`**（会漏项目），用 `page=1&page_size=100` |
| GET | `/device` | 组织下的设备（机场 + 飞行器） |
| GET | `/project/device` | 项目下的设备，需带 `X-Project-Uuid` |
| GET | `/system_status` | 连通性体检 |
| GET | `/project/sts-token` | 上传凭证 → `{ endpoint, bucket, region, credentials, object_key_prefix }`；`region` 是简写需映射 |
| PUT | `/openapi/v1.0/manage/api/v1/organizations/{org_uuid}/manage-devices/active-project` | **v1.0、不带项目头**；设备没绑项目时物模型/位置取不到 |

## 设备

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/device/{sn}/state` | 物模型全量状态（40+ 字段） |
| GET | `/device/hms` | HMS 异常 |
| POST | `/device/control` | 获取控制权；`drone_sn` **必须是飞行器 SN**，`payload_index` 是数组 |
| DELETE | `/device/control` | **释放控制权，DELETE + JSON Body** |
| POST | `/device/change-camera` | 切换相机 |
| POST | `/device/change-lens` | 切换镜头 |
| POST | `/device/stream/quality` | 图传清晰度 |
| POST | `/device/{sn}/command` | 实时指令（返航/暂停/恢复…） |

## 直播

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/live-stream/start` | 入参 `{ sn, camera_index, video_expire, quality_type }` → `{ url, url_type, expire_ts }` |

## 航线

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/wayline` | 航线列表 |
| GET | `/wayline/{id}` | 详情，取 `download_url`（签名时效短，每次重取） |
| POST | `/wayline/finish-upload` | `{ object_key, name }` |
| POST | `/flight-task` | 创建任务；`resumable_status` 必填（`''`/`auto`/`manual`）；非蛙跳别传 `landing_dock_sn` |

## 任务

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/flight-task/list` | **必填 `sn`/`begin_at`/`end_at`**，缺参静默返回空列表；`sn` 用机场 SN |
| GET | `/flight-task/{task_uuid}` | 详情 |
| PUT | `/flight-task/{task_uuid}/status` | 挂起 / 恢复 |
| GET | `/flight-task/{task_uuid}/media` | 媒体资源；`task_type === 'others'` 时返回 219021 |
| GET | `/flight-task/{task_uuid}/track` | 飞行轨迹 |

## 模型

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/model` | 模型列表 |

## 典型调用片段

```js
// 网关：自动补前缀 + 安全解析 + 超时
const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
const text = await res.text();
let parsed; try { parsed = JSON.parse(text); } catch { return { ok:false, message:'非 JSON 响应', raw:text.slice(0,200) }; }
const ok = Number(parsed.code) === 0 && res.ok;
```

```js
// 时间范围：秒级时间戳
const end = Math.floor(Date.now() / 1000);
const begin = end - 7 * 86400;
request({ path:'/flight-task/list', query:{ sn: dockSn, begin_at: begin, end_at: end } });
```
