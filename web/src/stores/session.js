/**
 * 全局会话：接入点 / TK / 项目 / 设备树 / 物模型缓存
 * 切换 TK 或项目后，设备与物模型自动失效重载
 */
import { defineStore } from 'pinia';
import { sessionApi } from '../api/dji';

export const useSessionStore = defineStore('session', {
  state: () => ({
    loading: false,
    connected: false,
    masked: '',
    decoded: null,
    base: '',
    endpoint: 'cn',
    customBase: '',
    endpoints: {},
    tokens: [],
    projects: [],
    projectUuid: '',
    projectName: '',
    airports: [],
    drones: [],
    /** 地面站 / 中继站：公有云不返回，私有化设备树出现时自动填充 */
    baseStations: [],
    relays: [],
    states: {}, // sn -> 物模型（含经纬度）
    lastError: '',
    /** 演示数据模式：TK 未打通时用内置演示数据渲染全部界面 */
    mock: false,
    /** 显式轮询状态：让顶栏能显示「轮询中 / 已停止」，而不是让用户猜界面是不是卡了 */
    polling: false,
    lastRefreshAt: 0,
  }),

  getters: {
    onlineAirports: (s) => s.airports.filter((d) => d.online),
    onlineDrones: (s) => s.drones.filter((d) => d.online),
    deviceCount: (s) =>
      s.airports.length + s.drones.length + (s.baseStations?.length || 0) + (s.relays?.length || 0),
    /** 全部设备（任意类型） */
    allDevices: (s) => [...s.airports, ...s.drones, ...(s.baseStations || []), ...(s.relays || [])],
    /** 机场 → 其绑定的飞行器 */
    droneOf: (s) => (dockSn) => s.drones.find((d) => d.dockSn === dockSn) || null,
    stateOf: (s) => (sn) => s.states[sn] || null,
    /** 机场坐标（来自物模型 device_state） */
    positionOf: (s) => (sn) => {
      const st = s.states[sn]?.device_state;
      if (!st) return null;
      const lat = st.latitude;
      const lng = st.longitude;
      if (lat === undefined || lng === undefined || (lat === 0 && lng === 0)) return null;
      return { lat, lng, height: st.height ?? 0 };
    },
  },

  actions: {
    async init() {
      await this.loadInfo();
      if (this.connected) {
        await this.loadProjects();
        if (!this.projectUuid && this.projects.length === 1) {
          await this.selectProject(this.projects[0].uuid);
        } else if (!this.projectUuid && this.projects.length > 1) {
          // 多项目且尚未选择（服务重启后未持久化的旧版本会走到这里）：
          // 自动挑第一个「有设备」的项目，避免设备列表 / 物模型 / HUD 全空
          await this.autoSelectProject();
        } else if (this.projectUuid) {
          await this.loadDevices();
        }
      }
    },

    /** 自动选择有设备的项目（不重复拉设备列表，直接选完走一次 loadDevices） */
    async autoSelectProject() {
      const r = await sessionApi.devicesWithProject();
      const list = r?.data?.list || [];
      const target = list.find((x) => x.projectUuid)?.projectUuid || this.projects[0]?.uuid || '';
      if (!target) return;
      await sessionApi.selectProject(target);
      this.projectUuid = target;
      this.projectName = this.projects.find((p) => p.uuid === target)?.name || '';
      await this.loadDevices();
    },

    async loadInfo() {
      const r = await sessionApi.info();
      if (!r?.ok) return;
      const d = r.data || {};
      this.connected = d.connected;
      this.masked = d.masked;
      this.decoded = d.decoded;
      this.base = d.base;
      this.endpoint = d.endpoint || 'cn';
      this.customBase = d.customBase || '';
      this.endpoints = d.endpoints || {};
      this.mock = !!d.mock;
      this.projectUuid = d.projectUuid || '';
      await this.loadTokens();
    },

    async loadTokens() {
      const r = await sessionApi.tokens();
      if (r?.ok) this.tokens = r.data || [];
    },

    async setToken(name, token) {
      const r = await sessionApi.addToken(name, token);
      if (r?.ok) {
        this.projectUuid = '';
        this.projects = [];
        this.airports = [];
        this.drones = [];
        this.states = {};
        await this.init();
      }
      return r;
    },

    async activateToken(id) {
      const r = await sessionApi.activateToken(id);
      if (r?.ok) {
        this.projectUuid = '';
        this.projects = [];
        await this.init();
      }
      return r;
    },

    async removeToken(id) {
      await sessionApi.removeToken(id);
      await this.init();
    },

    async toggleMock(enabled) {
      const r = await adminApi.setMock(enabled);
      if (r?.ok) {
        this.mock = !!r.data.enabled;
        await this.init();
      }
      return r;
    },

    async setEndpoint(endpoint, customBase) {
      const r = await sessionApi.setEndpoint(endpoint, customBase);
      if (r?.ok) {
        this.base = r.data.base;
        await this.loadProjects();
      }
      return r;
    },

    async loadProjects() {
      this.loading = true;
      const r = await sessionApi.projects();
      this.loading = false;
      if (r?.ok) {
        this.projects = r.data?.list || [];
        this.lastError = '';
      } else {
        this.projects = [];
        this.lastError = r?.message || '项目列表获取失败';
      }
      return r;
    },

    async selectProject(uuid) {
      await sessionApi.selectProject(uuid);
      this.projectUuid = uuid;
      const p = this.projects.find((x) => x.uuid === uuid);
      this.projectName = p?.name || '';
      this.airports = [];
      this.drones = [];
      this.states = {};
      return this.loadDevices();
    },

    async loadDevices() {
      // 优先用「按项目聚合」接口：能拿到设备真实归属项目，物模型才有数据
      const r = await sessionApi.devicesWithProject();
      if (r?.ok) {
        let list = r.data?.list || [];
        if (this.projectUuid) {
          const own = list.filter((x) => x.projectUuid === this.projectUuid);
          if (own.length) {
            list = own;
            this.lastError = '';
          } else if (list.length) {
            this.lastError = `当前项目下没有设备，已显示组织内其他项目的 ${list.length} 台设备（在司空 2 中把设备加入本项目后即可正常获取物模型与坐标）`;
          }
        }
        this.applyDevices(list);
        return r;
      }
      const r2 = await sessionApi.devices();
      if (r2?.ok) this.applyDevices(r2.data?.list || []);
      return r;
    },

    /**
     * 把设备树摊平为各类型列表（设备类型无关）
     *
     * 公有云 v0.1 / v2.0 的 /project/device 只返回 gateway + drone；
     * 私有化还会带 base_station / relay，v2.0 的 manage-devices 则用 associate_*_device_info。
     * 这里按「角色」遍历并统一归类，任一形态出现都能进到对应列表，
     * 而不是只认 gateway/drone 把其它设备静默丢进回收站。
     */
    applyDevices(list) {
      const ROLES = [
        { key: 'gateway', kind: 'airport' },
        { key: 'drone', kind: 'drone' },
        { key: 'base_station', kind: 'base_station' },
        { key: 'relay', kind: 'relay' },
        { key: 'dock', kind: 'airport' },
        { key: 'hangar', kind: 'airport' },
        { key: 'associate_dock_device_info', kind: 'airport' },
        { key: 'associate_drone_device_info', kind: 'drone' },
        { key: 'associate_relay_device_info', kind: 'relay' },
        { key: 'associate_base_station_device_info', kind: 'base_station' },
      ];
      const buckets = { airport: [], drone: [], base_station: [], relay: [] };
      const seen = new Set();

      for (const item of list || []) {
        for (const role of ROLES) {
          const dev = item[role.key];
          if (!dev || !dev.sn) continue;
          const model = dev.device_model || {};
          // device_model.class 比角色 key 更权威（gateway 可能是 dock / hangar）
          const cls = String(model.class || '').toLowerCase();
          const bucket =
            cls === 'drone' ? 'drone'
            : cls === 'relay' ? 'relay'
            : cls === 'base_station' ? 'base_station'
            : role.kind === 'drone' ? 'drone'
            : role.kind === 'relay' ? 'relay'
            : role.kind === 'base_station' ? 'base_station'
            : 'airport';
          const dedupKey = `${bucket}:${dev.sn}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          buckets[bucket].push({
            kind: bucket,
            sn: dev.sn,
            callsign: dev.callsign || dev.sn,
            model: model.name || model.key || '',
            modelKey: model.key || '',
            deviceClass: model.class || role.kind,
            domain: model.domain || '',
            online: !!dev.device_online_status,
            modeCode: dev.mode_code,
            cameraList: dev.camera_list || [],
            droneSn: item.drone?.sn || item.associate_drone_device_info?.sn || '',
            dockSn: bucket === 'drone' ? item.gateway?.sn || item.dock?.sn || '' : '',
            projectUuid: item.projectUuid || '',
            projectName: item.projectName || '',
          });
        }
      }

      this.airports = buckets.airport;
      this.drones = buckets.drone;
      this.baseStations = buckets.base_station;
      this.relays = buckets.relay;
      this.states = {};
      this.refreshStates();
    },

    /** 逐个拉取物模型（含坐标），供地图定位 */
    async refreshStates() {
      const sns = this.allDevices.map((d) => d.sn);
      await Promise.all(sns.map((sn) => this.loadState(sn)));
    },

    async loadState(sn) {
      const dev = this.allDevices.find((d) => d.sn === sn);
      const r = await sessionApi_deviceState(sn, dev?.projectUuid || '');
      if (r?.ok && r.data) {
        this.states[sn] = { ...r.data, ts: Date.now() };
      } else {
        this.states[sn] = { device_sn: sn, error: r?.message || '物模型获取失败', ts: Date.now() };
      }
      return this.states[sn];
    },
  },
});

// 物模型走 deviceApi
import { deviceApi } from '../api/dji';
async function sessionApi_deviceState(sn, projectUuid) {
  return deviceApi.state(sn, projectUuid);
}
