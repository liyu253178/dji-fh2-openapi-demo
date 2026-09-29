/**
 * TK 仓库：支持多组织 OpenAPI TK 持久化，用于快速切换司空 2 组织
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { decodeToken, mask } from './djiClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'tokens.json');

/**
 * 默认 TK 只从环境变量读取。
 * 仓库不内置任何真实密钥：首次启动请在平台「其他设置 → OpenAPI TK」里自行录入，
 * 或启动时通过环境变量注入：FH2_TOKEN=xxx node src/index.js
 */
const seedToken = process.env.FH2_TOKEN || '';

const state = {
  tokens: [],
  activeId: '',
  /** 当前选中的司空 2 项目（持久化，避免服务重启后设备列表/物模型全部丢失） */
  activeProjectUuid: '',
};

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    const seed = seedToken
      ? [
          {
            id: randomUUID(),
            name: '默认组织（环境变量）',
            token: seedToken,
            createdAt: Date.now(),
          },
        ]
      : [];
    fs.writeFileSync(FILE, JSON.stringify({ tokens: seed, activeId: seed[0]?.id || '' }, null, 2), 'utf8');
  }
}

export function load() {
  ensure();
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state.tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
    state.activeId = raw.activeId || '';
    state.activeProjectUuid = raw.activeProjectUuid || '';
  } catch {
    state.tokens = [];
  }
  return state;
}

function save() {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
}

export function listTokens() {
  return state.tokens.map((t) => ({
    id: t.id,
    name: t.name,
    masked: mask(t.token),
    orgUuid: decodeToken(t.token)?.organization_uuid || '',
    account: decodeToken(t.token)?.account || '',
    exp: decodeToken(t.token)?.exp || 0,
    createdAt: t.createdAt,
    active: t.id === state.activeId,
  }));
}

export function addToken(name, token) {
  const exist = state.tokens.find((t) => t.token === token);
  if (exist) {
    exist.name = name || exist.name;
    state.activeId = exist.id;
    save();
    return exist;
  }
  const item = { id: randomUUID(), name: name || '未命名组织', token, createdAt: Date.now() };
  state.tokens.push(item);
  state.activeId = item.id;
  save();
  return item;
}

export function removeToken(id) {
  state.tokens = state.tokens.filter((t) => t.id !== id);
  if (state.activeId === id) state.activeId = state.tokens[0]?.id || '';
  save();
}

export function getToken(id) {
  if (!id) return state.tokens.find((t) => t.id === state.activeId)?.token || '';
  return state.tokens.find((t) => t.id === id)?.token || '';
}

export function setActive(id) {
  state.activeId = id;
  save();
}

export function getActiveId() {
  return state.activeId;
}

export function updateName(id, name) {
  const t = state.tokens.find((x) => x.id === id);
  if (t) {
    t.name = name;
    save();
  }
}

/** 当前选中项目（持久化）：服务重启后设备列表 / 物模型不丢 */
export function getActiveProject() {
  return state.activeProjectUuid || '';
}

export function setActiveProject(uuid) {
  state.activeProjectUuid = uuid || '';
  save();
}
