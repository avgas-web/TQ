// ═══════════════════════════════════════════════════════════════
// apiKeySanitizer — ЭТАП 1.2 (P0-уязвимость): полное удаление API-ключей
// из любых персистентных снапшотов localStorage. Ключи карт больше НИКОГДА
// не пишутся в tq-map / legacy totalquadro-storage; этот модуль вычищает
// их из сохранений СТАРЫХ версий приложения при старте и при гидрации.
// ═══════════════════════════════════════════════════════════════

const PROVIDER_KEYS = ['googleMaps', 'yandexMaps'] as const;

interface ProviderSlice { enabled?: boolean }

/** Режет apiKey из объекта провайдера, сохраняя остальные поля (enabled и т.п.) */
function scrubProvider(p: unknown): ProviderSlice | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const rest = { ...(p as Record<string, unknown>) };
  delete rest.apiKey;
  return rest as ProviderSlice;
}

/** Глубоко удаляет все apiKey из произвольного JSON-объекта проекта/стора. */
export function stripApiKeysDeep<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = { ...obj };
  for (const k of PROVIDER_KEYS) {
    if (out[k] && typeof out[k] === 'object') out[k] = scrubProvider(out[k]);
  }
  // project.googleMaps внутри legacy-снапшота
  if (out.project && typeof out.project === 'object') {
    out.project = stripApiKeysDeep(out.project as Record<string, unknown>);
  }
  if (out.state && typeof out.state === 'object') {
    out.state = stripApiKeysDeep(out.state as Record<string, unknown>);
  }
  return out as T;
}

/**
 * Одноразовая санация localStorage при старте: если в tq-map или legacy
 * totalquadro-storage обнаружен любой непустой apiKey — перезаписываем
 * снапшот без него.
 * @returns true, если что-то было вычищено (для логов/телеметрии).
 */
export function scrubPersistedApiKeys(): boolean {
  if (typeof localStorage === 'undefined') return false;
  let changed = false;
  for (const key of ['tq-map', 'totalquadro-storage']) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      if (!/"apiKey"\s*:\s*"([^"]+)"/.test(raw)) continue; // быстрый фильтр: пустые ключи не трогаем
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const cleaned = stripApiKeysDeep(parsed);
      localStorage.setItem(key, JSON.stringify(cleaned));
      changed = true;
    } catch {
      // битый JSON — чинить нечего (persist сам отбросит его при гидрации)
    }
  }
  return changed;
}

/** Санация объекта проекта перед записью (подстраховка в persist partialize) */
export function sanitizeProjectProviders<T extends Record<string, unknown>>(project: T): T {
  return stripApiKeysDeep(project);
}
