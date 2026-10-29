// ═══════════════════════════════════════════════════════════════
// sessionSecrets — защищённое хранилище API-ключей карт (ЭТАП 1.2).
//   • Ключи Google/Яндекс НИКОГДА не пишутся в localStorage / IndexedDB /
//     экспорт проекта — только в память текущей сессии (этот module-level
//     Map живёт до перезагрузки вкладки);
//   • приоритет источника: ручной ввод пользователя в UI > dev-ключ из .env
//     (VITE_GOOGLE_MAPS_API_KEY / VITE_YANDEX_MAPS_API_KEY, import.meta.env);
//   • очистка при beforeunload — «следы» ключа не остаются в памяти открытой
//     страницы после закрытия;
//   • graceful degradation: любой сбой доступа к памяти — тихий возврат '',
//     приложение продолжает работать на бесплатных XYZ-подложках.
// ВНИМАНИЕ (модификатор public): значения import.meta.env попадают в бандл —
// env-ключи допустимы ТОЛЬКО для локальной разработки, не для прода.
// ═══════════════════════════════════════════════════════════════

export type MapProviderKeyKind = 'google' | 'yandex';

interface ProviderKeyMeta {
  label: string;
  envVar: 'VITE_GOOGLE_MAPS_API_KEY' | 'VITE_YANDEX_MAPS_API_KEY';
}

export const PROVIDER_KEY_META: Record<MapProviderKeyKind, ProviderKeyMeta> = {
  google: { label: 'Google Maps', envVar: 'VITE_GOOGLE_MAPS_API_KEY' },
  yandex: { label: 'Яндекс.Карты', envVar: 'VITE_YANDEX_MAPS_API_KEY' },
};

/** Только in-memory: структурированное состояние, персист запрещён */
const memoryStore = new Map<MapProviderKeyKind, string>();
let unloadHookInstalled = false;

function readEnvKey(meta: ProviderKeyMeta): string {
  try {
    const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
    // strict-типизация без any: доступ по литеральному ключу ImportMetaEnv
    const raw = meta.envVar === 'VITE_GOOGLE_MAPS_API_KEY'
      ? env.VITE_GOOGLE_MAPS_API_KEY
      : env.VITE_YANDEX_MAPS_API_KEY;
    return typeof raw === 'string' ? raw.trim() : '';
  } catch {
    return ''; // окружение недоступно (тесты без define) — не критично
  }
}

function installUnloadCleanup(): void {
  if (unloadHookInstalled) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  unloadHookInstalled = true;
  window.addEventListener('beforeunload', () => {
    // физически стираем значения перед выгрузкой страницы
    memoryStore.clear();
  });
}

/** Установить ключ, введённый пользователем (память текущей сессии). */
export function setSessionApiKey(kind: MapProviderKeyKind, key: string): void {
  const v = key.trim();
  if (!v) memoryStore.delete(kind);
  else memoryStore.set(kind, v);
  installUnloadCleanup();
}

/** Текущий ключ провайдера: ручной ввод > dev-ключ из .env > ''. */
export function getSessionApiKey(kind: MapProviderKeyKind): string {
  const manual = memoryStore.get(kind);
  if (manual) return manual;
  return readEnvKey(PROVIDER_KEY_META[kind]);
}

/** Есть ли ключ у провайдера (для статусов готовности/mapProviders). */
export function hasSessionApiKey(kind: MapProviderKeyKind): boolean {
  return getSessionApiKey(kind).length > 0;
}

/** Источник активного ключа — для честной подписи в UI (session|env|none). */
export function getApiKeySource(kind: MapProviderKeyKind): 'session' | 'env' | 'none' {
  if (memoryStore.get(kind)) return 'session';
  if (readEnvKey(PROVIDER_KEY_META[kind])) return 'env';
  return 'none';
}

/** Забыть ключ текущей сессии (кнопка «Очистить» в настройках). */
export function clearSessionApiKey(kind: MapProviderKeyKind): void {
  memoryStore.delete(kind);
}

/** Полная очистка всех ключей (сброс приложения / выход). */
export function clearAllSessionApiKeys(): void {
  memoryStore.clear();
}

/** Маскированный показ ключа в UI: ab…yz (полное значение нигде не рисуется). */
export function maskApiKey(key: string): string {
  const v = key.trim();
  if (!v) return '';
  if (v.length <= 6) return '•'.repeat(v.length);
  return `${v.slice(0, 2)}${'•'.repeat(Math.min(12, v.length - 4))}${v.slice(-2)}`;
}
