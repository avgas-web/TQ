// ═══════════════════════════════════════════════════════════════
// envKeys — чтение dev-ключей карт из import.meta.env (.env.local).
// ВАЖНО: всё, что попадает в VITE_*, ВСЕГДА видно в собранном бандле.
// Это допустимо ТОЛЬКО для локальной разработки/тестовых ключей с
// жёсткими квотами. Боевые ключи — только ручной ввод в текущей сессии
// (useApiKeysStore, без персиста).
// ═══════════════════════════════════════════════════════════════

interface AppImportMetaEnv {
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  readonly VITE_YANDEX_MAPS_API_KEY?: string;
  readonly MODE?: string;
  readonly DEV?: boolean;
}

const meta: { env?: AppImportMetaEnv } = (import.meta ?? {}) as { env?: AppImportMetaEnv };

/** Ключ из .env (или '' если не задан). Только строки; мусор игнорируется. */
export function envGoogleMapsKey(): string {
  const v = meta.env?.VITE_GOOGLE_MAPS_API_KEY;
  return typeof v === 'string' ? v.trim() : '';
}

export function envYandexMapsKey(): string {
  const v = meta.env?.VITE_YANDEX_MAPS_API_KEY;
  return typeof v === 'string' ? v.trim() : '';
}

/** Есть ли dev-ключ в окружении сборки (для подсказки в UI) */
export function hasEnvKeys(): boolean {
  return !!(envGoogleMapsKey() || envYandexMapsKey());
}
