// ═══════════════════════════════════════════════════════════════
// useAppInitialization — оркестрация стартовой инициализации приложения.
// Инкапсулирует: миграцию legacy-хранилища, восстановление растровой карты
// из IndexedDB, ЕДИНСТВЕННЫЙ троттлинговый подписчик на изменения геозон
// (перестройка маршрутов) и авто-пересчёт высот при включённом elevationAuto.
// Вызывается ровно один раз из корня приложения (App.tsx).
// ═══════════════════════════════════════════════════════════════
import { useEffect } from 'react';
import { useMapStore, invalidateZoneCache } from '../store/useMapStore';
import { useMissionStore, scheduleRerouteAll } from '../store/useMissionStore';
import { migrateLegacyStorage } from '../store/useStoreShim';

let initialized = false;

export function useAppInitialization(): void {
  // Стартовая инициализация: миграция хранилища → восстановление карты из
  // IndexedDB (restoreMapFromStorage сам пересчитывает пиксели маршрутов).
  useEffect(() => {
    if (initialized) return;
    initialized = true;
    migrateLegacyStorage();
    void useMapStore.getState().restoreMapFromStorage();
  }, []);

  // Единственный владелец триггеров пакетной перестройки маршрутов:
  // 1) любое изменение restrictions (зоны) → инвалидация кэша зон + троттл-reroute;
  // 2) смена карты/bounds → пересчёт пикселей маршрутов из lat/lng;
  // 3) elevationAuto && routes.length > 0 → авто-пересчёт высот по рельефу.
  useEffect(() => {
    let prevRestrictions = useMapStore.getState().restrictions;
    let prevMap = useMapStore.getState().map;
    const unsubMap = useMapStore.subscribe((state) => {
      if (state.restrictions !== prevRestrictions) {
        prevRestrictions = state.restrictions;
        invalidateZoneCache();
        scheduleRerouteAll();
      }
      if (state.map !== prevMap) {
        prevMap = state.map;
        useMissionStore.getState().refreshAllRoutesAfterMapChange();
      }
    });
    let prevRouteCount = useMissionStore.getState().routes.length;
    const unsubMission = useMissionStore.subscribe((state) => {
      const n = state.routes.length;
      if (n !== prevRouteCount) {
        prevRouteCount = n;
        if (useMapStore.getState().settings.elevationAuto && n > 0) {
          void useMissionStore.getState().updateRouteAltitudes();
        }
      }
    });
    return () => { unsubMap(); unsubMission(); };
  }, []);
}
