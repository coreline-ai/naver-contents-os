import { create } from 'zustand';

export interface Settings {
  coreUrl: string;
  token: string;
}

const DEFAULTS: Settings = { coreUrl: 'http://127.0.0.1:3719', token: '' };
const STORAGE_KEY = 'ncos-settings';

interface SettingsState extends Settings {
  loaded: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<Settings>) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  loaded: false,
  load: async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    set({ ...DEFAULTS, ...(stored[STORAGE_KEY] ?? {}), loaded: true });
  },
  save: async (patch) => {
    const next = { coreUrl: get().coreUrl, token: get().token, ...patch };
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    set(next);
  },
}));
