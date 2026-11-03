// ═══════════════════════════════════════════════════════════════
// projectActions — проектные операции верхнего уровня (ФАЗА 5.D).
// Мигрированы из фасада useStoreShim: exportProject / importProject /
// resetProject / setProjectName / migrateLegacyStorage.
// Единственный источник истины метаданных проекта — useMapStore
// (projectName / projectCreatedAt / projectUpdatedAt), агрегированный
// вид строится чистым читателем readProject() (projectView.ts).
// Никаких module-level mirror'ов и merged-агрегатов: все мутации —
// штатные setState доменных сторов (persist сериализует каждый set()).
// ═══════════════════════════════════════════════════════════════
import type { Project } from "../types";
import {
  useMapStore,
  invalidateZoneCache,
  defaultMapSettings,
} from "./useMapStore";
import { useMissionStore } from "./useMissionStore";
import { useFleetStore } from "./useFleetStore";
import { readProject } from "./projectView";
import { forceUnlockMissionGuard } from "./missionGuard";
import { clearAllStoredMaps } from "../utils/storage";
import { sanitizeProjectData } from "../utils/projectSchema";

/** Имя проекта + отметка «изменён» (используется UI и MapCanvas). */
export function setProjectName(name: string): void {
  useMapStore.getState().setProjectName(name);
}

/** Отметка модификации проекта без смены имени (drag точек маршрута и т.п.). */
export function touchProjectUpdatedAt(): void {
  useMapStore.setState({ projectUpdatedAt: new Date().toISOString() });
}

/** Снапшот проекта для экспорта (.tqproj). */
export function exportProject(): Project {
  return readProject();
}

/** Импорт проекта из .tqproj: Zod-санитизация → разбор по доменам. */
export function importProject(project: Project): void {
  invalidateZoneCache(); // набор зон заменён целиком — кэш недействителен
  // Валидация внешних данных ПЕРЕД попаданием в стейт (краш-защита от
  // битых .tqproj: NaN-координаты, вырожденные bounds, строки вместо чисел).
  let p: Project;
  try {
    p = sanitizeProjectData(project) as unknown as Project;
  } catch (e) {
    console.warn("[importProject] schema sanitize failed:", e);
    p = project;
  }
  useMapStore.getState().importProjectGeo(p);
  useMissionStore.setState({
    routes: p.routes ?? [],
    importLists: p.importLists,
  });
}

/**
 * Полный сброс проекта (кнопка «Сброс / Abort Mission»).
 * Аварийная операция: работает ВСЕГДА, даже при зависшем isProcessing —
 * страж guarded-экшенов снимается принудительно (forceUnlockMissionGuard).
 */
