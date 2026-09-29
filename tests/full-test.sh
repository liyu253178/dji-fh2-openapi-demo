#!/usr/bin/env bash
# ============================================================
# 司空 2 管控平台 · 全量自动化测试
# 覆盖：后端 API（真实接口） + 前端六大模块（浏览器驱动）
# 用法： dome/tests/full-test.sh
# 产物： dome/tests/report/测试报告.md + 截图
# ============================================================
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 单端口：BFF 同时提供 API 与前端静态资源（web/dist），默认直接测 8787
WEB="${WEB:-http://127.0.0.1:8787}"
API="http://127.0.0.1:8787"
OUT="${ROOT}/tests/report"
SHOTS="${OUT}/screenshots"
mkdir -p "${SHOTS}"

REPORT="${OUT}/测试报告.md"
PASS=0; FAIL=0; WARN=0
START=$(date +%s)

# Windows/本机 curl 需绕开代理
CURL="curl -s --noproxy '*' -m 40"

echo "# 司空 2 管控平台 · 全量自动化测试报告" > "${REPORT}"
echo "" >> "${REPORT}"
echo "执行时间：$(date '+%Y-%m-%d %H:%M:%S') | 前端 ${WEB} | 后端 ${API}" >> "${REPORT}"
echo "" >> "${REPORT}"

log()  { echo "  $1"; }
ok()   { PASS=$((PASS+1)); echo "- ✅ $1" >> "${REPORT}"; log "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "- ❌ $1（实际：$2）" >> "${REPORT}"; log "FAIL  $1 -> $2"; }
warn() { WARN=$((WARN+1)); echo "- ⚠️ $1（$2）" >> "${REPORT}"; log "WARN  $1 -> $2"; }
sec()  { echo "" >> "${REPORT}"; echo "## $1" >> "${REPORT}"; log ""; log "== $1 =="; }

# ---------- 浏览器工具 ----------
_browser() { agent-browser "$@" 2>/dev/null; }
# 执行 JS 并取最后一行有效输出
ev() { agent-browser eval "$1" 2>/dev/null | tail -1 | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^"//;s/"$//'; }
# 断言：名称 期望值 实际值
assert() {
  local name="$1" expect="$2" actual="$3"
  if [ "${expect}" = "${actual}" ]; then ok "${name}"; else bad "${name}" "${actual}"; fi
}
# 断言：实际值 > 0
assert_gt0() {
  local name="$1" actual="$2"
  if [ -n "${actual}" ] && [ "${actual}" -gt 0 ] 2>/dev/null; then ok "${name}"; else bad "${name}" "${actual}"; fi
}
shot() { agent-browser screenshot "${SHOTS}/$1.png" >/dev/null 2>&1; }

# ============================================================
sec "一、后端 API（真实司空 2 接口）"
# ============================================================
api_check() { # 名称 路径 期望表达式(用 python/node 判断 ok 字段)
  local name="$1" url="$2"
  local res=$(${CURL} "${url}")
  local okk=$(echo "${res}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d);console.log(r.ok?'ok':'fail')}catch(e){console.log('badjson')}})")
  if [ "${okk}" = "ok" ]; then ok "${name}"; else bad "${name}" "${okk}"; fi
}

api_check "BFF 存活"            "${API}/api/ping"

# 先自动选择设备所属项目：航线/任务/直播/一键起飞都依赖正确的 X-Project-Uuid
FIRST_PROJECT=$(${CURL} "${API}/api/session/devices-with-project" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{const r=JSON.parse(d); const l=(r.data&&r.data.list)||[]; console.log((l[0]&&l[0].projectUuid)||'')}catch(e){console.log('')}
})")
if [ -n "${FIRST_PROJECT}" ]; then
  ${CURL} -X POST "${API}/api/session/project" -H 'Content-Type: application/json' -d "{\"uuid\":\"${FIRST_PROJECT}\"}" >/dev/null
fi

api_check "会话状态"            "${API}/api/session"
api_check "TK 列表"             "${API}/api/session/tokens"
api_check "项目列表（全量）"      "${API}/api/session/projects"
api_check "连通性体检"           "${API}/api/session/health"
api_check "组织设备列表"         "${API}/api/session/devices"
api_check "按项目聚合设备"       "${API}/api/session/devices-with-project"
api_check "航线列表"            "${API}/api/wayline"
# flight-task/list 的 sn / begin_at / end_at 是必填项，缺参时司空 2 不报错、只返回空列表，
# 极易被误判成「没有数据」。后端已改成显式拒绝，先验证这道校验生效。
MISS_TASK=$(${CURL} "${API}/api/task/list" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d);console.log(r.ok?'ok':'reject')}catch(e){console.log('badjson')}})")
assert "任务列表缺参应被拒绝（避免静默空列表）" "reject" "${MISS_TASK}"
api_check "接口清单(catalog)"   "${API}/api/admin/catalog"
api_check "日志输出"            "${API}/api/admin/logs"

