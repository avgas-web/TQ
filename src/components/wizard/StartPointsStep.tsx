// ЭТАП 2: точки старта — клик по карте, поиск (координаты/геокодер),
// drag маркеров БЕЗ автофиксации карты, список в сайдбаре, лимит 100.
import { useEffect, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import {
  useMissionWizardStore, MAX_START_POINTS, parseCoordinateQuery,
  pxToLon, pyToLat, lonToPx, latToPy, type StartPoint,
} from '../../store/useMissionWizardStore';
import { WizardMapPanel } from './WizardMapPanel';
import { WIZARD_MARKER_PREFIX, useWizardMapBridge } from './useWizardMapBridge';

/** Клик по живой тайловой карте мастера → координаты WGS84 + пиксели карты.
 *  Формула конвертации экрана→карты: mapX = (screenX − offsetX) / scale
 *  (реализована в screenToMapPoint из utils/mapInteraction — та же, что и для
 *  legacy-инструментов, поэтому точки с карты и с мини-карты эквивалентны). */
function readCanvasClick(e: RMouseEvent<HTMLDivElement>): { x: number; y: number; lat: number; lon: number } | null {
  const rect = e.currentTarget.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null; // контейнер не готов (ResizeObserver ещё не отработал)
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) return null;
  // Нормализованные доли → география через ту же проекцию мастера (equirect-canvas
  // остаётся валидной сеткой привязки; реальная Mercator-привязка выполняется
  // мостом к маркерам MapCanvas при активной тайловой подложке).
  const nx = Math.max(0, Math.min(1, sx / rect.width));
  const ny = Math.max(0, Math.min(1, sy / rect.height));
  const x = nx * 1000;
  const y = ny * 700;
  return { x, y, lat: pyToLat(y), lon: pxToLon(x) };
}

/** Геокодер вынесен в модуль — подменяется fetch-моком в тестах (Nominatim). */
export async function geocode(query: string): Promise<{ lat: number; lon: number; name: string } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0] as { lat?: string; lon?: string; display_name?: string };
    const lat = Number(first.lat);
    const lon = Number(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, name: first.display_name ?? query };
  } catch {
    return null;
  }
}

export interface MiniMapCanvasProps {
  kind: 'start' | 'target';
  points: StartPoint[];
  onAdd: (x: number, y: number, lat: number, lon: number) => void;
  onMove: (id: string, x: number, y: number, lat: number, lon: number) => void;
}

const W = 640; const H = 480;
// проекция пиксели↔координаты — единая для всего мастера (из стора)

/** Кликабельно-дрэгабельная мини-карта мастера. Никакого auto-fit при изменении точек. */
export function MiniMapCanvas({ kind, points, onAdd, onMove }: MiniMapCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const color = kind === 'start' ? '#00d0ff' : '#f472b6';

  const toXY = (e: RMouseEvent | RPointerEvent): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(W, ((e.clientX - rect.left) / rect.width) * W)),
      y: Math.max(0, Math.min(H, ((e.clientY - rect.top) / rect.height) * H)),
    };
  };

  return (
    <svg
      ref={svgRef}
      data-testid={`minimap-${kind}`}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full cursor-crosshair rounded border border-slate-700 bg-slate-950"
      onClick={(e) => {
        if (dragId) return; // завершили drags — не добавляем точку
        const { x, y } = toXY(e);
        onAdd(x, y, pyToLat(y), pxToLon(x));
      }}
      onPointerMove={(e) => {
        if (!dragId) return;
        const { x, y } = toXY(e);
        onMove(dragId, x, y, pyToLat(y), pxToLon(x));
      }}
      onPointerUp={() => setDragId(null)}
      onPointerLeave={() => setDragId(null)}
    >
      {/* сетка */}
      {[...Array(10)].map((_, i) => (
        <line key={`v${i}`} x1={(i * W) / 10} y1={0} x2={(i * W) / 10} y2={H} stroke="#1e293b" />
      ))}
      {[...Array(8)].map((_, i) => (
        <line key={`h${i}`} x1={0} y1={(i * H) / 8} x2={W} y2={(i * H) / 8} stroke="#1e293b" />
      ))}
      {points.map((p, idx) => (
        <g key={p.id} data-testid={`marker-${kind}-${idx + 1}`}>
          <title>{`${p.name}: ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`}</title>
          <circle
            cx={lonToPx(p.lon)} cy={latToPy(p.lat)} r={9}
            fill={color} opacity={0.85}
            style={{ cursor: 'grab' }}
            onPointerDown={(e) => { e.stopPropagation(); setDragId(p.id); }}
            onClick={(e) => e.stopPropagation()}
          />
          <text x={lonToPx(p.lon) + 12} y={latToPy(p.lat) - 8} fill="#e2e8f0" fontSize={12}>{idx + 1}</text>
        </g>
      ))}
    </svg>
  );
}

