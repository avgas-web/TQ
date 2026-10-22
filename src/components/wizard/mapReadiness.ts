// ═══════════════════════════════════════════════════════════════
// mapReadiness — единый источник истины «карта готова» для Мастера.
//
// Требование: в режиме мастера точки НЕ должны ставиться «в пустом
// поле без карты». Корневая причина прежнего поведения: клик по
// области поверх MapCanvas обрабатывался независимо от того, загружена
// ли подложка (mapLoaded внутри MapCanvas — локальный state) — точка
// попадала на несуществующую карту. Здесь готовность вычисляется из
// картографического стора + флага загрузки, который MapCanvas публикует
// через onMapLoaded:
//   • тайловая подложка активна (settings.tilesEnabled + bounds карты);
//   • выбранный провайдер не требует API-ключ, которого нет;
//   • карта фактически отрисована (loaded=true).
// Компоненты этапов (StartPointsStep/TargetPointsStep) блокируют
// постановку точек до готовности и показывают явный оверлей-подсказку.
// ═══════════════════════════════════════════════════════════════
import { useMapStore } from '../../store/useMapStore';
import type { Project } from '../../types';
import { getProviderStatus, type TileProviderId } from '../../utils/mapProviders';

export interface MapReadiness {
  /** Карта загружена и интерактивна — ставить точки можно. */
  ready: boolean;
  /** Причина блокировки (для UI), null если готово. */
  reason: string | null;
}

/** Чистая функция готовности — детерминирована, тестируется без React. */
export function computeMapReadiness(
  project: Pick<Project, 'settings' | 'map' | 'openStreetMap' | 'googleMaps' | 'yandexMaps'>,
  loaded: boolean,
): MapReadiness {
  const tilesActive = !!project.settings?.tilesEnabled && !!project.map?.bounds;
  if (!tilesActive) {
    return {
      ready: false,
      // Формулировка различима с состоянием «нет API-ключа» (иначе тесты на
      // graceful degradation давали бы ложные срабатывания по слову «ключ»).
      reason: 'Карта ещё не загружена. Включите тайловую подложку и дождитесь появления тайлов — точки на пустом поле ставить нельзя.',
    };
  }
  // Graceful degradation: провайдер без ключа (Google/Яндекс) физически не
  // отдаст тайлы — подсказываем переключиться на бесплатные OSM/2ГИС.
  const provider = project.openStreetMap?.tileServer ?? 'osm';
  const status = getProviderStatus(project, provider);
  if (!status.ready) {
    return { ready: false, reason: status.message ?? 'Провайдер карт недоступен.' };
  }
  if (!loaded) {
    return { ready: false, reason: 'Загрузка тайлов… Как только подложка появится, можно ставить точки.' };
  }
  return { ready: true, reason: null };
}

/** Подписка на картографический стор (примитивные селекторы → без re-render storm). */
export function useMapReadiness(loaded: boolean): MapReadiness {
  // КОРНЕВОЕ ИСПРАВЛЕНИЕ: готовность считывается НАПРЯМУЮ из доменного
  // useMapStore (тот же источник истины, который мутируют ensureDefaultTileMap
  // и setOSMTileServer), а не через фасад useStore. Фасад-агрегат обновляется
  // асинхронными подписками и при быстрой гидрации/сбросах сторов давал
  // stale-снапшот («карта не готова» вечно) — именно этот дефект воспроизводили
  // падавшие интеграционные тесты мастера. viewTick подписан ниже, чтобы хук
  // пере-вычислялся при любом изменении карты.
  // КОРНЕВОЙ ФИКС ТИПОВ И HOOKS-ORDER: все хуки объявлены ДО return'а,
  // ad-hoc литералы с недостающими полями заменены полными стейт-объектами
  // (Pick<Project,...> требовал settings/map/openStreetMap целиком).
  const googleMaps = useMapStore((s) => s.googleMaps);
  const yandexMaps = useMapStore((s) => s.yandexMaps);
  // Флаг загрузки читаем из СТОРА (MapCanvas публикует его синхронно в
  // publishMapLoaded), а не только из React-state этапа: state-проп приходит
  // через onMapLoaded с задержкой (setTimeout + re-render родителя), и без
  // этой подписки оверлей «Загрузка тайлов…» зависал даже после готовности
  // подложки (decision-логика кликов через isMapReadyNow уже работала
  // корректно — расходился только UI).
  const storeLoaded = useMapStore((s) => s.mapLoaded);
  void useMapStore((s) => s.viewTick); // подписка «изменилась карта» → ре-рендер
  return computeMapReadiness(
    {
      settings: useMapStore((s) => s.settings),
      map: useMapStore((s) => s.map),
      openStreetMap: useMapStore((s) => s.openStreetMap),
      googleMaps,
      yandexMaps,
    },
    effectiveLoadedFlag(storeLoaded, loaded),
  );
}

/** Стор-значение флага загрузки с нормализацией stale-значений.
 *  useMapStore.mapLoaded — источник истины, который MapCanvas публикует
 *  синхронно; но при гидрации persist в него мог попасть «true» с прошлого
 *  сеанса, когда карта уже сброшена (map=null) — такой флаг аннулируется,
 *  иначе decision-логика кликов обходила бы блокировку. */
export function effectiveLoadedFlag(storeLoaded: boolean, loaded: boolean): boolean {
  return storeLoaded && !!useMapStore.getState().map ? storeLoaded : loaded;
}

/** КОРНЕВОЙ ФИКС «точки вслепую»: React-дерево мастера может ещё не быть
 *  перерендерено после публикации готовности карты (setMapLoaded из колбэка),
 *  поэтому перед кликом readiness перечитывается ИЗ ИСТОЧНИКА ИСТИНЫ напрямую.
 *  Если стор говорит «карты нет» — клик игнорируется, даже если DOM ещё
 *  показывает устаревший «готовый» экран (защита от постановки точек на
 *  пустое поле). */
export function isMapReadyNow(loaded: boolean): boolean {
  // КОРНЕВОЙ ФИКС ОБХОДА БЛОКИРОВКИ (воспроизведено в wizardMapReadiness):
  // флаг `loaded` приходит из React-state этапа и обновляется асинхронно
  // (setMapLoaded через onMapLoaded → setTimeout). Если родительский эффект
  // ещё не отработал, loaded===true может быть STALE-значением с прошлого
  // монтирования, тогда как карта уже сброшена (map=null) — клик ставил
  // точку на пустом поле при активном оверлей-блоке. Источник истины —
  // сам стор: mapLoaded публикуется MapCanvas СИНХРОННО в useMapStore,
  // поэтому для decision-логики читаем его напрямую. Аргумент `loaded`
  // остаётся только для UI-подписки хука (обратная совместимость).
  const store = useMapStore.getState();
  // stale-флаг (mapLoaded=true без карты) аннулируется — см. effectiveLoadedFlag
  const actuallyLoaded = effectiveLoadedFlag(store.mapLoaded, loaded);
  return computeMapReadiness(store, actuallyLoaded).ready;
}
