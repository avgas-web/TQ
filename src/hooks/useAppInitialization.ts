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

/**
 * Автозагрузка тайловой карты по умолчанию (OSM): если в хранилище нет ни
 * растровой карты, ни активной тайловой подложки — создаём тайловую карту
 * с дефолтным центром и включаем OSM. Это гарантирует, что при первом
 * запуске (в т.ч. внутри Мастера миссий) карта грузится автоматически,
 * а не остаётся белым экраном до ручного «Загрузить карту».
 */
export function ensureDefaultTileMap(): void {
  const st = useMapStore.getState();
  if (st.map) return; // уже есть растровая или тайловая карта
  st.toggleOpenStreetMap(true);
  st.setOSMTileServer(st.openStreetMap.tileServer ?? 'osm');
  st.loadActiveTileMap({ lat: 55.7558, lng: 37.6173 }, 10);
}

let initialized = false;

export function useAppInitialization(): void {
  // Стартовая инициализация: миграция хранилища → восстановление карты из
  // IndexedDB → автозагрузка OSM-подложки по умолчанию (см. ensureDefaultTileMap).
  useEffect(() => {
    if (initialized) return;
    initialized = true;
    migrateLegacyStorage();
    void useMapStore.getState().restoreMapFromStorage().then(() => ensureDefaultTileMap());
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