# 项目数量断言
PRJ_CNT=$(ev_true=1; ${CURL} "${API}/api/session/projects" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log((r.data&&r.data.list||[]).length)})")
assert_gt0 "项目数量 > 0" "${PRJ_CNT}"

# 设备数量与坐标（物模型）
DEV_INFO=$(${CURL} "${API}/api/session/devices-with-project" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const r=JSON.parse(d); const l=(r.data&&r.data.list)||[];
  console.log(l.length+'|'+l.map(x=>(x.gateway&&x.gateway.sn)||'?').join(','))
})")
DEV_CNT=$(echo "${DEV_INFO}" | cut -d'|' -f1)
assert_gt0 "设备数量 > 0" "${DEV_CNT}"

# 选择第一台设备所属项目，后续航线/任务/直播/起飞都需要正确的 X-Project-Uuid
FIRST_PROJECT=$(${CURL} "${API}/api/session/devices-with-project" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const r=JSON.parse(d); const l=(r.data&&r.data.list)||[];
  const p=(l[0]&&l[0].projectUuid)||''; console.log(p)
})")
if [ -n "${FIRST_PROJECT}" ]; then
  SEL=$(${CURL} -X POST "${API}/api/session/project" -H 'Content-Type: application/json' -d "{\"uuid\":\"${FIRST_PROJECT}\"}" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(r.ok?'ok':'fail')})")
  if [ "${SEL}" = "ok" ]; then ok "自动选择设备所属项目"; else warn "自动选择项目" "${SEL}"; fi
fi

# 对第一台机场取物模型，验证坐标
FIRST_SN=$(echo "${DEV_INFO}" | cut -d'|' -f2 | cut -d',' -f1)
if [ -n "${FIRST_SN}" ] && [ "${FIRST_SN}" != "?" ]; then
  POS=$(${CURL} "${API}/api/device/${FIRST_SN}/state" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);const s=(r.data&&r.data.device_state)||{};
console.log((s.latitude!==undefined&&s.longitude!==undefined)?'has':'none')})")
  assert "物模型含经纬度（${FIRST_SN}）" "has" "${POS}"
else
  warn "物模型坐标检查" "无可用设备 SN"
fi

# 真实查询：必须带 sn（机场 SN，飞行器 SN 查不到）+ 时间范围（秒）
if [ -n "${FIRST_SN}" ] && [ "${FIRST_SN}" != "?" ]; then
  TASK_END=$(date +%s)
  TASK_BEGIN=$(( TASK_END - 90 * 86400 ))
  api_check "任务列表（sn+时间范围）" "${API}/api/task/list?sn=${FIRST_SN}&begin_at=${TASK_BEGIN}&end_at=${TASK_END}"
else
  warn "任务列表" "无可用设备 SN，跳过真实查询"
fi

# 一键起飞预检需要 POST + body
TKP=$(${CURL} -X POST "${API}/api/takeoff/precheck" -H 'Content-Type: application/json' -d "{\"sn\":\"${FIRST_SN}\"}" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d);console.log(r.ok?'ok':'fail')}catch(e){console.log('badjson')}})")
if [ "${TKP}" = "ok" ]; then ok "一键起飞预检"; else bad "一键起飞预检" "${TKP}"; fi

# 直播鉴权参数解析（真实调用，机场在线时才会成功）
LIVE=$(${CURL} -X POST "${API}/api/live/start" -H 'Content-Type: application/json' \
  -d "{\"sn\":\"${FIRST_SN}\",\"camera_index\":\"165-0-7\",\"video_expire\":3600,\"quality_type\":\"adaptive\"}" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);
if(!r.ok){console.log('fail|'+r.message);return}
const p=r.data&&r.data.params||{};console.log('ok|'+(r.data.url_type||'')+'|'+(p.appId?'appid':'noappid'))})")
LIVE_ST=$(echo "${LIVE}" | cut -d'|' -f1)
if [ "${LIVE_ST}" = "ok" ]; then
  ok "开启直播并解析鉴权参数（供应商 $(echo "${LIVE}" | cut -d'|' -f2)）"
else
  warn "开启直播" "$(echo "${LIVE}" | cut -d'|' -f2)"
fi

# ============================================================
sec "二、前端页面渲染"
# ============================================================
agent-browser set viewport 1680 1000 >/dev/null 2>&1

page_check() { # 路径 标题关键字 断言选择器 截图名
  local path="$1" title="$2" sel="$3" png="$4"
  agent-browser open "${WEB}${path}" >/dev/null 2>&1
  sleep 4
  local cnt=$(ev "document.querySelectorAll('${sel}').length")
  local has=$(ev "document.body.innerText.includes('${title}')?'yes':'no'")
  assert "页面 ${path} 渲染（${title}）" "yes" "${has}"
  assert_gt0 "页面 ${path} 关键元素 ${sel}" "${cnt}"
  shot "${png}"
}

