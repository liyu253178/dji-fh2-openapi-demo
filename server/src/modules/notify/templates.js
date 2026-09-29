/**
 * 邮件模板
 *
 * ⚠️ 合规红线：全模板只用「疑似」，绝不用「违法」「违规」定性。
 *    是否违法、如何处置须由专业人员依据法规、审批材料与执法流程判定，
 *    平台只负责把「空中发现」转成「可核查的线索」并派发下去。
 *
 * 占位符格式：{{key}}
 */

import { formatArea } from '../review/geo.js';

/** 主题模板 */
const SUBJECTS = {
  TPL_DISPATCH: '【低空巡查问题线索】{{admin_region}}{{issue_type_name}}{{ticket_no}}（限期{{deadline}}）',
  TPL_REMIND: '【低空巡查催办】{{ticket_no}} 已超期{{overdue_days}}天',
  TPL_REVIEW: '【低空巡查复核】{{ticket_no}} 请复核整改结果',
};

/** 通用样式：内联 CSS，兼容 Outlook / QQ 邮箱 / 163 邮箱 */
const STYLE = `
  body { margin:0; padding:0; background:#f5f7fa; font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:680px; margin:0 auto; padding:24px 16px; }
  .card { background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,.06); }
  .hd { background:#0f4c81; color:#fff; padding:20px 24px; }
  .hd h1 { margin:0; font-size:18px; font-weight:600; }
  .hd p { margin:6px 0 0; font-size:13px; opacity:.9; }
  .bd { padding:24px; }
  .sec { margin-bottom:22px; }
  .sec-t { font-size:14px; font-weight:600; color:#0f4c81; border-left:3px solid #0f4c81; padding-left:8px; margin:0 0 10px; }
  .kv { font-size:13px; line-height:1.9; color:#333; }
  .kv b { color:#555; font-weight:500; }
  .box { background:#f7f9fb; border:1px solid #e6ebf0; border-radius:6px; padding:12px 14px; font-size:13px; line-height:1.9; color:#333; }
  .warn { background:#fff8e6; border:1px solid #ffe0a3; border-radius:6px; padding:12px 14px; font-size:13px; color:#7a5b00; line-height:1.8; }
  .btn { display:inline-block; background:#0f4c81; color:#fff !important; text-decoration:none; padding:10px 22px; border-radius:6px; font-size:14px; }
  .ft { padding:16px 24px; background:#fafbfc; border-top:1px solid #eef1f4; font-size:12px; color:#8a97a3; line-height:1.8; }
  .tag { display:inline-block; background:#eef4fa; color:#0f4c81; border-radius:4px; padding:2px 8px; font-size:12px; }
  table.img { width:100%; border-collapse:collapse; margin-top:8px; }
  table.img td { padding:4px; vertical-align:top; }
  table.img img { width:100%; border-radius:4px; border:1px solid #e6ebf0; display:block; }
  .cap { font-size:11px; color:#98a4ae; padding-top:4px; text-align:center; }
`;

function layout({ title, subtitle, bodyHtml, footer }) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div class="wrap"><div class="card">
  <div class="hd"><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>
  <div class="bd">${bodyHtml}</div>
  <div class="ft">${footer}</div>
