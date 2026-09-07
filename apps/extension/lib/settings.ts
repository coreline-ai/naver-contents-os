import { create } from 'zustand';
import { browser } from 'wxt/browser';

export interface Settings {
  coreUrl: string;
  token: string;
  allowLlmWhenSensitiveUnknown: boolean;
  blogId: string;
  defaultTags: string;
}

const DEFAULTS: Settings = {
  coreUrl: 'http://127.0.0.1:3719',
  token: '',
  allowLlmWhenSensitiveUnknown: true,
  blogId: '',
  defaultTags: '',
};
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
    const stored = await browser.storage.local.get(STORAGE_KEY);
    set({ ...DEFAULTS, ...(stored[STORAGE_KEY] ?? {}), loaded: true });
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
    await browser.storage.local.set({ [STORAGE_KEY]: next });
    set(next);
  },
}));