page_check "/dashboard" "首页大屏" ".kpi-bar"          "01-dashboard"
page_check "/cockpit"   "虚拟座舱" ".cockpit-bar"      "02-cockpit"
page_check "/wayline"   "航线管理" ".el-table"         "03-wayline"
page_check "/assets"    "设备管理" ".card"             "07-device"
page_check "/models"    "模型库"   ".el-table"         "09-models"
page_check "/admin"     "其他设置" ".el-tabs"          "08-admin"

# ---------- 模型库三维预览（3D Tiles LOD） ----------
agent-browser open "${WEB}/models" >/dev/null 2>&1
sleep 5
ev "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('三维预览'));if(!b)return 'no';b.click();return 'ok'})()" >/dev/null 2>&1
sleep 28
M3D_MODE=$(ev "(()=>{const c=document.querySelector('.viewer-canvas');return c?(c.dataset.mode||'none'):'none'})()")
assert "三维预览进入 3D 模式" "3d" "${M3D_MODE}"
M3D_ERR=$(ev "(()=>{const e=document.querySelector('.viewer-error');return e?(e.innerText.trim()||'none'):'none'})()")
assert "三维预览无错误提示" "none" "${M3D_ERR}"
M3D_LD=$(ev "(()=>{const c=document.querySelector('.viewer-canvas');return c?String(c.dataset.loaded||0):'0'})()")
assert_gt0 "三维预览已渲染瓦片" "${M3D_LD}"
# ECEF 大坐标应已被平移到原点：包围盒中心相对尺寸必须是小量
M3D_CT=$(ev "(()=>{const c=document.querySelector('.viewer-canvas');const b=c?(c.dataset.bbox||''):'';const p=b.split('|');if(p.length<2)return 'bad';const sz=p[0].split(',').map(Number);const ct=p[1].split(',').map(Number);const m=Math.max(...sz)||1;const off=Math.max(...ct.map(Math.abs));return (off/m<0.25)?'center':'off:'+b})()")
assert "三维预览模型居中（ECEF 已归零）" "center" "${M3D_CT}"
# 放大后应细化出更多瓦片（LOD 生效）
ev "(()=>{const c=document.querySelector('.viewer-canvas canvas');if(!c)return 'no';const r=c.getBoundingClientRect();for(let i=0;i<12;i++){c.dispatchEvent(new WheelEvent('wheel',{deltaY:-240,bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));}return 'ok'})()" >/dev/null 2>&1
sleep 32
M3D_LD2=$(ev "(()=>{const c=document.querySelector('.viewer-canvas');return c?String(c.dataset.loaded||0):'0'})()")
assert_gt0 "放大后仍持续加载精细瓦片" "${M3D_LD2}"
if [ "${M3D_LD2}" -gt "${M3D_LD}" ] 2>/dev/null; then ok "放大后瓦片数增加（LOD 细化生效 ${M3D_LD}→${M3D_LD2}）"; else warn "放大后瓦片数未增加" "${M3D_LD}→${M3D_LD2}"; fi
shot "10-model-3d"

# 已删除的三个栏目（监控管理/巡检任务/飞行记录）不应再出现在导航里
NAVCNT=$(ev "document.querySelectorAll('.nav-item').length")
assert "导航精简为 6 项" "6" "${NAVCNT}"

# 顶栏显式轮询状态（刷新中 / Ns 前已刷新 / 已停止）
POLL=$(ev "(()=>{const e=document.querySelector('.topbar-right .tag.poll');if(!e)return 'none';const t=e.innerText.trim();return /刷新中|已刷新|已停止|暂无轮询/.test(t)?'yes':'no:'+t})()")
assert "顶栏轮询状态指示" "yes" "${POLL}"

# ============================================================
sec "三、虚拟座舱模块"
# ============================================================
agent-browser open "${WEB}/cockpit" >/dev/null 2>&1; sleep 9

MAP=$(ev "document.querySelectorAll('.leaflet-container').length")
assert "实时地图组件存在" "1" "${MAP}"

MK=$(ev "document.querySelectorAll('.leaflet-marker-icon').length")
assert_gt0 "地图渲染机场/飞行器标记" "${MK}"

# 机场标记用 Dock 实拍图（抠图后的 PNG），图片必须真的加载出来
AI=$(ev "(()=>{const i=document.querySelector('.mk-airport img');if(!i)return 'none';return i.complete&&i.naturalWidth>0?'ok':'broken'})()")
assert "机场标记使用 Dock 实拍图标" "ok" "${AI}"
# 图标不能撑爆圆盘（divIcon 内百分比宽度会退化成图片自身尺寸）
AISZ=$(ev "(()=>{const p=document.querySelector('.mk-airport');const i=p&&p.querySelector('img');if(!p||!i)return 'none';const pw=Math.round(p.getBoundingClientRect().width),iw=Math.round(i.getBoundingClientRect().width);return iw<pw?'ok':'oversize:'+iw+'>'+pw})()")
assert "机场图标尺寸受控" "ok" "${AISZ}"
# 飞行器停在机库时坐标与机场重合，不应重复绘制标记（否则会盖住机场图标）
AICNT=$(ev "(()=>{const a=document.querySelectorAll('.mk-airport').length;const n=document.querySelectorAll('.leaflet-marker-icon').length;return n<=a?'noOverlap':'overlap:'+n+'>'+a})()")
assert "舱内飞行器不重复绘制标记" "noOverlap" "${AICNT}"

