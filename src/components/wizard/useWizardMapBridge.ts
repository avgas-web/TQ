// useWizardMapBridge — двусторонний мост между доменом мастера
// (useMissionWizardStore: startPoints/targetPoints) и картографическим
// стором (useStore.project.markers), которым управляет MapCanvas.
//
// ЗАПРЕТ НА ДЕСТРУКТИВНУЮ СИНХРОНИЗАЦИЮ: legacy-маркеры пользователя
// («Редактор») никогда не удаляются мастером — синхронизация помечает
// мастер-маркеры префиксом id 'wz:' и обновляет/удаляет ТОЛЬКО их.
// Обратный канал: drag маркера на карте → updateStartPoint/updateTargetPoint
// в сторе мастера (с сохранением названия, без авто-фиксации камеры).
import { useEffect } from 'react';
import { useMapStore } from '../../store/useMapStore';
import { useMissionWizardStore, type GeoPointData } from '../../store/useMissionWizardStore';
import type { Marker } from '../../types';

export const WIZARD_MARKER_PREFIX = 'wz:';

type Kind = 'start' | 'target';

const KIND_COLOR: Record<Kind, string> = { start: '#22d3ee', target: '#f472b6' };

interface WizardBinding {
  kind: Kind;
  pointId: string;
}

function parseBinding(markerId: string): WizardBinding | null {
  if (!markerId.startsWith(WIZARD_MARKER_PREFIX)) return null;
  const rest = markerId.slice(WIZARD_MARKER_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const kind = rest.slice(0, sep);
  if (kind !== 'start' && kind !== 'target') return null;
  return { kind, pointId: rest.slice(sep + 1) };
}

/** Прямой канал: точки мастера → маркеры карты (идемпотентная upsert-синхронизация).
 *  ВАЖНО (стабильность): синхронизация выполняется ВНЕ фазы рендера React —
 *  через useEffect + queueMicrotask. Прямой вызов из тела компонента приводил
 *  к setState(useMapStore) во время рендера другого компонента, что при
 *  каскаде подписок zustand→shim→useSyncExternalStore вызывало конкурентный
 *  рендер посреди рендера («Should not already be working», краш Wizard). */
export function syncWizardMarkers(): void {
  // КОРНЕВОЙ ФИКС КРАША «Should not already be working» (React error #127):
  // фасад useStore.getState() возвращает merged-объект, при каждой сборке
  // которго spread'ом раскрываются ВСЕ экшены доменных сторов. Spread
  // zustand-стора вызывает его геттер `get`, то есть фактически
  // useSyncExternalStore.getSnapshot() шима ПРЯМО В ФАЗЕ РЕНДЕРА другого
  // компонента (queueMicrotask после setState в обработчике клика React ещё
  // считает дерево). React трактует это как конкурентный рендер посреди
  // рендера → «performConcurrentWorkOnRoot: Should not already be working».
  // Мосту нужны только маркеры — читаем их напрямую из доменного useMapStore
  // (единственный источник истины для project.markers), без сборки агрегата.
  const w = useMissionWizardStore.getState();
  const existingMarkers = useMapStore.getState().markers;
  const desired = new Map<string, Pick<Marker, 'name' | 'lat' | 'lon' | 'x' | 'y' | 'color'>>();
  for (const p of w.startPoints) {
    desired.set(`${WIZARD_MARKER_PREFIX}start:${p.id}`, { name: `▶ ${p.name}`, lat: p.lat, lon: p.lon, x: p.x, y: p.y, color: KIND_COLOR.start });
  }
  for (const p of w.targetPoints) {
    desired.set(`${WIZARD_MARKER_PREFIX}target:${p.id}`, { name: `◎ ${p.name}`, lat: p.lat, lon: p.lon, x: p.x, y: p.y, color: KIND_COLOR.target });
  }

  const existingIds = new Set(existingMarkers.map((m) => m.id));
  let markers: Marker[] = existingMarkers.map((m) => {
    const d = desired.get(m.id);
    // Обновляем только «наши» мастер-маркеры (позиция/имя могли измениться в мастере).
    return d ? { ...m, ...d } : m;
  });
  for (const [id, d] of desired) {
    if (!existingIds.has(id)) {
      markers = [...markers, {
        id, ...d,
        type: 'wizard', comment: 'Мастер миссий', layer: 'default',
        createdAt: new Date().toISOString(),
      }];
    }
  }
  // Удаляем только мастер-маркеры, исчезнувшие из мастера (точка удалена в UI).
  markers = markers.filter((m) => !parseBinding(m.id) || desired.has(m.id));

  const changed = markers.length !== existingMarkers.length
    || markers.some((m, i) => existingMarkers[i] !== m);
  if (changed) {
    // Пишем напрямую в доменный useMapStore — без фасада useStore.setState,
    // чей merged-снапшот снова вызвал бы getSnapshot шима в небезопасный момент.
    useMapStore.setState({ markers });
  }
}

/**
 * Хук-мост: монтируется внутри шагов мастера с картой.
 * Подписки с обеих сторон защищены от циклов сравнением координат.
 */
export function useWizardMapBridge(): void {
  // Мастер → карта: при любом изменении точек мастера пересобираем маркеры.
  // Вызов через queueMicrotask: подписка zustand может сработать синхронно
  // внутри React-рендера (например, setState в обработчике клика), а мутация
  // другого стора во время рендера вызывала конкурентный рендер и краш.
  useEffect(() => {
    let cancelled = false;
    const scheduleSync = (): void => {
      if (cancelled) return;
      queueMicrotask(() => {
        if (!cancelled) syncWizardMarkers();
      });
    };
    scheduleSync();
    const unsub = useMissionWizardStore.subscribe(scheduleSync);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Карта → мастер: drag маркера на карте обновляет координаты точки мастера.
  // Подписка напрямую на доменный useMapStore (см. комментарий в syncWizardMarkers):
  // фасад useStore.subscribe передаёт merged-снапшот, сборка которого опасна
  // внутри синхронного zustand-колбэка (getSnapshot в фазе рендера → React #127).
  useEffect(() => {
    let prevMarkers = useMapStore.getState().markers;
    return useMapStore.subscribe((state) => {
      const next = state.markers;
      if (next === prevMarkers) return;
      prevMarkers = next;
      const w = useMissionWizardStore.getState();
      const apply = (kind: Kind, pointId: string, patch: Partial<GeoPointData>): void => {
        if (kind === 'start') w.updateStartPoint(pointId, patch);
        else w.updateTargetPoint(pointId, patch);
      };
      for (const m of next) {
        const b = parseBinding(m.id);
        if (!b) continue;
        if (m.lat === null || m.lon === null) continue;
        const cur = b.kind === 'start'
          ? w.startPoints.find((p) => p.id === b.pointId)
          : w.targetPoints.find((p) => p.id === b.pointId);
        if (!cur) continue;
        // Защита от эха: пишем в мастер только при реальном изменении позиции.
        if (Math.abs(cur.x - m.x) > 0.01 || Math.abs(cur.y - m.y) > 0.01) {
          apply(b.kind, b.pointId, { lat: m.lat, lon: m.lon, x: m.x, y: m.y });
        }
      }
    });
  }, []);
}
