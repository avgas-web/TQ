// ЭТАП 5: бесполётные зоны + автоматический пересчёт маршрутов с проверкой
// дальности, индикатором пересчёта и подтверждением игнорирования warnings.
import { useEffect, useRef, useState, type MouseEvent as RMouseEvent } from 'react';
import { useMissionWizardStore, type NoFlyZone } from '../../store/useMissionWizardStore';
import { craftMaxRangeMeters } from './craftOptions';

const W = 640; const H = 480;

export function NFZAndRoutesStep() {
  const s = useMissionWizardStore();
  const [drawing, setDrawing] = useState<{ x: number; y: number }[]>([]);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const svgRef = useRef<SVGSVGElement>(null);

  // автоматический пересчёт при любом изменении NFZ/точек (обход обязателен)
  const zonesKey = JSON.stringify(s.noFlyZones.map((z) => z.polygon));
  useEffect(() => {
    let cancelled = false;
    setCalculating(true);
    const maxRange = s.craftType ? craftMaxRangeMeters(s.craftType) : Infinity;
    void s.calculateRoutes(maxRange).finally(() => { if (!cancelled) setCalculating(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zonesKey, s.startPoints.length, s.targetPoints.length, s.fleetGroups.length, s.craftType]);

  const toXY = (e: RMouseEvent): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: ((e.clientX - rect.left) / rect.width) * W, y: ((e.clientY - rect.top) / rect.height) * H };
  };

  const finishPolygon = () => {
    if (drawing.length >= 3) {
      s.addNoFlyZone({ name: `NFZ ${s.noFlyZones.length + 1}`, polygon: drawing });
    } else {
      s.runValidationAndPublish();
    }
    setDrawing([]);
  };

  const routesToShow = showAll ? s.calculatedRoutes : s.calculatedRoutes.filter((r) => r.blockedByNfz || r.exceedsRange);
  const problems = s.calculatedRoutes.filter((r) => r.blockedByNfz || (r.exceedsRange && !r.acknowledged));

  return (
    <div className="flex h-full gap-3 overflow-hidden p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h2 className="text-lg font-bold text-red-300">Этап 5. Бесполётные зоны и маршруты</h2>
        <p className="text-xs text-slate-400" role="note">
          Кликами рисуйте полигон зоны: минимум 3 точки, двойной клик или Enter — завершить, Esc — отмена. Маршруты пересчитываются в обход зон автоматически.
        </p>
        <svg
          ref={svgRef}
          data-testid="nfz-map"
          viewBox={`0 0 ${W} ${H}`}
          className="w-full cursor-crosshair rounded border border-slate-700 bg-slate-950"
          onClick={(e) => setDrawing((d) => [...d, toXY(e)])}
          onDoubleClick={() => finishPolygon()}
          onMouseMove={(e) => setCursor(toXY(e))}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finishPolygon();
            if (e.key === 'Escape') setDrawing([]);
          }}
        >
          {s.noFlyZones.map((z: NoFlyZone) => (
            <polygon key={z.id} points={z.polygon.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="rgba(239,68,68,0.3)" stroke="#ef4444" strokeWidth={2}>
              <title>{z.name}</title>
            </polygon>
          ))}
          {/* черновик полигона: preview + номера вершин */}
          {drawing.length > 0 && (
            <>
              <polyline points={drawing.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none" stroke="#fca5a5" strokeWidth={1.5} strokeDasharray="6 4" />
              {cursor && drawing.length > 0 && (
                <line x1={drawing[drawing.length - 1].x} y1={drawing[drawing.length - 1].y}
                  x2={cursor.x} y2={cursor.y} stroke="#fca5a5" strokeDasharray="4 4" />
              )}
              {drawing.map((p, i) => (
                <g key={i}>
                  <circle cx={p.x} cy={p.y} r={5} fill="#fca5a5" />
                  <text x={p.x + 7} y={p.y - 7} fontSize={12} fill="#fecaca">{i + 1}</text>
                </g>
              ))}
            </>
          )}
          {routesToShow.map((r, i) => (
            <polyline key={r.id}
              points={r.points.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={r.blockedByNfz ? '#ef4444' : r.exceedsRange ? '#facc15' : ['#00d0ff', '#34d399', '#a78bfa'][i % 3]}
              strokeWidth={2} opacity={0.9}>
              <title>{`Длина ${(r.lengthMeters / 1000).toFixed(1)} км${r.blockedByNfz ? ' · зона блокирует путь!' : r.exceedsRange ? ' · превышение дальности' : ''}`}</title>
            </polyline>
          ))}
          {s.startPoints.map((p) => <circle key={p.id} cx={p.x} cy={p.y} r={5} fill="#00d0ff" />)}
          {s.targetPoints.map((p) => <circle key={p.id} cx={p.x} cy={p.y} r={5} fill="#f472b6" />)}
        </svg>
        <div className="flex items-center gap-3 text-xs">
          {drawing.length > 0 && (
            <button type="button" className="btn-secondary" onClick={() => setDrawing((d) => d.slice(0, -1))}>
              ⌫ Отменить последнюю точку
            </button>
          )}
          <label><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Показать все маршруты</label>
          {calculating && <span data-testid="recalc-indicator" role="status" className="animate-pulse text-cyan-300">⟳ Пересчет маршрутов…</span>}
        </div>
        {problems.length > 0 && (
          <div data-testid="range-warning-banner" role="alert" className="rounded bg-yellow-900/50 p-2 text-xs text-yellow-200">
            Проблемные маршруты: {problems.length}.{' '}
            {problems.some((r) => r.blockedByNfz) && 'Есть полностью заблокированные зоны — удалите или переместите зону. '}
            {!calculating && s.calculatedRoutes.some((r) => r.exceedsRange && !r.acknowledged) && (
              <button type="button" className="btn-secondary ml-1" onClick={() => s.acknowledgeRouteIssues()}>
                Подтвердить игнорирование превышений дальности
              </button>
            )}
          </div>
        )}
      </div>
      <aside className="w-72 shrink-0 overflow-auto border-l border-slate-800 p-2 text-xs" aria-label="Список NFZ">
        <h3 className="font-bold text-red-300">Бесполётные зоны ({s.noFlyZones.length})</h3>
        <ul>
          {s.noFlyZones.map((z) => (
            <li key={z.id} className="mt-1 flex items-center justify-between rounded bg-slate-800/60 px-2 py-1">
              <span>{z.name} · {z.polygon.length} верш.</span>
              <button type="button" aria-label={`Удалить зону ${z.name}`} className="text-red-400" onClick={() => s.removeNoFlyZone(z.id)}>✛</button>
            </li>
          ))}
        </ul>
        <h3 className="mt-3 font-bold text-cyan-300">Маршруты ({s.calculatedRoutes.length})</h3>
        <ul>
          {s.calculatedRoutes.map((r) => {
            const sp = s.startPoints.find((p) => p.id === r.startPointId);
            const tp = s.targetPoints.find((p) => p.id === r.targetPointId);
            return (
              <li key={r.id} className="mt-1 rounded bg-slate-800/60 px-2 py-1">
                {sp?.name} → {tp?.name} · {(r.lengthMeters / 1000).toFixed(1)} км
                {r.blockedByNfz && <span className="text-red-400"> ✗ блок</span>}
                {r.exceedsRange && <span className="text-yellow-300"> ⚠ дальность</span>}
                {!r.blockedByNfz && !r.exceedsRange && <span className="text-green-400"> ✓</span>}
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}
