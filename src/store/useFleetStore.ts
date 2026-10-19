// ═══════════════════════════════════════════════════════════════
// useFleetStore — доменный стор парка БПЛА (Domain-Driven Split #3)
// Назначения «старт/цель/маршрут» каждому дрону + два режима работы
// (short_range / long_range, см. utils/droneProfiles) и видеоканал.
// Персистится в ключе tq-fleet; при миграции v1 назначения сохраняются.
// Симуляция/телеметрия дронов (DroneSim/FleetManager) подключаются сюда
// через контроллеры (Map вне state) — сейчас здесь чистые данные.
// ═══════════════════════════════════════════════════════════════
import { create } from 'zustand';
import type { StateCreator } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { DroneAssignment, DroneVideoState } from '../types';
import { MAX_FLEET_SIZE } from '../types';
import {
  DRONE_PROFILES, getProfile, modeFromCapabilities, videoLinkStatus,
  type DroneMode, type DroneClass,
} from '../utils/droneProfiles';

/** Дрон, зарегистрированный в парке (упрощённая запись стора). */
export interface FleetDroneRecord {
  droneId: string;
  connectionString: string;
  capabilities: string[];
  /** Режим работы (профиль полёта). */
  mode: DroneMode;
  /** Класс применения: обычный / агродрон. */
  droneClass: DroneClass;
  /** Включён ли запрос видеопотока на GCS. */
  videoRequested: boolean;
}

export interface FleetState {
  /** Назначения дронам/группам: старт, цель, маршрут. */
  droneAssignments: DroneAssignment[];
  /** Зарегистрированные дроны парка с профилями режимов. */
  drones: FleetDroneRecord[];
  /** Выбранный дрон (для панели видео/телеметрии). */
  selectedDroneId: string | null;
  /** Индивидуальные точки старта по индексу дрона (null = общий старт).
   *  Store-first: переживают unmount MapCanvas (смена карты/панели). */
  droneStarts: Array<{ lat: number; lng: number } | null>;
  /** Индивидуальные точки цели по индексу дрона. */
  droneGoals: Array<{ lat: number; lng: number } | null>;
}

export interface FleetActions {
  setDroneAssignment: (droneId: string, patch: Partial<Omit<DroneAssignment, 'droneId'>>) => void;
  removeDroneAssignment: (droneId: string) => void;
  resetFleet: () => void;
  /** Регистрация дрона; режим берётся из capabilities ('mode:long_range') или параметра. */
  registerDrone: (droneId: string, connectionString: string, capabilities: string[], opts?: { mode?: DroneMode; droneClass?: DroneClass }) => void;
  unregisterDrone: (droneId: string) => void;
  setDroneMode: (droneId: string, mode: DroneMode) => void;
  setDroneClass: (droneId: string, cls: DroneClass) => void;
  selectDrone: (id: string | null) => void;
  /** Запрос/останов видеосигнала (симуляция стрима). */
  requestVideo: (droneId: string, on: boolean) => void;
  /** Актуальный статус видеоканала дрона на заданной дистанции от GCS. */
  videoStatusFor: (droneId: string, distanceM: number) => DroneVideoState;
  /** Установка индивидуальной точки старта i-го дрона (null = сброс). */
  setDroneStartAt: (index: number, geo: { lat: number; lng: number } | null) => void;
  /** Установка индивидуальной точки цели i-го дрона. */
  setDroneGoalAt: (index: number, geo: { lat: number; lng: number } | null) => void;
}

export type FleetStore = FleetState & FleetActions;

const initialFleetState: FleetState = {
  droneAssignments: [],
  drones: [],
  selectedDroneId: null,
  droneStarts: [],
  droneGoals: [],
};

/** Индекс должен лежать в диапазоне парка [0, MAX_FLEET_SIZE); иначе — игнор. */
function clampIndex(i: number): number | null {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_FLEET_SIZE) return null;
  return i;
}

/** Иммутабельная установка значения в разреженном массиве гео-точек. */
function setAt(arr: Array<{ lat: number; lng: number } | null>, i: number, v: { lat: number; lng: number } | null): Array<{ lat: number; lng: number } | null> {
  const next = [...arr];
  while (next.length < i) next.push(null);
  next[i] = v;
  // обрезаем хвост из null-ов, чтобы persist не раздувался
  let end = next.length;
  while (end > 0 && next[end - 1] === null) end--;
  return next.slice(0, end);
}