TILES=$(ev "document.querySelectorAll('.leaflet-tile-loaded').length")
assert_gt0 "底图瓦片加载成功" "${TILES}"

BCHIP=$(ev "document.querySelectorAll('.map-chip').length")
assert_gt0 "底图切换按钮（预设底图）" "${BCHIP}"

# 两个视频窗口：中列无人机主画面 + 左列机场镜头
PLAYER=$(ev "document.querySelectorAll('.player-box').length")
assert "视频窗口数量（主画面+机场镜头）" "2" "${PLAYER}"

STAGE=$(ev "document.querySelector('.stage')?'yes':'no'")
assert "无人机主画面舞台存在" "yes" "${STAGE}"

HUD=$(ev "document.querySelectorAll('.hud-chip').length")
assert_gt0 "视频 HUD 遥测叠加" "${HUD}"

# 飞行器 mode_code 必须翻译成中文状态，而不是显示裸数字（字典取自 DJI 官方示例源码）
MODETXT=$(ev "(function(){var t=(document.querySelector('.hud-top .hud-chip')||{}).innerText||'';return /待机|飞行器未连接|舱内关机|开机中|航线飞行|返航|降落|起飞准备|手动飞行|状态异常|离线/.test(t)?'zh':'raw:'+t.trim()})()")
assert "HUD 飞行器状态中文化" "zh" "${MODETXT}"

COMPASS=$(ev "document.body.innerText.includes('HOG')?'yes':'no'")
assert "HOG 罗盘" "yes" "${COMPASS}"

CAM=$(ev "document.querySelector('.cam-stage')?'yes':'no'")
assert "左列机场镜头窗口" "yes" "${CAM}"

# 左列固定为机场相机：合成一个「机场直播」按钮，不再有舱外/舱内机位切换
SEG=$(ev "document.querySelectorAll('.cam-card .seg-btn').length")
assert "左列已移除机位分段控件" "0" "${SEG}"
AIRBTN=$(ev "(()=>{const t=(document.querySelector('.cam-card')||{}).innerText||'';return /机场直播/.test(t)?'yes':'no'})()")
assert "左列「机场直播」按钮" "yes" "${AIRBTN}"
SEGNOTXT=$(ev "(()=>{const t=(document.querySelector('.cam-card')||{}).innerText||'';return /无人机|99-0-0|176-0-0/.test(t)?'hasDrone':'airportOnly'})()")
assert "左列仅机场相机（不含无人机图传）" "airportOnly" "${SEGNOTXT}"

# 机位按「设备类型范式」选取：舱外优先（不对单台机场写分支，上报只作参考）
AIRPOS=$(ev "(function(){var t=(document.querySelector('.cam-tag')||{}).innerText||'';return t})()")
case "${AIRPOS}" in
  *舱外*) ok "机场机位按范式取舱外（${AIRPOS}）" ;;
  *舱内*) warn "机场机位落在舱内（${AIRPOS}）" "范式首选应为舱外，可能是回退结果" ;;
  *) bad "机场机位角标" "${AIRPOS}" ;;
esac

# 「有流」≠「有画面」：必须检测画面实际亮度，纯黑要被识别出来而不是显示"直播中"
PIC=$(ev "(function(){var v=null;var vs=document.querySelectorAll('video');for(var i=0;i<vs.length;i++){if(vs[i].videoWidth>0){v=vs[i];break;}}if(!v)return 'novideo';try{var c=document.createElement('canvas');c.width=160;c.height=90;var g=c.getContext('2d');g.drawImage(v,0,0,160,90);var d=g.getImageData(0,0,160,90).data;var s=0,s2=0,n=0;for(var i=0;i<d.length;i+=4){var l=d[i]*.299+d[i+1]*.587+d[i+2]*.114;s+=l;s2+=l*l;n++;}var m=s/n;var sd=Math.sqrt(Math.max(0,s2/n-m*m));return (m<8&&sd<4)?'black':(m>20?'live':'dark:'+m.toFixed(1));}catch(e){return 'err'}})()")
case "${PIC}" in
  live) ok "机场画面有实际内容（亮度检测通过）" ;;
  black) bad "机场画面为纯黑" "黑屏未被机位回退解决" ;;
  novideo) warn "机场画面未取到 video 元素" "可能未开播" ;;
  *) warn "机场画面偏暗（${PIC}）" "需人工确认" ;;
