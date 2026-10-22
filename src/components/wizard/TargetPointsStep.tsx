// ЭТАП 3: точки целей — аналог Этапа 2 + лимит 1000, группировка по расстоянию
// от ближайшего старта, tooltip с дистанцией, warning при цели <50 м от старта.
import { useMemo, useState } from 'react';
import {
  useMissionWizardStore, MAX_TARGET_POINTS, geoDistanceM, type TargetPoint,
} from '../../store/useMissionWizardStore';
import { MiniMapCanvas, readCanvasClick } from './StartPointsStep';
import { WizardMapPanel } from './WizardMapPanel';
import { isMapReadyNow, useMapReadiness } from './mapReadiness';
import { useWizardMapBridge } from './useWizardMapBridge';

export function TargetPointsStep() {
  const targetPoints = useMissionWizardStore((s) => s.targetPoints);
  const startPoints = useMissionWizardStore((s) => s.startPoints);
  const addTargetPoint = useMissionWizardStore((s) => s.addTargetPoint);
  const updateTargetPoint = useMissionWizardStore((s) => s.updateTargetPoint);
  const removeTargetPoint = useMissionWizardStore((s) => s.removeTargetPoint);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Мост мастер↔карта: цели видны на живой подложке, drag обновляет координаты.
  useWizardMapBridge();
  // ЖЁСТКОЕ ТРЕБОВАНИЕ: цели ставятся ТОЛЬКО на загруженную карту (см. mapReadiness).
  const [mapLoaded, setMapLoaded] = useState(false);
  const readiness = useMapReadiness(mapLoaded);

  /** расстояние до ближайшего старта для каждой цели */
  const withDist = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of targetPoints) {
      let min = Infinity;
      for (const sp of startPoints) min = Math.min(min, geoDistanceM(t.lat, t.lon, sp.lat, sp.lon));
      map.set(t.id, Number.isFinite(min) ? min : Infinity);
    }
    return map;
  }, [targetPoints, startPoints]);

  /** группировка по «десятки километров» от ближайшего старта */
  const grouped = useMemo(() => {
    const groups = new Map<string, TargetPoint[]>();
    const sorted = [...targetPoints].sort((a, b) => (withDist.get(a.id) ?? 0) - (withDist.get(b.id) ?? 0));
    for (const t of sorted) {
      const d = withDist.get(t.id) ?? Infinity;
      const key = !Number.isFinite(d) ? 'нет стартов'
        : d < 10000 ? '< 10 км' : d < 50000 ? '10–50 км' : d < 200000 ? '50–200 км' : '> 200 км';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    return [...groups.entries()];
  }, [targetPoints, withDist]);

  const addAt = (x: number, y: number, lat: number, lon: number) =>
    addTargetPoint({ name: `Цель ${targetPoints.length + 1}`, lat, lon, x, y });

  return (
    <div className="flex h-full gap-3 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <h2 className="text-lg font-bold text-pink-300">Этап 3. Точки целей</h2>
        <p className="text-xs text-slate-400">
          Клик по карте добавляет цель (розовый маркер). Цель не должна совпадать со стартом ближе 50 метров.
        </p>
        <MiniMapCanvas
          kind="target"
          points={targetPoints}
          onAdd={addAt}
          onMove={(id, x, y, lat, lon) => updateTargetPoint(id, { x, y, lat, lon })}
        />
        {/* Живая тайловая карта: клик добавляет цель только когда подложка
            реально загружена; до готовности — оверлей-заглушка блокирует клики. */}
        <div
          className="relative min-h-0 flex-1"
          data-testid="wizard-live-map-target"
          onClick={(e) => {
            if (!isMapReadyNow(mapLoaded)) return; // источник истины: карта не загружена — точки не ставим
            const g = readCanvasClick(e);
            if (g) addAt(g.x, g.y, g.lat, g.lon);
          }}
        >
          <WizardMapPanel
            hint={readiness.ready
              ? '🖱️ Клик по живой карте — поставить цель · перетаскивайте маркеры напрямую'
              : '⏳ Дождитесь загрузки карты — на пустом поле цели не ставятся'}
            onMapLoaded={setMapLoaded}
          />
          {!readiness.ready && (
            <div
              role="alert"
              data-testid="wizard-map-not-ready-overlay-target"
              className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/70 p-4 text-center"
            >
              <p className="max-w-sm rounded-md border border-amber-500 bg-slate-900/95 px-3 py-2 text-xs text-amber-300">
                ⏳ {readiness.reason ?? 'Карта загружается…'}
              </p>
            </div>
          )}
        </div>
      </div>
      <aside className="w-80 shrink-0 overflow-auto border-l border-slate-800 p-3" aria-label="Список целей">
        <p className="mb-2 text-sm font-semibold">{targetPoints.length}/{MAX_TARGET_POINTS} целей</p>
        {grouped.map(([key, list]) => (
          <div key={key} className="mb-3">
            <h4 className="text-xs font-bold uppercase text-slate-500">от ближайшего старта: {key}</h4>
            <ul className="flex flex-col gap-1">
              {list.map((t) => {
                const d = withDist.get(t.id);
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(t.id)}
                      className={
                        'w-full rounded px-2 py-1 text-left text-xs ' +
                        (selectedId === t.id ? 'bg-pink-900/60 ring-1 ring-pink-400' : 'bg-slate-800/60 hover:bg-slate-700')
                      }
                      title={`${t.name}: ${t.lat.toFixed(4)}, ${t.lon.toFixed(4)} · ${d !== undefined && Number.isFinite(d) ? `${Math.round(d)} м до старта` : 'нет стартов'}`}
                    >
                      <span className="font-bold text-pink-300">{t.name}</span>
                      {t.nearStartWarning && <span className="ml-1 text-yellow-300">⚠ близко к старту</span>}
                      <br />
                      <span className="text-slate-400">
                        {d !== undefined && Number.isFinite(d) ? `${(d / 1000).toFixed(1)} км до старта` : '—'}
                      </span>
                      <button
                        type="button"
                        aria-label={`Удалить цель ${t.name}`}
                        className="ml-2 text-red-400 hover:text-red-300"
                        onClick={(e) => { e.stopPropagation(); removeTargetPoint(t.id); }}
                      >✛</button>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </aside>
    </div>
  );
}
