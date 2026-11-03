// ═══════════════════════════════════════════════════════════════
// useProjectStore — реактивный читатель агрегированного «Project».
// ФАЗА 5.D: замена merged-агрегата фасада useStoreShim.
//
// Подписка строится напрямую на доменных сторах (map/mission/fleet) —
// без module-level snapshot и без buildMerged(), поэтому вызовы
// getState() безопасны в любых фазах React (исключён error #127).
// Частые setState внутри одного тика коалесцируются микрозадачей
// (как в шиме): слушатели оповещаются один раз на тик.
// ═══════════════════════════════════════════════════════════════
import { useSyncExternalStore } from "react";
import type { Project } from "../types";
import { useMapStore } from "./useMapStore";
import { useMissionStore } from "./useMissionStore";
import { useFleetStore } from "./useFleetStore";
import { readProject } from "./projectView";

const listeners = new Set<() => void>();
let cached: Project | null = null;
let emitScheduled = false;

function invalidate(): void {
  cached = null;
  if (emitScheduled) return;
  emitScheduled = true;
  queueMicrotask(() => {
    emitScheduled = false;
    listeners.forEach((l) => l());
  });
}

useMapStore.subscribe(invalidate);
useMissionStore.subscribe(invalidate);
useFleetStore.subscribe(invalidate);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Стабильный по идентичности снапшот проекта для useSyncExternalStore.
 *  Кэш инвалидируется подписками доменных сторов (invalidate), поэтому
 *  между оповещениями возвращаем один и тот же объект (стабильная
 *  ссылка — требование getSnapshot). */
function getSnapshot(): Project {
  if (!cached) cached = readProject();
  return cached;
}

/** Принудительный сброс кэша (используется после async-операций вне
 *  подписок: гидрация persist, восстановление карты из IndexedDB). */
export function syncProjectSnapshot(): void {
  cached = null;
}

export function subscribeProject(listener: () => void): () => void {
  return subscribe(listener);
}

export function getProjectSnapshot(): Project {
  return getSnapshot();
}

/** React-хук: актуальный агрегированный проект (референс меняется только
 *  при реальных изменениях доменных сторов). */
export function useProject(): Project {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