export function resetProject(): void {
  // Снимаем флаг тяжёлой операции и отменяем фоновые прогоны высот,
  // чтобы они не дописали данные после очистки.
  useMissionStore.setState({ isProcessing: false });
  try {
    useMissionStore.getState().cancelAltitudeRun();
  } catch {
    /* noop */
  }
  forceUnlockMissionGuard();
  invalidateZoneCache();
  const ms = useMapStore.getState();
  ms.resetMapUi(); // tool/view/UI-выделение/буферы рисования/_currentMapId
  useMapStore.setState({
    map: null,
    markers: [],
    restrictions: [],
    layers: [{ id: "default", name: "Основной", visible: true, locked: false }],
    calibration: { enabled: false, points: [] },
    settings: { ...ms.settings },
  });
  ms.resetProjectMeta();
  useMissionStore.getState().resetMissions();
  // Полный сброс: парк дронов (назначения, регистрация, индивидуальные
  // старты/цели) тоже очищается — иначе после «Сброса» остаются привязки
  // к удалённым маршрутам и точкам.
  useFleetStore.getState().resetFleet();
  // Возврат профильных настроек к чистым значениям: resetMissions() оставляет
  // craftType, а в settings могли остаться legacy-поля elevationAuto /
  // altitudeClearanceM, перезаписывающие дефолты при гидрации persist.
  useMissionStore.setState({ craftType: "drone" });
  useMapStore.setState((cur) => {
    const rest = { ...cur.settings } as Record<string, unknown>;
    delete rest.elevationAuto;
    delete rest.altitudeClearanceM;
    return {
      settings: { ...defaultMapSettings, ...rest } as typeof cur.settings,
    };
  });
  // КРИТИЧЕСКИЙ ФИКС «Сброс не удаляет данные»: очистка СОСТОЯНИЯ в памяти
  // без предварительного удаления ключей — zustand persist подписан на каждый
  // set() и синхронно перезаписывает localStorage пустым состоянием (иначе
  // любой set() между удалением ключей и гидрацией воскрешал старые данные).
  // Затем удаляем изображения карт из IndexedDB (best-effort) и legacy-ключи:
  // иначе автовосстановление App при следующем запуске вернёт старую карту.
  void clearAllStoredMaps().finally(() => {
    try {
      localStorage.removeItem("tq-map");
      localStorage.removeItem("tq-mission");
      localStorage.removeItem("tq-fleet");
      localStorage.removeItem("totalquadro-storage");
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith("totalquadro-backup")) localStorage.removeItem(k);
      }
    } catch (e) {
      console.warn("[resetProject] persist storage cleanup failed:", e);
    }
  });
}

/**
 * Миграция legacy persist (totalquadro-storage v2 → tq-map/tq-mission/tq-fleet).
 * Выполняется ОДИН раз при старте приложения (см. useAppInitialization):
 * если новые ключи пусты, а старый есть — разбираем старый project по
 * доменам и удаляем legacy-ключ.
 */
export function migrateLegacyStorage(): void {
  try {
    if (localStorage.getItem("tq-map")) return; // уже мигрировано
    const raw = localStorage.getItem("totalquadro-storage");
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      state?: Record<string, unknown>;
      version?: number;
    };
    const st = parsed.state ?? {};
    const p = (st.project ?? {}) as Partial<Project>;
    useMapStore.setState({
      map: p.map ?? null,
      markers: p.markers ?? [],
      restrictions: p.restrictions ?? [],
      layers: p.layers?.length
        ? p.layers
        : [{ id: "default", name: "Основной", visible: true, locked: false }],
      calibration: p.calibration ?? { enabled: false, points: [] },
      // ЭТАП 1.2: из legacy-снапшота берём ТОЛЬКО enabled; apiKey вырезается.
      googleMaps: { enabled: !!p.googleMaps?.enabled },
      yandexMaps: { enabled: !!p.yandexMaps?.enabled },
      openStreetMap: p.openStreetMap ?? {
        enabled: false,
        tileServer: "osm",
      },
      settings: p.settings ?? useMapStore.getState().settings,
      _currentMapId: st._currentMapId as string | undefined,
      currentTool: (st.currentTool ?? "pan") as never,
      viewState: (st.viewState ?? {
        offsetX: 0,
        offsetY: 0,
        scale: 1,
      }) as never,
      activeRestrictionId: (st.activeRestrictionId ?? null) as never,
      searchQuery: (st.searchQuery ?? "") as never,
      filterType: (st.filterType ?? "") as never,
      projectName: p.projectName ?? "Новый проект",
      projectCreatedAt: p.createdAt ?? useMapStore.getState().projectCreatedAt,
      projectUpdatedAt: p.updatedAt ?? new Date().toISOString(),
    });
    useMissionStore.setState({
      routes: p.routes ?? [],
      importLists: p.importLists,
      activeRouteId: (st.activeRouteId ?? null) as never,
    });
    if (Array.isArray(st.droneAssignments)) {
      useFleetStore.setState({
        droneAssignments: st.droneAssignments as never,
      });
    }
    localStorage.removeItem("totalquadro-storage");
  } catch (e) {
    console.warn("[projectActions] legacy migration failed:", e);
  }
}
