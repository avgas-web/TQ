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
import { useFleetStore } from '../store/useFleetStore';
import { syncShimSnapshot as rebuildShimSnapshot } from '../store/useStoreShim';

/**
 * Автозагрузка тайловой карты по умолчанию (OSM): если в хранилище нет ни
 * растровой карты, ни активной тайловой подложки — создаём тайловую карту
 * с дефолтным центром и включаем OSM. Это гарантирует, что при первом
 * запуске (в т.ч. внутри Мастера миссий) карта грузится автоматически,
 * а не остаётся белым экраном до ручного «Загрузить карту».
 */
export function ensureDefaultTileMap(): void {
  const st = useMapStore.getState();
  // КОРНЕВОЙ ФИКС async-гонки persist: zustand v5 гидрирует стор из
  // localStorage АСИНХРОННО (promise). Если Мастер/тест вызывает автозагрузку
  // до завершения гидрации, стейт на момент вызова пустой — но через тик
  // гидрация перезапишет его своим снапшотом и «съест» только что созданную
  // карту (вечный оверлей «Карта ещё не загружена»). Поэтому при НЕзавершённой
  // гидрации переносим запуск в onFinishHydration — ровно один раз, после
  // которого стейт финален и повторных перезаписей не будет.
  if (!useMapStore.persist.hasHydrated()) {
    const unsub = useMapStore.persist.onFinishHydration(() => {
      unsub();
      ensureDefaultTileMap();
    });
    return;
  }
  if (st.map) return; // уже есть растровая или тайловая карта
  st.toggleOpenStreetMap(true);
  st.setOSMTileServer(st.openStreetMap.tileServer ?? 'osm');
  // ФИКСАЦИЯ НАД СПБ при автозагрузке — ЕДИНЫЙ путь для ВСЕХ режимов
  // (редактор и мастер планирования миссий вызывают именно эту функцию).
  // Раньше здесь стоял центр по умолчанию «Москва» (55.7558, 37.6173), из-за
  // чего карта мастера открывалась не над СПб и расходилась с редактором.
  st.loadActiveTileMap({ lat: 59.9398, lng: 30.3146 }, 10);
}

let initialized = false;

/**
 * КОРНЕВОЙ ФИКС «stale snapshot» шима (useStoreShim): zustand persist
 * гидрирует каждый доменный стор АСИНХРОННО (чтение localStorage — promise),
 * а гидрация может произойти ПОСЛЕ любых setState (в т.ч. resetProject).
 * До этого shim-агрегат (snapshot/mergedCache) перестраивался только при
 * синхронных set() сторов — после async-гидрации фасад useStore продолжал
 * отдавать устаревший снапшот («Сброс не удаляет данные», точки «воскресали»
 * в UI, readiness-оверлей Мастера не реагировал на загрузку карты).
 * Лечим причиной, а не симптомом: подписываемся на ГИДРАЦИЮ каждого persist-стора
 * (onRehydrateStorage) + ставим safety-net подписку на любые изменения сторов —
 * любая внешняя мутация вызывает emit() шима, пересобирая агрегат.
 */
let hydrationSyncInstalled = false;
function installHydrationSync(): void {
  if (hydrationSyncInstalled) return;
  hydrationSyncInstalled = true;
  let pending = false;
  const reEmit = (): void => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      rebuildShimSnapshot();
    });
  };
  // onFinishHydration вызывается внутри set() гидрации → повторный set
  // запрещён; поэтому пересборка отложена в микрозадачу (re-entrancy guard).
  for (const store of [useMapStore, useMissionStore, useFleetStore]) {
    store.persist?.onFinishHydration?.(() => reEmit());
  }
  // Safety net: если persist-API недоступен (мок/старая версия), ловим любые
  // внешние set() доменных сторов (например, async-гидрацию без middleware-колбэка).
  useMapStore.subscribe(reEmit);
  useMissionStore.subscribe(reEmit);
  useFleetStore.subscribe(reEmit);
}

// Миграция legacy-хранилища + установка hydration-sync — однократные тяжёлые
// шаги (идемпотентность через собственный guard installHydrationSync).
let migrationDone = false;
function migrateLegacyStorageOnce(): void {
  if (migrationDone) return;
  migrationDone = true;
  import('../store/useStoreShim').then(({ migrateLegacyStorage }) => {
    migrateLegacyStorage();
    rebuildShimSnapshot(); // сбросить снапшот шима после миграции
    installHydrationSync(); // реактивность на async-гидрацию persist
  });
}

export function useAppInitialization(): void {
  // Стартовая инициализация: миграция хранилища → восстановление карты из
  // IndexedDB → автозагрузка OSM-подложки по умолчанию (см. ensureDefaultTileMap).
  // ВАЖНО (корневой фикс remount-гонки): модульный флаг `initialized` больше НЕ
  // блокирует эффект — при размонтировании/перемонтировании Мастера (смена шага,
  // переход редактор↔мастер) загрузчик обязан запускаться заново, иначе карта
  // остаётся null и readiness-оверлей висит вечно. Идемпотентность обеспечивает
  // сам ensureDefaultTileMap (exit при st.map !== null / уже активном OSM), а
  // тяжёлые шаги (миграция, гидрация) выполняются однократно через свои guards.
  useEffect(() => {
    let cancelled = false;
    const run = (): void => {
      if (cancelled) return;
      if (!initialized) {
        initialized = true;
        migrateLegacyStorageOnce();
      }
      void useMapStore.getState().restoreMapFromStorage().then(() => {
        if (cancelled) return;
        ensureDefaultTileMap();
        rebuildShimSnapshot(); // карта из IndexedDB/persist видна фасаду немедленно
      });
    };
    // setTimeout(0) — выход за пределы commit-фазы React (исключает setState
    // во время рендера, краш React #127) и детерминированная отмена при unmount.
    const timer = window.setTimeout(run, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
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
