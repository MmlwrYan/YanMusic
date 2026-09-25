import { defineStore } from 'pinia';
import request from '@/utils/request';
import logger from '@/utils/logger';

export interface LoginDeviceSession {
  id: string;
  title: string;
  platform: string;
  loginType: string;
  location: string;
  model: string;
  loginTime: string;
  activeTime: string;
  tMid: string;
  t: string;
  tAppid: string;
  tClientver: string;
  mid: string;
  dfid: string;
  uuid: string;
  isCurrent: boolean;
  isNew: boolean;
  canKick: boolean;
}

type LoginDeviceApiRecord = {
  ver?: string | number;
  mid?: string | number;
  mt?: string | number;
  login_type?: string | number;
  new?: string | number;
  loc?: string;
  t?: string | number;
  app?: string;
  appid?: string | number;
  dev?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const extractDeviceRecords = (payload: unknown): LoginDeviceApiRecord[] => {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.li)) {
    return [];
  }
  return payload.data.li.filter(isRecord) as LoginDeviceApiRecord[];
};

const sortableTime = (device: LoginDeviceSession): number => {
  const value = Number(device.activeTime || device.loginTime || 0);
  return Number.isFinite(value) ? value : 0;
};

const normalizeSession = (raw: LoginDeviceApiRecord, index: number): LoginDeviceSession => {
  const mid = readText(raw.mid);
  const tMid = mid;
  const dfid = readText(raw.mt);
  const uuid = '';
  const t = readText(raw.t);
  const tAppid = readText(raw.appid);
  const tClientver = readText(raw.ver);
  const model = readText(raw.dev);
  const platform = readText(raw.app);
  const loginType = readText(raw.login_type);
  const location = readText(raw.loc);
  const loginTime = '';
  const activeTime = t;
  const newTime = readText(raw.new);
  const isNew = Boolean(newTime && newTime !== '0' && newTime === t);
  const title =
    model ||
    (platform.includes('安卓') || platform.toLowerCase().includes('android')
      ? '酷狗Android客户端'
      : platform) ||
    `登录设备 ${index + 1}`;

  return {
    id: tMid || dfid || uuid || `${title}-${index}`,
    title,
    platform,
    loginType,
    location,
    model,
    loginTime,
    activeTime,
    tMid,
    t,
    tAppid,
    tClientver,
    mid,
    dfid,
    uuid,
    isCurrent: false,
    isNew,
    canKick: true,
  };
};

export const useLoginDeviceStore = defineStore('loginDevices', {
  state: () => ({
    devices: [] as LoginDeviceSession[],
    loading: false,
    kickingId: '',
    loaded: false,
    error: '',
  }),
  getters: {
    currentDevice: (state) => state.devices.find((device) => device.isCurrent) || null,
  },
  actions: {
    async fetchDevices() {
      this.loading = true;
      this.error = '';
      this.devices = [];
      try {
        const response = await request.get('login/devices');
        this.devices = extractDeviceRecords(response)
          .map((record, index) => normalizeSession(record, index))
          .sort((a, b) => {
            if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
            return sortableTime(b) - sortableTime(a);
          });
        this.loaded = true;
      } catch (error) {
        this.error = '登录设备获取失败';
        logger.warn('LoginDevices', 'Fetch login devices failed', error);
      } finally {
        this.loading = false;
      }
    },
    reset() {
      this.devices = [];
      this.loading = false;
      this.kickingId = '';
      this.loaded = false;
      this.error = '';
    },
  },
});