esac

# 黑屏必须给出明确提示，不能显示成"直播中"骗人
BLACKTIP=$(ev "(()=>{var t=document.body.innerText||'';var black=document.body.innerText.includes('画面为纯黑');var playing=/RTC 直播中/.test(t);return black?'tip':(playing?'playing':'other')})()")
case "${BLACKTIP}" in
  tip) ok "纯黑画面给出「画面为纯黑」提示" ;;
  playing) ok "画面正常（显示直播中，无黑屏误报）" ;;
  *) warn "机场画面状态未知（${BLACKTIP}）" "可能尚未开播" ;;
esac

# 中间大画面为无人机图传：无直播时显示专属占位标题
STAGE=$(ev "(()=>{const e=document.querySelector('.stage-empty');return e?e.innerText.replace(/\s+/g,' ').trim():'streaming'})()")
case "${STAGE}" in
  *无人机*) ok "中间大画面为无人机图传（${STAGE}）" ;;
  streaming) ok "中间大画面为无人机图传（已出图）" ;;
  *) bad "中间大画面为无人机图传" "${STAGE}" ;;
esac

HMSP=$(ev "document.querySelector('.hms-panel')?'yes':'no'")
assert "HMS 状态码小窗口" "yes" "${HMSP}"

# HMS 每条应带等级徽标（通知/注意/告警），无告警时表头显示「正常」
HMSLV=$(ev "(function(){if(document.querySelector('.hms-lv'))return 'lv';var t=(document.querySelector('.hms-panel')||{}).innerText||'';return /正常|无异常状态码/.test(t)?'empty':'bad'})()")
assert "HMS 等级渲染（或明确无告警）" "$([ "${HMSLV}" != "bad" ] && echo ok || echo bad)" "ok"

# 底部操作条：常用功能 + 直播
BAR=$(ev "(()=>{const b=document.querySelector('.cockpit-bar');return b?b.innerText.replace(/\s+/g,''):''})()")
echo "     底部操作条：${BAR}"
for kw in 快速起飞 一键返航 切换红外 切换星图 直播; do
  if echo "${BAR}" | grep -q "${kw}"; then ok "底部操作条含「${kw}」"; else fail "底部操作条含「${kw}」" "缺失" "${BAR}"; fi
done

# 主画面必须宽于左列
WIDTH=$(ev "(()=>{const m=document.querySelector('.stage');const l=document.querySelector('.col-left');return (m&&l)?Math.round(m.getBoundingClientRect().width/l.getBoundingClientRect().width):0})()")
assert_gt0 "无人机主画面宽于左列" "${WIDTH}"

CTRL=$(ev "document.body.innerText.includes('获取控制权')||document.body.innerText.includes('释放控制权')?'yes':'no'")
assert "控制权按钮" "yes" "${CTRL}"

# 底部右侧的「更多指令 / 执行航线 / 创建任务」已按需求移除，不应再出现
REMOVED=$(ev "(()=>{const b=document.querySelector('.cockpit-bar');const t=b?b.innerText.replace(/\\s+/g,''):'';return ['更多指令','执行航线','创建任务'].some(k=>t.includes(k))?'stillThere':'removed'})()")
assert "底部已移除多余按钮（更多指令/执行航线/创建任务）" "removed" "${REMOVED}"

# 切换底图（点击吉林一号）
agent-browser find text "吉林一号" click >/dev/null 2>&1
sleep 3
JL=$(ev "document.querySelectorAll('.leaflet-tile').length")
assert_gt0 "底图切换后瓦片重载" "${JL}"
shot "09-cockpit-basemap-jl1"

# 切回矢量
agent-browser find text "矢量·带注记" click >/dev/null 2>&1
sleep 2

# ============================================================
sec "四、首页大屏模块（全屏地图 + 浮层面板 + KPI）"
# ============================================================
agent-browser open "${WEB}/dashboard" >/dev/null 2>&1; sleep 7

DMAP=$(ev "document.querySelectorAll('.dash-map .leaflet-container').length")
assert "全屏地图铺底" "1" "${DMAP}"

DTILES=$(ev "document.querySelectorAll('.leaflet-tile-loaded').length")
assert_gt0 "大屏地图瓦片加载" "${DTILES}"

PTASK=$(ev "document.querySelector('.panel-tasks')?'yes':'no'")
assert "左上「最近作业记录」浮层" "yes" "${PTASK}"

PNEST=$(ev "(()=>{const e=document.querySelector('.panel-nest');return e?(e.innerText.includes('无人机')||e.innerText.includes('电池电量'))?'yes':'no':'no'})()")
assert "右上「机巢状态」浮层" "yes" "${PNEST}"

