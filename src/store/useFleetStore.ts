// ═══════════════════════════════════════════════════════════════
// useFleetStore — доменный стор парка БПЛА (Domain-Driven Split #3)
// Назначения «старт/цель/маршрут» каждому дрону. Персистится в том же
// ключе, что и раньше (totalquadro-storage → поле droneAssignments),
// чтобы не терять пользовательские назначения при миграции.
// Симуляция/телеметрия дронов (DroneSim/FleetManager) подключаются сюда
// отдельным этапом — сейчас здесь чистые данные назначений.
// ═══════════════════════════════════════════════════════════════
import { create } from 'zustand';
import type { StateCreator } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { DroneAssignment } from '../types';

export interface FleetState {
  /** Назначения дронам/группам: старт, цель, маршрут. */
  droneAssignments: DroneAssignment[];
}

export interface FleetActions {
  setDroneAssignment: (droneId: string, patch: Partial<Omit<DroneAssignment, 'droneId'>>) => void;
  removeDroneAssignment: (droneId: string) => void;
  resetFleet: () => void;
}

export type FleetStore = FleetState & FleetActions;

const initialFleetState: FleetState = { droneAssignments: [] };

const createFleetActions: StateCreator<FleetStore, [], [], FleetActions> = (set) => ({
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

  resetFleet: () => set({ droneAssignments: [] }),
});

export const useFleetStore = create<FleetStore>()(
  persist(
    (...a) => ({ ...initialFleetState, ...createFleetActions(...a) }),
    {
      name: 'tq-fleet',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s): FleetState => ({ droneAssignments: s.droneAssignments }),
      migrate: (persistedState: unknown) => {
        const p = persistedState as Partial<FleetState>;
        if (!Array.isArray(p.droneAssignments)) p.droneAssignments = [];
        return p as FleetState;
      },
    },
  ),
);
