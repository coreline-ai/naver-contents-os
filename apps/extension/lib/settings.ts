import { create } from 'zustand';
import { browser } from 'wxt/browser';

export interface Settings {
  coreUrl: string;
  token: string;
  allowLlmWhenSensitiveUnknown: boolean;
  blogId: string;
  defaultTags: string;
}

export const DEFAULT_SETTINGS: Settings = {
  coreUrl: 'http://127.0.0.1:3719',
  token: '',
  allowLlmWhenSensitiveUnknown: true,
  blogId: '',
  defaultTags: '',
};
export const SETTINGS_STORAGE_KEY = 'ncos-settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_STORAGE_KEY] ?? {}) };
}

interface SettingsState extends Settings {
  loaded: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<Settings>) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    set({ ...(await loadSettings()), loaded: true });
  },
  save: async (patch) => {
    const next = {
      coreUrl: get().coreUrl,
      token: get().token,
      allowLlmWhenSensitiveUnknown: get().allowLlmWhenSensitiveUnknown,
      blogId: get().blogId,
      defaultTags: get().defaultTags,
      ...patch,
    };
    await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
    set(next);
  },
}));
