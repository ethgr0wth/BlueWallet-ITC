import { MMKV } from 'react-native-mmkv';

// Global storage instance
export const AppStorage = new MMKV({
  id: 'app-storage',
});

// Safe load
export function load(key, fallback = null) {
  try {
    const raw = AppStorage.getString(key);
    if (raw === undefined || raw === null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('MMKV load error for key', key, e);
    return fallback;
  }
}

// Safe save
export function save(key, value) {
  try {
    AppStorage.set(key, JSON.stringify(value));
  } catch (e) {
    console.warn('MMKV save error for key', key, e);
  }
}