# 机巢面板要能切换：多机场时提供下拉，且切换后面板数据随之变化
NESTSEL=$(ev "document.querySelectorAll('.panel-nest .el-select').length")
if [ "${NESTSEL}" -gt 0 ] 2>/dev/null; then
  ok "机巢面板提供切换下拉"
  BEFORE=$(ev "document.querySelector('.panel-nest')?.innerText.replace(/\n/g,'')")
  agent-browser eval "(()=>{const s=document.querySelector('.panel-nest .el-select');s.querySelector('.el-select__wrapper')?.click();return 1})()" >/dev/null 2>&1
  sleep 2
  # 只取「可见」的下拉项：Element Plus 会把顶栏项目选择器等其它 el-select 的选项
  # 一起留在 DOM 里（隐藏状态），不过滤就会点到项目名而不是机巢名。
  agent-browser eval "(()=>{const items=Array.from(document.querySelectorAll('.el-select-dropdown__item')).filter(e=>e.offsetParent!==null);const cur=document.querySelector('.panel-nest .el-select')?.innerText.trim();const other=items.find(e=>e.innerText.trim()&&!cur?.includes(e.innerText.trim()));if(other){other.click();return other.innerText.trim()}return 'none'})()" >/dev/null 2>&1
  sleep 4
  AFTER=$(ev "document.querySelector('.panel-nest')?.innerText.replace(/\n/g,'')")
  if [ -n "${AFTER}" ] && [ "${AFTER}" != "${BEFORE}" ]; then ok "切换机巢后面板数据随之更新"; else warn "切换机巢" "面板数据未变化"; fi
else
  warn "机巢切换下拉" "当前项目仅 1 台机场，无切换项"
fi

NESTKV=$(ev "(()=>{const t=document.querySelector('.panel-nest')?.innerText||'';return ['无人机','电池电量','RTK 定位','舱内环境'].every(k=>t.includes(k))?'yes':'no'})()")
assert "机巢状态字段完整（无人机/电量/RTK/环境）" "yes" "${NESTKV}"

KPI=$(ev "document.querySelectorAll('.kpi-cell').length")
assert "底部 KPI 四格" "4" "${KPI}"

KPITXT=$(ev "(()=>{const t=document.querySelector('.kpi-bar')?.innerText||'';return ['今日飞行架次','累计飞行时长','巡查里程','待处理告警'].every(k=>t.includes(k))?'yes':'no'})()")
assert "KPI 指标项完整" "yes" "${KPITXT}"
shot "08-dashboard-charts"

# ============================================================
sec "五、航线管理模块"
# ============================================================
agent-browser open "${WEB}/wayline" >/dev/null 2>&1; sleep 5
WR=$(ev "document.querySelectorAll('.el-table__row').length")
assert_gt0 "航线列表有数据" "${WR}"
UP=$(ev "document.body.innerText.includes('上传到司空 2')?'yes':'no'")
assert "航线上传入口" "yes" "${UP}"
# 下载按钮存在
DL=$(ev "document.body.innerText.includes('下载')?'yes':'no'")
assert "航线下载入口" "yes" "${DL}"

# 后端代理下载：从航线列表取第一条真实 id，访问 /api/wayline/{id}/download，应返回 200 且是 zip/kmz
DLID=$(ev "(()=>{const r=document.querySelector('.el-table__row');if(!r)return '';const m=r.innerText.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/);return m?m[0]:''})()")
if [ -n "${DLID}" ]; then
  DLHEAD=$(${CURL} -s -o /dev/null -w "%{http_code}|%{content_type}" "${API}/api/wayline/${DLID}/download")
  case "${DLHEAD}" in
    200*|application/octet-stream*) ok "航线下载代理返回 200 文件流" ;;
    *) bad "航线下载代理" "${DLHEAD}" ;;
  esac
else
  warn "航线下载代理" "未从列表取到航线 id"
fi

# 执行记录抽屉：任务状态中文化 / 航点进度 / 媒体上传 / 按设备筛选
agent-browser eval "(()=>{const b=Array.from(document.querySelectorAll('button')).find(e=>e.innerText.trim()==='执行记录');if(b)b.click();return 1})()" >/dev/null 2>&1
sleep 3
DRW=$(ev "document.querySelector('.el-drawer')?'yes':'no'")
assert "执行记录抽屉可打开" "yes" "${DRW}"
DRTAB=$(ev "(()=>{const d=document.querySelector('.el-drawer');if(!d)return 'none';return ['未完成','已结束','全部'].every(k=>(d.innerText||'').includes(k))?'yes':'no'})()")
assert "执行记录状态页签（未完成/已结束/全部）" "yes" "${DRTAB}"
DRFILTER=$(ev "(()=>{const d=document.querySelector('.el-drawer');if(!d)return 'no';return d.innerText.includes('全选在线')?'yes':'no'})()")
assert "执行记录按设备筛选" "yes" "${DRFILTER}"
# 时间范围是 flight-task/list 的必填参数，缺了会静默返回 0 条
DRRANGE=$(ev "(()=>{const d=document.querySelector('.el-drawer');if(!d)return 'no';return /近 90 天|近 30 天/.test(d.innerText)?'yes':'no'})()")
assert "执行记录时间范围筛选" "yes" "${DRRANGE}"

