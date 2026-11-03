// ═══════════════════════════════════════════════════════════════
// projectView — единый проекционный читатель агрегированного «Project»
// из доменных сторов (map / mission / fleet). ФАЗА 5.D: замена шима
// useStoreShim. Чистая операция без оповещений и без сборки merged-
// агрегата: безопасна в rAF/DOM-колбэках и фазах React (исключает
// React error #127 «Should not already be working»).
// Направление зависимостей: projectView → {map, mission, fleet} —
// циклов с доменными сторам нет (сторы этот модуль не импортируют).
// ═══════════════════════════════════════════════════════════════
import type { Project } from "../types";
import { useMapStore } from "./useMapStore";
import { useMissionStore } from "./useMissionStore";

/**
 * Строит актуальный снапшот проекта из трёх доменных сторов.
 * Всегда возвращает новый объект (иммутабельный вид для потребителей).
 */
export function readProject(): Project {
  const m = useMapStore.getState();
  const mi = useMissionStore.getState();
  return {
    version: "1.1",
    projectName: m.projectName,
    createdAt: m.projectCreatedAt,
    updatedAt: m.projectUpdatedAt,
    map: m.map,
    calibration: m.calibration,
    restrictions: m.restrictions,
    markers: m.markers,
    routes: mi.routes,
    importLists: mi.importLists,
    layers: m.layers,
    settings: m.settings,
    googleMaps: m.googleMaps,
    yandexMaps: m.yandexMaps,
    openStreetMap: m.openStreetMap,
    // Импортированные пользовательские тактические карты: метаданные —
    // в persist useMapStore, бинарные payload'ы — в IndexedDB.
    tacticalOverlays: m.tacticalOverlays ?? [],
    // Реестр userLayers удалён как мёртвый код (аудит ФАЗА 5.D): ни один
    // компонент приложения его не читал/не писал; живые тактические слои —
    // tacticalOverlays (persist + IndexedDB в useMapStore).
    userLayers: [],
  };
}