const createFleetActions: StateCreator<FleetStore, [], [], FleetActions> = (set, get) => ({
  setDroneAssignment: (droneId, patch) =>
    set((state) => {
      const idx = state.droneAssignments.findIndex((d) => d.droneId === droneId);
      const next = [...state.droneAssignments];
      if (idx >= 0) next[idx] = { ...next[idx], ...patch };
      else next.push({ droneId, startId: null, goalId: null, routeId: null, ...patch });
      return { droneAssignments: next };
    }),

  removeDroneAssignment: (droneId) =>
    set((state) => ({ droneAssignments: state.droneAssignments.filter((d) => d.droneId !== droneId) })),

  resetFleet: () => set({ droneAssignments: [], drones: [], selectedDroneId: null, droneStarts: [], droneGoals: [] }),

  registerDrone: (droneId, connectionString, capabilities, opts) => {
    const id = droneId.trim();
    if (!id) return;
    const mode: DroneMode = opts?.mode ?? modeFromCapabilities(capabilities) ?? 'short_range';
    const droneClass: DroneClass = opts?.droneClass ?? (capabilities.some((c) => /^agri$/i.test(c.trim())) ? 'agri' : 'standard');
    set((state) => ({
      drones: [
        ...state.drones.filter((d) => d.droneId !== id),
        { droneId: id, connectionString: connectionString.trim(), capabilities: [...capabilities], mode, droneClass, videoRequested: false },
      ],
    }));
  },

  unregisterDrone: (droneId) =>
    set((state) => ({
      drones: state.drones.filter((d) => d.droneId !== droneId),
      droneAssignments: state.droneAssignments.filter((a) => a.droneId !== droneId),
      selectedDroneId: state.selectedDroneId === droneId ? null : state.selectedDroneId,
    })),

  setDroneMode: (droneId, mode) => {
    if (!(mode in DRONE_PROFILES)) return; // неизвестный режим — игнор (валидация на границе)
    set((state) => ({ drones: state.drones.map((d) => (d.droneId === droneId ? { ...d, mode } : d)) }));
  },

  setDroneClass: (droneId, cls) =>
    set((state) => ({ drones: state.drones.map((d) => (d.droneId === droneId ? { ...d, droneClass: cls } : d)) })),

  selectDrone: (id) => set({ selectedDroneId: id }),

  requestVideo: (droneId, on) =>
    set((state) => ({ drones: state.drones.map((d) => (d.droneId === droneId ? { ...d, videoRequested: on } : d)) })),

  videoStatusFor: (droneId, distanceM) => {
    const rec = get().drones.find((d) => d.droneId === droneId);
    if (!rec) return { streaming: false, requested: false, ok: false, note: 'Дрон не зарегистрирован' };
    const link = videoLinkStatus(Math.max(0, Number.isFinite(distanceM) ? distanceM : 0), rec.mode);
    const profile = getProfile(rec.mode);
    const streaming = rec.videoRequested && link.ok;
    const note = !rec.videoRequested
      ? `Видео выключено (${profile.label})`
      : link.ok
        ? `${link.note}${rec.droneClass === 'agri' ? ' • агрокамера мультиспектр' : ''}`
        : `Нет потока: ${link.note}`;
    return { streaming, requested: rec.videoRequested, ok: link.ok, note };
  },

  setDroneStartAt: (index, geo) => {
    const i = clampIndex(index);
    if (i === null) return;
    // Валидация координат: [-90..90] / [-180..180], только конечные числа
    if (geo !== null && (!Number.isFinite(geo.lat) || !Number.isFinite(geo.lng))) return;
    if (geo !== null && (geo.lat < -90 || geo.lat > 90 || geo.lng < -180 || geo.lng > 180)) return;
    set((state) => ({ droneStarts: setAt(state.droneStarts, i, geo) }));
  },

  setDroneGoalAt: (index, geo) => {
    const i = clampIndex(index);
    if (i === null) return;
    if (geo !== null && (!Number.isFinite(geo.lat) || !Number.isFinite(geo.lng))) return;
    if (geo !== null && (geo.lat < -90 || geo.lat > 90 || geo.lng < -180 || geo.lng > 180)) return;
    set((state) => ({ droneGoals: setAt(state.droneGoals, i, geo) }));
  },
});

export const useFleetStore = create<FleetStore>()(
  persist(
    (...a) => ({ ...initialFleetState, ...createFleetActions(...a) }),
    {
      name: 'tq-fleet',
      version: 3,
      storage: createJSONStorage(() => localStorage),
      partialize: (s): FleetState => ({
        droneAssignments: s.droneAssignments,
        drones: s.drones,
        selectedDroneId: s.selectedDroneId,
        droneStarts: s.droneStarts,
        droneGoals: s.droneGoals,
      }),
      migrate: (persistedState: unknown, version: number) => {
        const p = persistedState as Partial<FleetState>;
        if (!Array.isArray(p.droneAssignments)) p.droneAssignments = [];
        if (!Array.isArray(p.drones)) p.drones = [];
        if (version < 2) {
          // v1: дронов не было — добавляем пустой список (режим по умолчанию short_range)
          p.drones = [];
          p.selectedDroneId = null;
        }
        if (version < 3) {
          // v2: индивидуальных стартов/целей по индексам не было
          if (!Array.isArray(p.droneStarts)) p.droneStarts = [];
          if (!Array.isArray(p.droneGoals)) p.droneGoals = [];
        }
        return p as FleetState;
      },
    },
  ),
);

// ─── Кастомные хуки-селекторы (точечные подписки, без лишних ререндеров) ────

/** Все дальнобойные дроны парка. */
export const useLongRangeDrones = (): FleetDroneRecord[] =>
  useFleetStore((s) => s.drones.filter((d) => d.mode === 'long_range'));

/** Все короткодистанционные дроны (в т.ч. агродроны). */
export const useShortRangeDrones = (): FleetDroneRecord[] =>
  useFleetStore((s) => s.drones.filter((d) => d.mode === 'short_range'));

/** Агродроны отдельной выборкой. */
export const useAgriDrones = (): FleetDroneRecord[] =>
  useFleetStore((s) => s.drones.filter((d) => d.droneClass === 'agri'));
