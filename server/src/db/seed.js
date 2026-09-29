/**
 * 种子数据
 *
 * 幂等：已存在的 code 不覆盖（避免业务方在界面上改过后被启动流程冲掉）。
 * 派发对象为空时插入示例数据，业务方可在界面上改成真实邮箱。
 */

import { all, get, run, insert, scalar } from './index.js';
import { log } from '../logger.js';

const now = () => new Date().toISOString();

/**
 * 问题类型字典
 *
 * 默认时限参考自然资源巡查常见处置周期，可按实际业务调整。
 * require_area / require_land_type 会驱动审核表单的必填校验。
 */
const ISSUE_TYPES = [
  {
    code: 'ILLEGAL_BUILD',
    name: '疑似违法建设',
    defaultOrg: '乡镇 → 执法大队',
    defaultDays: 7,
    requireArea: 1,
    requireLandType: 1,
    sortOrder: 1,
  },
  {
    code: 'OCCUPY_FARMLAND',
    name: '疑似占用耕地',
    defaultOrg: '乡镇',
    defaultDays: 3,
    requireArea: 1,
    requireLandType: 1,
    sortOrder: 2,
  },
  {
    code: 'OCCUPY_ROAD',
    name: '疑似占道经营',
    defaultOrg: '城管 / 乡镇',
    defaultDays: 3,
    requireArea: 0,
    requireLandType: 0,
    sortOrder: 3,
  },
  {
    code: 'DUMP_WASTE',
    name: '疑似垃圾堆放',
    defaultOrg: '环卫 / 乡镇',
    defaultDays: 3,
    requireArea: 1,
    requireLandType: 0,
    sortOrder: 4,
  },
  {
    code: 'BARE_SOIL',
    name: '疑似裸土未覆盖',
    defaultOrg: '住建 / 乡镇',
    defaultDays: 5,
    requireArea: 1,
    requireLandType: 0,
    sortOrder: 5,
  },
  {
    code: 'ILLEGAL_AD',
    name: '疑似违规广告',
    defaultOrg: '城管',
    defaultDays: 5,
    requireArea: 0,
    requireLandType: 0,
    sortOrder: 6,
  },
  {
    code: 'DUST',
    name: '疑似工地扬尘',
    defaultOrg: '住建',
    defaultDays: 3,
    requireArea: 0,
    requireLandType: 0,
    sortOrder: 7,
  },
  {
    code: 'FARM_RECLAIM',
    name: '疑似复耕不到位',
    defaultOrg: '农业农村',
    defaultDays: 15,
    requireArea: 1,
    requireLandType: 1,
    sortOrder: 8,
  },
];

/** 派发对象示例（请在界面改成真实单位与邮箱） */
const RECIPIENTS = [
  { name: 'XX街道办事处', contact: '李四', phone: '138xxxx', email: 'lisi@example.gov.cn', adminRegion: '宝安区', addressDesc: '宝安区XX路1号' },
  { name: 'XX镇人民政府', contact: '王五', phone: '139xxxx', email: 'wangwu@example.gov.cn', adminRegion: '宝安区', addressDesc: '宝安区XX镇政府大院' },
  { name: 'XX乡人民政府', contact: '赵六', phone: '137xxxx', email: 'zhaoliu@example.gov.cn', adminRegion: '宝安区', addressDesc: '宝安区XX乡政府' },
];

/** 写入问题类型（跳过已存在的） */
function seedIssueTypes() {
  let added = 0;
  const ts = now();
  for (const t of ISSUE_TYPES) {
    const exist = get('SELECT code FROM issue_type WHERE code = @code', { code: t.code });
    if (exist) continue;
    insert('issue_type', {
      code: t.code,
      name: t.name,
      default_org: t.defaultOrg,
      default_days: t.defaultDays,
      require_area: t.requireArea,
      require_land_type: t.requireLandType,
      sort_order: t.sortOrder,
      enabled: 1,
      created_at: ts,
      updated_at: ts,
    });
    added++;
  }
  return added;
}

/** 写入派发对象（仅当表为空时插示例，避免覆盖业务方录入的数据） */
function seedRecipients() {
  const n = scalar('SELECT COUNT(*) AS n FROM recipient');
  if (n > 0) return 0;
  const ts = now();
  let added = 0;
  for (const r of RECIPIENTS) {
    insert('recipient', {
      name: r.name,
      contact: r.contact,
      phone: r.phone,
      email: r.email,
      admin_region: r.adminRegion,
      address_desc: r.addressDesc,
      active: 1,
      created_at: ts,
      updated_at: ts,
    });
    added++;
  }
  return added;
}

/**
 * 执行种子（幂等，可在每次启动时调用）
 * @param {object} opts
 * @param {boolean} [opts.withSampleRecipients] 是否插入示例派发对象（默认 true；生产可关）
 */
export function seed(opts = {}) {
  const { withSampleRecipients = true } = opts;
  const types = seedIssueTypes();
  const recipients = withSampleRecipients ? seedRecipients() : 0;
  if (types || recipients) {
    log.ok('DB', `种子数据：新增 ${types} 个问题类型、${recipients} 个派发对象`);
  }
  return { issueTypes: types, recipients };
}

/** 字典是否已初始化（启动时可据此决定要不要播报提示） */
export function dictReady() {
  return {
    issueTypes: scalar('SELECT COUNT(*) AS n FROM issue_type WHERE enabled = 1'),
    recipients: scalar('SELECT COUNT(*) AS n FROM recipient WHERE active = 1'),
  };
}
