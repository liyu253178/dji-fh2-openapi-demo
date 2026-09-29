# 司空 2 OpenAPI 错误码与现象对照（实测值，可能随版本变化）

## 通用

| code | 现象 | 真因 / 处理 |
|---|---|---|
| 200401 | `Unauthorized` / `token validation failed` | TK 失效、**复制不完整**、或 TK 与接入点不匹配（国内 TK 打到 us 域名）→ 重新生成组织密钥并检查是否三段完整 |
| 200101 | 参数无效 | 常见于多传了不该传的字段，如非蛙跳任务传了 `landing_dock_sn` |
| 200610 / 2006101 | 参数不合规 | `camera_index` 无效、设备未上报该路相机、必填项为空 |
| 非 JSON 响应 | `Unexpected non-whitespace character after JSON` | 网关/鉴权页返回 HTML；用 `text()` + `safeParse`，把原文片段打到日志 |
| `code=0` 但列表为空 | 明明有数据却查不到 | **参数缺失的静默失败**，典型是 `flight-task/list` 少了 `sn`/`begin_at`/`end_at` |

## 直播

| code | 现象 | 处理 |
|---|---|---|
| 213003 | 飞行器开播失败 | 飞行器未开机，图传通道不存在。**司空 2 无远程开机接口** → 先创建起飞任务让机场开舱上电，或看机场舱内相机 |
| 213002 | 开播失败 | 直播路数达上限，先停掉其他路 |
| 213001 | 开播失败 | 当前设备不支持该 `camera_index` → 从 `camera_list` 重新解析 |
| 219014 | 开播失败 | 设备不属于当前项目，切换项目后重试 |

## 任务与媒体

| code | 现象 | 处理 |
|---|---|---|
| 219021 | 任务媒体拉取失败 | 该任务是 `task_type === 'others'`（`FlyToTask_*`），**本来就没有航拍照片**，前端应提前屏蔽入口而不是报错 |

## 模型 / 对象存储（走的是司空签发的 OSS 直链）

| code / 现象 | 真因 / 处理 |
|---|---|
| `NoSuchKey`（HTTP 404，响应体是 `application/xml`） | **源文件在对象存储里已不存在**，司空 2 里记录还在（size 也还在）。多半是包被清理或当初就没生成成功 → 只能在司空 2 重新生成/重新上传。代码层面重试无用，但**要先排除签名问题再下结论** |
| `AccessDenied` / `SignatureDoesNotMatch`（403） | 签名链接过期或被改写 → 重新取一次模型详情拿新签名重试（实测签名有效期约 24h，远长于本地详情缓存 5min，所以过期很少见，但重试成本极低） |
| 用 `HEAD` 探测签名直链返回 403 | 阿里云 OSS 对签名 URL 的 HEAD 经常不给过，**别用 HEAD 判断可用性**，改用 `GET` + `Range: bytes=0-0`，看 200/206 |
| "下载失败：CDN 返回 404" | 这是把原因吞掉的坏报错。应该解析 XML 里的 `<Code>/<Message>` 再翻译成人话 |

```js
// 可用性预检：1 字节就知道文件在不在、多大，不用下整包
const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
const total = Number((r.headers.get('content-range') || '').split('/')[1] || 0);
```

## 前端/集成侧现象（不是司空的错）

| 现象 | 真因 |
|---|---|
| HUD 高度/速度全 `--` | 项目未选中（不是接口没对接），先查 `X-Project-Uuid` |
| 切换 TK 后设备列表"串味" | 设备树/遥测缓存没清，切 TK 与切项目都要 `invalidateOrgScoped()` |
| 上传航线成功但下发失败 | KMZ 里混了 `__MACOSX/`、`.DS_Store`；或 `region` 简写没映射 |
| 航线下载下来没后缀 | `Content-Disposition` 只写了 `filename*=UTF-8''`，要 ASCII 回退双写 |
| 三维模型只显示一小块 / 缩放不变清晰 | 取了错误的根 tileset；外部 tileset 没递归展开 |
| 模型散架 / 躺在地上 | Z-up 旋转加在了单个 tile 上，应该在 ECEF 变换之后对整体 group 旋转 `-π/2` |
| LOD 完全不生效 | 用了司空产物里 `1e10` 的 `geometricError`，应改用屏幕投影像素 |
| 暗色表格像有空行 | Element Plus `stripe` 在暗色主题下的视觉问题，去掉即可 |