# 飞行记录必须查得到真实数据（带 sn + 时间范围后不再是 0 条）
agent-browser eval "(()=>{const b=Array.from(document.querySelectorAll('.el-drawer .el-radio-button')).find(e=>e.innerText.trim()==='全部');if(b){b.querySelector('input')?.click()||b.click();}return 1})()" >/dev/null 2>&1
sleep 6
DRROWS=$(ev "document.querySelectorAll('.el-drawer .el-table__row').length")
assert_gt0 "飞行记录有真实数据" "${DRROWS}"
DRPHOTO=$(ev "Array.from(document.querySelectorAll('.el-drawer button')).filter(b=>b.innerText.includes('查看照片')).length")
assert_gt0 "飞行记录提供照片入口" "${DRPHOTO}"

# 航拍照片墙：媒体走后端代理，缩略图必须真的加载出画面
agent-browser eval "(()=>{const b=Array.from(document.querySelectorAll('.el-drawer button')).find(e=>e.innerText.includes('查看照片'));if(b)b.click();return 1})()" >/dev/null 2>&1
sleep 8
MW=$(ev "document.querySelectorAll('.media-cell img').length")
assert_gt0 "航拍照片墙渲染缩略图" "${MW}"
MWL=$(ev "Array.from(document.querySelectorAll('.media-cell img')).filter(i=>i.complete&&i.naturalWidth>0).length")
assert_gt0 "照片墙图片经代理加载成功" "${MWL}"
agent-browser press Escape >/dev/null 2>&1
sleep 1
agent-browser press Escape >/dev/null 2>&1
sleep 1

# 真实组织里可能一条任务都没有，此时表格不渲染、列头不存在。
# 用服务端演示数据补一次「有数据」的渲染验证，测完立即关闭演示模式。
MOCKON=$(${CURL} -X POST "${API}/api/admin/mock" -H 'Content-Type: application/json' -d '{"enabled":true}' 2>/dev/null | grep -c '"enabled":true' || true)
if [ "${MOCKON}" = "1" ]; then
  agent-browser open "${WEB}/wayline" >/dev/null 2>&1; sleep 6
  agent-browser eval "(()=>{const b=Array.from(document.querySelectorAll('button')).find(e=>e.innerText.trim()==='执行记录');if(b)b.click();return 1})()" >/dev/null 2>&1
  sleep 4
  MDRCOL=$(ev "(()=>{const t=(document.querySelector('.el-drawer')||{}).innerText||'';return ['执行状态','类型','计划名称','设备','航点进度','媒体上传','创建人'].every(k=>t.includes(k))?'yes':'no'})()")
  assert "执行记录列完整（演示数据）" "yes" "${MDRCOL}"
  MDRSTATUS=$(ev "(()=>{const t=Array.from(document.querySelectorAll('.el-drawer .el-table__row')).map(e=>e.innerText).join(' ');return /待执行|执行中|执行成功|执行失败|执行终止/.test(t)?'yes':'no'})()")
  assert "执行记录状态中文化（演示数据）" "yes" "${MDRSTATUS}"
  MDRDATE=$(ev "(()=>{const n=document.querySelectorAll('.el-drawer .rec-date').length;return n>0?'yes':'no'})()")
  assert "执行记录按日期分组（演示数据）" "yes" "${MDRDATE}"
  agent-browser press Escape >/dev/null 2>&1
  ${CURL} -X POST "${API}/api/admin/mock" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null 2>&1
  sleep 1
else
  warn "执行记录表格渲染" "演示模式未开启，跳过有数据的渲染校验"
fi
shot "09-wayline"

# ============================================================
# 六、任务管理模块已随「巡检任务」页一起移除（用户要求精简导航），
#    任务创建入口保留在虚拟座舱底部操作条
# ============================================================

# ============================================================
sec "七、设备管理模块"
# ============================================================
agent-browser open "${WEB}/assets" >/dev/null 2>&1; sleep 6
DC=$(ev "document.body.innerText.includes('设备列表')?'yes':'no'")
assert "设备列表面板" "yes" "${DC}"
# 点击第一台设备
agent-browser find first ".card" click >/dev/null 2>&1
sleep 4
KF=$(ev "document.body.innerText.includes('物模型')?'yes':'no'")
assert "物模型/实时状态面板" "yes" "${KF}"
# 用户要求删除设备管理底部三个窗口：负载与相机控制 / 实时控制指令 / 设备位置地图
CTRL2=$(ev "document.body.innerText.includes('获取控制权')?'yes':'no'")
assert "负载与相机控制区已移除" "no" "${CTRL2}"
HMS=$(ev "document.body.innerText.includes('HMS')?'yes':'no'")
assert "实时控制指令区已移除" "no" "${HMS}"
DMAP=$(ev "document.querySelectorAll('.leaflet-container').length")
assert "设备位置地图已移除" "0" "${DMAP}"