</div></div>
<style>${STYLE}</style>
</body></html>`;
}

/** 转义，防止内容里的尖括号破坏 HTML */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 构建模板上下文
 * @param {object} p
 * @param {object} p.ticket 工单（ticketRepo.parse 结果）
 * @param {object} p.patch 图斑
 * @param {object} p.recipient 派发对象
 * @param {object} p.images 关联影像（含 mailPath / fileName）
 * @param {object} p.config 邮件配置
 * @param {object} [p.locatorPng] 位置示意图的 data URI
 */
export function buildContext({ ticket, patch, recipient, images = [], config, locatorPng = '' }) {
  const daysLeft = ticket.daysLeft ?? null;
  return {
    ticket_no: ticket.ticketNo,
    issue_type_name: ticket.issueTypeName,
    admin_region: patch?.adminRegion || '',
    village: patch?.village || '',
    position_desc: patch?.positionDesc || '',
    lat: patch?.lat ?? '',
    lon: patch?.lon ?? '',
    area: patch?.areaM2 ? formatArea(patch.areaM2) : '',
    area_m2: patch?.areaM2 ?? '',
    land_type: patch?.landType || '未填写',
    is_permanent_farmland: patch?.isPermanentFarmland ? '是' : '否',
    planning_use: patch?.planningUse || '',
    approval_no: patch?.approvalNo || '',
    patch_title: patch?.title || '',
    patch_desc: patch?.description || '',
    discovered_at: patch?.reviewedAt ? String(patch.reviewedAt).slice(0, 16).replace('T', ' ') : '',
    deadline: ticket.deadline || '',
    days_left: daysLeft === null ? '' : daysLeft,
    overdue_days: daysLeft !== null && daysLeft < 0 ? Math.abs(daysLeft) : 0,
    // 影像依据
    device_model: images[0]?.droneModel || 'Matrice 4TD',
    flight_altitude: images[0]?.altitudeRel ? `${Math.round(images[0].altitudeRel)} 米` : '',
    gps_quality: images[0]?.gpsStatus === 'RTK' ? 'RTK（厘米级）' : images[0]?.gpsStatus || '未知',
    image_count: images.length,
    // 落款与链接
    org_name: config?.orgName || '低空智能监管平台',
    org_contact: config?.orgContact || '',
    contact_name: recipient?.contact || '',
    platform_url: config?.platformUrl || '',
    ticket_url: `${config?.platformUrl || ''}/#/tickets/${ticket.id}`,
    recipient_name: recipient?.name || '',
    recipient_address: recipient?.addressDesc || '',
  };
}

/** 渲染：替换 {{key}} */
export function render(tpl, ctx) {
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    const v = ctx[k];
    return v === undefined || v === null || v === '' ? '' : v;
  });
}

/**
 * 首次派发邮件
 * @param {object} ctx buildContext 的结果
 * @param {object} opts
 * @param {Array<{name:string, dataUri?:string, path?:string}>} opts.attachments 附件（用于正文内嵌展示）
 */
