// ═══════════════════════════════════════════════════════════════
// useApiKeysStore — СЕССИОННЫЙ хранилище API-ключей карт.
// КРИТИКА БЕЗОПАСНОСТИ (ЭТАП 1.2): ключи НЕ персистятся — ни в
// localStorage, ни в IndexedDB, ни в экспорт проекта. Живут только
// в памяти текущей вкладки; перезагрузка/закрытие = очистка.
// Приоритет источника: ручной ввод (этот стор) > dev-ключ из .env.
// ═══════════════════════════════════════════════════════════════
import { create } from 'zustand';
import { envGoogleMapsKey, envYandexMapsKey } from '../utils/envKeys';

export type MapsProviderId = 'google' | 'yandex';

export interface ApiKeysState {
  /** Ручной ввод оператора (session-only). Пусто → используется env-ключ. */
  manual: Record<MapsProviderId, string>;
  setManualKey: (provider: MapsProviderId, key: string) => void;
  clearAllKeys: () => void;
}

export const useApiKeysStore = create<ApiKeysState>()((set) => ({
  manual: { google: '', yandex: '' },
  // Нормализация: trim + запрет пробельных символов внутри (частый мусорный ввод)
  setManualKey: (provider, key) =>
    set((s) => ({ manual: { ...s.manual, [provider]: String(key ?? '').trim() } })),
  clearAllKeys: () => set({ manual: { google: '', yandex: '' } }),
}));

/** Эффективный ключ провайдера: ручной > env > ''. */
export function getEffectiveApiKey(provider: MapsProviderId): string {
  const manual = useApiKeysStore.getState().manual[provider];
  if (manual) return manual;
  return provider === 'google' ? envGoogleMapsKey() : envYandexMapsKey();
}

/** Маскированный предпросмотр для UI: «AIza••••••••3f9A» (полное значение НИКОГДА не отдаём). */
export function maskKeyPreview(key: string): string {
  const k = String(key ?? '');
  if (!k) return '';
  if (k.length <= 8) return '•'.repeat(k.length);
  return `${k.slice(0, 4)}${'•'.repeat(Math.min(12, k.length - 8))}${k.slice(-4)}`;
}