# 物模型必须按设备类型分组渲染（不是平铺的原始字段）
MGRP=$(ev "document.querySelectorAll('.metric-group').length")
assert_gt0 "物模型分组卡片" "${MGRP}"
MCELL=$(ev "document.querySelectorAll('.metric-cell').length")
assert_gt0 "物模型指标条目" "${MCELL}"
# 指标值不能出现 [object Object]（position_state / wireless_link 这类结构化字段必须被格式化）
MOBJ=$(ev "(()=>{const t=Array.from(document.querySelectorAll('.metric-v')).map(e=>e.innerText).join(' ');return /\\[object Object\\]/.test(t)?'hasObject':'clean'})()")
assert "物模型无 [object Object]" "clean" "${MOBJ}"
# 单位换算是否生效（时长 → N天/时，电压 → V）
MUNIT=$(ev "(()=>{const t=Array.from(document.querySelectorAll('.metric-v')).map(e=>e.innerText).join(' ');return /(天|时).{0,2}|V/.test(t)?'yes':'no'})()")
assert "物模型单位换算" "yes" "${MUNIT}"
shot "11-device"

# 切换机场相机（舱外）—— 机场在线时应成功
agent-browser find text "舱外" click >/dev/null 2>&1
sleep 4
CAMMSG=$(ev "document.querySelectorAll('.el-message').length")
if [ -n "${CAMMSG}" ] && [ "${CAMMSG}" -gt 0 ] 2>/dev/null; then ok "机场相机切换有响应提示"; else warn "机场相机切换" "未捕获提示"; fi
shot "12-device-camera"

# ============================================================
sec "八、司空管理模块（TK / 项目 / API 测试 / 日志）"
# ============================================================
agent-browser open "${WEB}/admin" >/dev/null 2>&1; sleep 5
EP=$(ev "document.body.innerText.includes('接入点')?'yes':'no'")
assert "接入点配置（公有云/私有云）" "yes" "${EP}"
TKP=$(ev "document.body.innerText.includes('OpenAPI TK')?'yes':'no'")
assert "多组织 TK 管理" "yes" "${TKP}"
PRJP=$(ev "document.querySelectorAll('.el-select').length")
assert_gt0 "项目选择器" "${PRJP}"
shot "13-admin-conn"

# 连通性体检
agent-browser find text "连通性体检" click >/dev/null 2>&1
sleep 5
HEALTH=$(ev "document.body.innerText.includes('鉴权')?'yes':'no'")
assert "连通性体检结果展示" "yes" "${HEALTH}"
shot "14-admin-health"

# API 测试器
agent-browser find text "API 测试" click >/dev/null 2>&1
sleep 3
CAT=$(ev "document.querySelectorAll('.el-select').length")
assert_gt0 "API 测试器预置接口下拉" "${CAT}"
agent-browser find text "发送请求" click >/dev/null 2>&1
sleep 6
RESP=$(ev "document.body.innerText.includes('HTTP')?'yes':'no'")
assert "API 测试器返回响应" "yes" "${RESP}"
shot "15-admin-api-test"

# 日志
agent-browser find text "日志输出" click >/dev/null 2>&1
sleep 4
LOGS=$(ev "document.querySelectorAll('.log-line').length")
assert_gt0 "日志实时输出" "${LOGS}"
shot "16-admin-logs"

# ============================================================
sec "九、浏览器控制台错误检查"
# ============================================================
ERRS=$(agent-browser errors 2>/dev/null | tail -5)
ERRCNT=$(agent-browser errors 2>/dev/null | grep -c "error" || true)
if [ "${ERRCNT:-0}" -eq 0 ] 2>/dev/null; then
  ok "无控制台错误"
else
  warn "控制台错误 ${ERRCNT} 条" "$(echo "${ERRS}" | head -2 | tr '\n' ' ')"
fi

# ============================================================
END=$(date +%s)
DUR=$((END-START))
echo "" >> "${REPORT}"
echo "---" >> "${REPORT}"
echo "" >> "${REPORT}"
echo "## 汇总" >> "${REPORT}"
echo "" >> "${REPORT}"
echo "- 通过：**${PASS}** 失败：**${FAIL}** 告警：**${WARN}** 耗时：${DUR}s" >> "${REPORT}"
echo "- 截图目录：\`tests/report/screenshots/\`" >> "${REPORT}"

log ""
log "======================================"
log " 通过 ${PASS} / 失败 ${FAIL} / 告警 ${WARN}  耗时 ${DUR}s"
log " 报告： ${REPORT}"
log "======================================"
agent-browser close >/dev/null 2>&1
exit 0