export function renderDispatch(ctx, opts = {}) {
  const subject = render(SUBJECTS.TPL_DISPATCH, ctx);
  const imgs = opts.attachments || [];

  const imgCards = imgs
    .map(
      (a, i) => `<td width="50%">
        ${a.dataUri ? `<img src="${a.dataUri}" alt="影像${i + 1}">` : `<div style="height:120px;background:#f0f3f6;border-radius:4px"></div>`}
        <div class="cap">${esc(a.name)}${a.caption ? ` · ${esc(a.caption)}` : ''}</div>
      </td>`
    )
    .join('');

  const rows = imgs.length
    ? Array.from({ length: Math.ceil(imgs.length / 2) })
        .map((_, r) => `<tr>${imgCards.slice(r * 2, r * 2 + 2)}</tr>`)
        .join('')
    : '<tr><td colspan="2" class="cap">无影像附件</td></tr>';

  const bodyHtml = `
  <div class="sec">
    <p class="sec-t">一、问题定位</p>
    <div class="box kv">
      <b>所属区域：</b>${esc(ctx.admin_region)} ${esc(ctx.village)}<br>
      <b>位置描述：</b>${esc(ctx.position_desc)}<br>
      <b>经纬度：</b>${esc(ctx.lat)}, ${esc(ctx.lon)}
    </div>
  </div>

  <div class="sec">
    <p class="sec-t">二、线索描述</p>
    <div class="box kv">
      <b>线索类型：</b><span class="tag">${esc(ctx.issue_type_name)}</span><br>
      <b>涉及范围：</b>${esc(ctx.area || '未估算')}<br>
      <b>当前地类：</b>${esc(ctx.land_type)}${ctx.is_permanent_farmland === '是' ? '（涉及永久基本农田）' : ''}<br>
      ${ctx.planning_use ? `<b>规划用途：</b>${esc(ctx.planning_use)}<br>` : ''}
      ${ctx.approval_no ? `<b>审批手续号：</b>${esc(ctx.approval_no)}<br>` : ''}
      <b>发现时间：</b>${esc(ctx.discovered_at)}
    </div>
    ${ctx.patch_desc ? `<div class="box" style="margin-top:8px">${esc(ctx.patch_desc)}</div>` : ''}
  </div>

  <div class="sec">
    <p class="sec-t">三、影像依据</p>
    <div class="box kv" style="margin-bottom:10px">
      <b>拍摄设备：</b>${esc(ctx.device_model)}　<b>飞行高度：</b>${esc(ctx.flight_altitude)}<br>
      <b>定位质量：</b>${esc(ctx.gps_quality)}　<b>影像数量：</b>${ctx.image_count} 张
    </div>
    <table class="img">${rows}</table>
    ${ctx.locatorPng ? `<div style="margin-top:10px"><img src="${ctx.locatorPng}" alt="位置示意图"><div class="cap">图斑位置示意图（底图为示意，非影像底图）</div></div>` : ''}
  </div>

  <div class="sec">
    <p class="sec-t">四、需处理事项</p>
    <div class="warn">
      请核实上述区域是否存在「${esc(ctx.issue_type_name)}」情形，
      并于 <b>${esc(ctx.deadline)}</b> 前将核实与处置结果反馈至本平台。<br>
      本条为<b>低空巡查发现的疑似线索</b>，不作为违法定性依据；
      是否违法、如何处置须依据法规、审批材料与现场核查结果由主管部门认定。
    </div>
  </div>

  <div class="sec">
    <p class="sec-t">五、反馈方式</p>
    <p class="kv" style="margin:0 0 12px">
      <a class="btn" href="${esc(ctx.ticket_url)}">登录平台处理</a>
    </p>
    <div class="box kv">
      也可以直接回复本邮件反馈处理结果。<br>
      ${ctx.org_contact ? `<b>咨询：</b>${esc(ctx.org_contact)}<br>` : ''}
      <b>工单编号：</b>${esc(ctx.ticket_no)}　<b>处理时限：</b>${esc(ctx.deadline)}${ctx.days_left !== '' && Number(ctx.days_left) >= 0 ? `（剩余 ${ctx.days_left} 天）` : ''}
    </div>
  </div>`;

  const html = layout({
    title: '低空巡查问题线索派发',
    subtitle: `${ctx.admin_region} · ${ctx.issue_type_name} · ${ctx.ticket_no}`,
    bodyHtml,
    footer: `
      本邮件由 ${esc(ctx.org_name)} 自动发送，请勿直接回复。<br>
      工单编号 ${esc(ctx.ticket_no)}｜当前状态：已派发｜派发单位：${esc(ctx.recipient_name)}<br>
      本邮件内容为低空巡查发现的<b>疑似线索</b>，不构成违法事实认定。
    `,
  });
  return { subject, html };
}

/** 催办邮件（预留） */
export function renderRemind(ctx) {
  const subject = render(SUBJECTS.TPL_REMIND, ctx);
  const bodyHtml = `
  <div class="sec">
    <p class="sec-t">催办提醒</p>
    <div class="warn">
      工单 <b>${esc(ctx.ticket_no)}</b>（${esc(ctx.admin_region)} ${esc(ctx.issue_type_name)}）
      反馈时限为 <b>${esc(ctx.deadline)}</b>，目前已超期 <b>${esc(ctx.overdue_days)}</b> 天尚未提交处置结果。<br>
      请尽快核实处置，并登录平台反馈：<a class="btn" href="${esc(ctx.ticket_url)}">立即处理</a>
    </div>
  </div>`;
  return {
    subject,
    html: layout({
      title: '低空巡查问题线索催办',
      subtitle: ctx.ticket_no,
      bodyHtml,
      footer: `本邮件由 ${esc(ctx.org_name)} 自动发送。`,
    }),
  };
}

export const TEMPLATE_IDS = Object.keys(SUBJECTS);