export function StartPointsStep() {
  // Мост мастер↔карта: точки старта/целей видны на живой подложке, drag на
  // карте обновляет координаты в сторе мастера (без авто-фиксации камеры).
  useWizardMapBridge();
  const startPoints = useMissionWizardStore((s) => s.startPoints);
  const addStartPoint = useMissionWizardStore((s) => s.addStartPoint);
  const updateStartPoint = useMissionWizardStore((s) => s.updateStartPoint);
  const removeStartPoint = useMissionWizardStore((s) => s.removeStartPoint);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const addAt = (x: number, y: number, lat: number, lon: number) =>
    addStartPoint({ name: `Старт ${startPoints.length + 1}`, lat, lon, x, y });

  const doSearch = async () => {
    const coords = parseCoordinateQuery(query);
    if (coords) {
      addStartPoint({
        name: `Старт ${startPoints.length + 1}`,
        lat: coords.lat, lon: coords.lon,
        x: lonToPx(coords.lon), y: latToPy(coords.lat),
      });
      setQuery('');
      return;
    }
    if (!query.trim()) return;
    const geo = await geocode(query);
    if (!geo) {
      useMissionWizardStore.getState().runValidationAndPublish();
      addStartPoint({ name: '__invalid__', lat: NaN, lon: NaN, x: 0, y: 0 }); // триггерит ошибку формата
      return;
    }
    addStartPoint({ name: geo.name.slice(0, 40), lat: geo.lat, lon: geo.lon, x: lonToPx(geo.lon), y: latToPy(geo.lat) });
    setQuery('');
  };

  return (
    <div className="flex h-full gap-3 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <h2 className="text-lg font-bold text-cyan-300">Этап 2. Точки старта</h2>
        <p className="text-xs text-slate-400">
          Кликните по карте, чтобы поставить точку, или найдите место через поиск («Москва, Красная площадь» или «55.7558, 37.6173»). Маркеры можно перетаскивать.
        </p>
        <div className="flex gap-2">
          <input
            aria-label="Поиск точки старта"
            className="input-dark flex-1"
            placeholder="Адрес или координаты «широта, долгота»…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(); }}
          />
          <button type="button" className="btn-secondary" onClick={() => void doSearch()}>Найти</button>
        </div>
        <MiniMapCanvas
          kind="start"
          points={startPoints}
          onAdd={addAt}
          onMove={(id, x, y, lat, lon) => updateStartPoint(id, { x, y, lat, lon })}
        />
        {/* Живая тайловая карта (OSM/2ГИС/Carto/Topo): тот же MapCanvas, что и в
            редакторе. Клик по карте добавляет точку старта, маркеры мастера
            синхронизированы через useWizardMapBridge (двусторонний мост). */}
        <div
          className="relative min-h-0 flex-1"
          data-testid="wizard-live-map-start"
          onClick={(e) => {
            const g = readCanvasClick(e);
            if (g) addAt(g.x, g.y, g.lat, g.lon);
          }}
        >
          <WizardMapPanel hint="🖱️ Клик по живой карте — поставить точку старта · перетаскивайте маркеры напрямую" />
        </div>
      </div>
      <aside className="w-72 shrink-0 overflow-auto border-l border-slate-800 p-3" aria-label="Список точек старта">
        <p className="mb-2 text-sm font-semibold">{startPoints.length}/{MAX_START_POINTS} точек</p>
        <ul className="flex flex-col gap-1">
          {startPoints.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                data-testid={`start-item-${i + 1}`}
                onClick={() => setSelectedId(p.id)}
                className={
                  'w-full rounded px-2 py-1 text-left text-xs ' +
                  (selectedId === p.id ? 'bg-cyan-900/70 ring-1 ring-cyan-400' : 'bg-slate-800/60 hover:bg-slate-700')
                }
              >
                <span className="font-bold text-cyan-300">{i + 1}. {p.name}</span>
                <br />
                <span className="text-slate-400">{p.lat.toFixed(4)}, {p.lon.toFixed(4)}</span>
                <button
                  type="button"
                  aria-label={`Удалить точку ${p.name}`}
                  className="ml-2 text-red-400 hover:text-red-300"
                  onClick={(e) => { e.stopPropagation(); removeStartPoint(p.id); }}
                >✛</button>
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
