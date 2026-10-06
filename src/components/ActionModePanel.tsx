import React, { useState } from 'react';
import { useStore } from '../store/useStore';
import { osmGeocode, loadOSMStaticMap } from '../utils/openStreetMap';
import { geoToPixelFromBounds } from '../utils/googleMaps';
import {
  parseCoordinatesString, boundsFromPoints, zoomToFitBounds, haversineDistanceM,
  bearingDeg, bearingToCompass, formatDistance, destinationPoint, isValidGeo,
} from '../utils/actionMode';
import type { GeoPoint } from '../utils/actionMode';
import type { MapData, Marker } from '../types';

interface RouteInfo {
  start: GeoPoint;
  goal: GeoPoint;
  distanceM: number;
  azimuth: number;
  rbfStart: GeoPoint; // разведка от старта (25% пути)
  rbfGoal: GeoPoint;  // разведка от цели (75% пути)
}

const ActionModePanel: React.FC = () => {
  const [startInput, setStartInput] = useState('');
  const [goalInput, setGoalInput] = useState('');
  const [zoomInput, setZoomInput] = useState(0); // 0 = авто
  const [sizeInput, setSizeInput] = useState<'1024' | '2048'>('2048');
  const [tileServer, setTileServer] = useState<'osm' | 'opentopomap' | 'carto'>('osm');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [route, setRoute] = useState<RouteInfo | null>(null);

  const { project, loadMapWithStorage, addMarker, selectMarker, actionMode, setActionMode,
    addRoute, activeRouteId, setActiveRoute, deleteRoute,
    setRouteShape, setRouteRangeLimit, importLists, clearImportLists } = useStore();
  const routesList = project.routes || [];
  const activeRoute = routesList.find((r) => r.id === activeRouteId) || null;

  // ─── Импорт списков координат (стартовые позиции / цели) ────────────────
  const [startsText, setStartsText] = useState('');
  const [goalsText, setGoalsText] = useState('');

  /** Парсинг строки списка: «метка; 55.75, 37.62» | «55.75 37.62» | таб/; разделители */
  const parseCoordList = (text: string): { label: string; lat: number; lng: number }[] => {
    const out: { label: string; lat: number; lng: number }[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let label = '';
      let coordPart = line;
      // Отделяем метку: всё до первого «;», табуляции или двоеточия, если дальше есть числа
      const m = line.match(/^(.*?)[;:\t]\s*(.+)$/);
      if (m && /\d/.test(m[2])) { label = m[1].trim(); coordPart = m[2].trim(); }
      const nums = coordPart.match(/-?\d+(?:[.,]\d+)?/g);
      if (!nums || nums.length < 2) continue;
      const lat = parseFloat(nums[0].replace(',', '.'));
      const lng = parseFloat(nums[1].replace(',', '.'));
      if (!isValidGeo({ lat, lng })) continue;
      out.push({ label: label || `Позиция ${out.length + 1}`, lat, lng });
    }
    return out;
  };

  const handleImportLists = () => {
    const starts = parseCoordList(startsText);
    const goals = parseCoordList(goalsText);
    if (starts.length === 0 || goals.length === 0) {
      setError('В обоих списках нужна хотя бы одна точка в формате «метка; 55.75, 37.62».');
      return;
    }
    setError('');
    const n = importLists(starts, goals);
    if (n > 0) setCreatedMsg(`Импортировано маршрутов: ${n} (каждая точка привязана к своему маршруту).`);
  };

  /** Быстрый старт маршрута кликами по карте (без геокодера): создать и активировать */
  const handleNewRouteByClicks = () => {
    if (!project.map) { alert('Сначала загрузите карту или постройте её по координатам старта/цели.'); return; }
    // Создаём «болванку» из двух точек в центре текущего вида — дальше пользователь тянет их мышью
    const map = project.map;
    const bounds = map.bounds;
    const c1 = bounds ? { lat: (bounds.north + bounds.south) / 2, lng: (bounds.west + bounds.east) / 2 } : null;
    if (!c1) { alert('У карты нет гео-границ — включите привязку координат.'); return; }
    const p1 = geoToPixelFromBounds(c1, bounds!, map.width, map.height);
    const p2 = { x: Math.min(map.width - 1, p1.x + 80), y: p1.y };
    const c2 = { lat: c1.lat, lng: bounds!.west + (bounds!.east - bounds!.west) * (p2.x / map.width) };
    addRoute([
      { ...p1, lat: c1.lat, lng: c1.lng },
      { ...p2, lat: c2.lat, lng: c2.lng },
    ], undefined, undefined);
  };

  /** Разрешить ввод: координаты парсятся локально, название — через OSM-геокодер */
  const resolvePlace = async (raw: string): Promise<GeoPoint> => {
    const text = raw.trim();
    if (!text) throw new Error('Пустой ввод');
    const direct = parseCoordinatesString(text);
    if (direct) return direct;
    const geo = await osmGeocode(text);
    if (geo && isValidGeo(geo)) return geo;
    throw new Error(`Не удалось определить координаты: «${text}»`);
  };

  const handleBuild = async () => {
    setError('');
    setLoading(true);
    try {
      const start = await resolvePlace(startInput);
      const goal = await resolvePlace(goalInput);

      const distanceM = haversineDistanceM(start, goal);
      const azimuth = bearingDeg(start, goal);
      const rbfStart = destinationPoint(start, distanceM * 0.25, azimuth);
      const rbfGoal = destinationPoint(start, distanceM * 0.75, azimuth);

      // Область покрытия: старт, цель и запас по азимуту
      const points = [start, goal, rbfStart, rbfGoal];
      const bounds = boundsFromPoints(points, 0.15);

      const size = parseInt(sizeInput) || 2048;
      const autoZoom = zoomToFitBounds(bounds, size, size, 19);
      const zoom = zoomInput > 0 ? Math.min(19, Math.max(1, zoomInput)) : autoZoom;

      // Центр области в пиксельных координатах зума -> точный центр под mask
      const center = { lat: (bounds.north + bounds.south) / 2, lng: (bounds.east + bounds.west) / 2 };

      const mapResult = await loadOSMStaticMap(center, zoom, size, size, tileServer);

      const mapData: MapData = {
        name: `Действие: ${startInput.trim()} → ${goalInput.trim()}`,
        width: size,
        height: size,
        dataUrl: mapResult.dataUrl,
        bounds: mapResult.bounds,
        source: 'osm',
      };
      await loadMapWithStorage(mapData);

      setRoute({ start, goal, distanceM, azimuth, rbfStart, rbfGoal });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка построения маршрута');
    } finally {
      setLoading(false);
    }
  };

  /** Все объекты строго привязываются к гео-координатам: сначала lat/lng, пиксели — производные */
  const createObjects = () => {
    if (!route || !project.map?.bounds) return;
    const map = project.map;
    let created = 0;
    const mk = (name: string, color: string, geo: GeoPoint, comment: string) => {
      // Пиксель вычисляется из ТОЧНЫХ границ загруженного изображения (Web Mercator),
      // поэтому маркер лежит ровно на своём гео-координатном месте.
      const px = geoToPixelFromBounds(geo, map.bounds!, map.width, map.height);
      addMarker({
        name,
        color,
        x: px.x,
        y: px.y,
        lat: geo.lat,
        lon: geo.lng,
        type: 'action',
        comment,
      });
      created++;
    };
    mk('СТАРТ', '#00cc44', route.start, `Старт маршрута. До цели: ${formatDistance(route.distanceM)}, азимут ${route.azimuth.toFixed(0)}°`);
    mk('ЦЕЛЬ', '#ff3333', route.goal, 'Конечная точка маршрута');
    mk('РБФ-1', '#ffaa00', route.rbfStart, 'Контрольная точка 25% маршрута');
    mk('РБФ-2', '#ffaa00', route.rbfGoal, 'Контрольная точка 75% маршрута');
    selectMarker(null);
    setCreatedMsg(`Создано объектов: ${created}. Координаты lat/lng сохранены для каждого.`);
  };

  const [createdMsg, setCreatedMsg] = useState('');

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-orange-400">🎯 Режим действий</h3>
        <label className="flex items-center gap-1 text-xs text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={actionMode}
            onChange={(e) => setActionMode(e.target.checked)}
            className="rounded"
          />
          Включён
        </label>
      </div>

      {!actionMode ? (
        <p className="text-xs text-gray-400">
          Включите режим, чтобы построить маршрут «старт → цель»: координаты определяются
          автоматически (по названию или вводом широты/долготы), карта загружается и масштабируется
          под маршрут, все объекты привязываются к реальным географическим координатам WGS-84.
        </p>
      ) : (
        <>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Место старта (название или «55.75, 37.62»)</label>
            <input
              type="text"
              value={startInput}
              onChange={(e) => setStartInput(e.target.value)}
              placeholder="Москва, Красная площадь"
              className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white placeholder-gray-500"
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-1">Место цели</label>
            <input
              type="text"
              value={goalInput}
              onChange={(e) => setGoalInput(e.target.value)}
              placeholder="55.7580, 37.6340"
              className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white placeholder-gray-500"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Зум (0=авто)</label>
              <input
                type="number"
                min={0}
                max={19}
                value={zoomInput}
                onChange={(e) => setZoomInput(parseInt(e.target.value) || 0)}
                className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Размер</label>
              <select
                value={sizeInput}
                onChange={(e) => setSizeInput(e.target.value as '1024' | '2048')}
                className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
              >
                <option value="1024">1024 px</option>
                <option value="2048">2048 px</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Тайлы</label>
              <select
                value={tileServer}
                onChange={(e) => setTileServer(e.target.value as any)}
                className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
              >
                <option value="osm">OSM</option>
                <option value="opentopomap">Topo</option>
                <option value="carto">Light</option>
              </select>
            </div>
          </div>

          <button
            onClick={handleBuild}
            disabled={loading}
            className="w-full px-3 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 text-white rounded text-sm font-medium"
          >
            {loading ? 'Определение координат и загрузка карты…' : '🚩 Определить и загрузить карту'}
          </button>

          {error && (
            <div className="p-2 bg-red-900/30 border border-red-500 rounded text-xs text-red-300">❌ {error}</div>
          )}

          {route && (
            <div className="space-y-2">
              <div className="p-2 bg-gray-700/60 rounded text-xs space-y-1">
                <p className="text-green-300">
                  🟢 Старт: {route.start.lat.toFixed(6)}, {route.start.lng.toFixed(6)}
                </p>
                <p className="text-red-300">
                  🔴 Цель: {route.goal.lat.toFixed(6)}, {route.goal.lng.toFixed(6)}
                </p>
                <p className="text-yellow-300">
                  📏 Расстояние: <b>{formatDistance(route.distanceM)}</b>
                </p>
                <p className="text-cyan-300">
                  🧭 Азимут: <b>{route.azimuth.toFixed(1)}°</b> ({bearingToCompass(route.azimuth)})
                </p>
                <p className="text-gray-400">
                  🗺️ Карта загружена с автоскейлом; колесом мыши можно масштабировать до нужного масштаба.
                </p>
              </div>
              <button
                onClick={createObjects}
                className="w-full px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm font-medium"
              >
                ➕ Создать объекты на карте (старт, цель, РБФ×2)
              </button>
              {createdMsg && (
                <div className="p-2 bg-green-900/30 border border-green-500 rounded text-xs text-green-300">✓ {createdMsg}</div>
              )}
              <button
                onClick={() => window.open(`https://www.openstreetmap.org/directions?from=${route.start.lat},${route.start.lng}&to=${route.goal.lat},${route.goal.lng}`, '_blank')}
                className="w-full px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white rounded text-xs"
              >
                ↗ Проверить маршрут в OpenStreetMap
              </button>
            </div>
          )}

          {/* Список маршрутов: создание, выбор, удаление (до 10000) */}
          <div className="border-t border-gray-600 pt-2 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-300">
                Маршруты: {routesList.length} / 10000
              </span>
              <button
                onClick={handleNewRouteByClicks}
                disabled={routesList.length >= 10000}
                className="px-2 py-1 bg-cyan-700 hover:bg-cyan-600 disabled:bg-gray-600 text-white rounded text-xs"
              >
                + Новый маршрут
              </button>
            </div>

            {/* Параметры активного маршрута: линия и ограничение по дальности */}
            {activeRoute && (
              <div className="p-2 bg-gray-700/60 rounded space-y-2">
                <p className="text-[11px] font-medium text-cyan-300 truncate">Активный: {activeRoute.name}</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-gray-400 block mb-0.5">Линия маршрута</label>
                    <select
                      value={activeRoute.shape || 'straight'}
                      onChange={(e) => setRouteShape(activeRoute.id, e.target.value as 'straight' | 'curve')}
                      className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
                    >
                      <option value="straight">Прямая (ломаная)</option>
                      <option value="curve">Кривая (сглаженная)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400 block mb-0.5">Дальность</label>
                    <select
                      value={activeRoute.rangeMode || 'off'}
                      onChange={(e) => setRouteRangeLimit(activeRoute.id, e.target.value as 'off' | 'max' | 'min')}
                      className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
                    >
                      <option value="off">Без лимита</option>
                      <option value="max">Максимум (м)</option>
                      <option value="min">Минимум (м)</option>
                    </select>
                  </div>
                </div>
                {activeRoute.rangeMode && activeRoute.rangeMode !== 'off' && (
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-gray-400">Лимит, м:</label>
                    <input
                      type="number"
                      min={1}
                      step={50}
                      defaultValue={activeRoute.rangeM || 1000}
                      onBlur={(e) => setRouteRangeLimit(activeRoute.id, activeRoute.rangeMode!, parseInt(e.target.value) || undefined)}
                      className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Импорт списков координат: старты и цели -> маршруты с привязкой */}
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-300 font-medium">📋 Импорт координат (списки старт/цель)</summary>
              <div className="mt-2 space-y-2">
                <div>
                  <label className="text-[10px] text-gray-400 block mb-0.5">Стартовые позиции (каждая с новой строки)</label>
                  <textarea
                    value={startsText}
                    onChange={(e) => setStartsText(e.target.value)}
                    rows={3}
                    placeholder={'Альфа; 55.7558, 37.6176\nБета\t55.76 37.64\n55.77, 37.65'}
                    className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 block mb-0.5">Цели</label>
                  <textarea
                    value={goalsText}
                    onChange={(e) => setGoalsText(e.target.value)}
                    rows={3}
                    placeholder={'Гамма; 55.79, 37.67\n55.80, 37.68'}
                    className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white font-mono"
                  />
                </div>
                <p className="text-[10px] text-gray-400 leading-snug">
                  Формат строки: «метка; широта, долгота» или просто «широта долгота» (разделители ; таб : запятая).
                  i-й старт соединяется с i-й целью в отдельный маршрут (при разных длинах — последняя точка повторяется).
                  Максимум всего маршрутов в сессии — 10000.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleImportLists}
                    className="flex-1 px-2 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded text-xs font-medium"
                  >
                    Импортировать и построить маршруты
                  </button>
                  <button
                    onClick={() => { clearImportLists(); setCreatedMsg('Списки импорта очищены.'); }}
                    className="px-2 py-1.5 bg-gray-600 hover:bg-gray-500 text-white rounded text-xs"
                    title="Очистить сохранённые списки импорта"
                  >
                    Очистить
                  </button>
                </div>
                {project.importLists && (
                  <p className="text-[10px] text-gray-400">
                    Сохранено: стартов {project.importLists.starts.length}, целей {project.importLists.goals.length}
                  </p>
                )}
              </div>
            </details>

            <p className="text-[10px] leading-snug text-gray-400">
              Инструмент «Выбор»: клик по линии — сделать маршрут активным (●), тяните точки мышью
              («цепляйте»), двойной клик по точке — удалить. Включённый режим действий: клики по карте
              добавляют/вставляют точки активного маршрута; обход зон ограничений выполняется автоматически,
              пересечения подсвечиваются предупреждением ⚠.
            </p>
            {routesList.length > 0 && (
              <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
                {routesList.slice(0, 200).map((r) => {
                  const warn = useStore.getState().routeWarnings?.[r.id]?.length > 0;
                  return (
                    <div
                      key={r.id}
                      className={`flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer ${
                        r.id === activeRouteId ? 'bg-gray-600 ring-1 ring-cyan-400' : 'bg-gray-700/50 hover:bg-gray-700'
                      }`}
                      onClick={() => setActiveRoute(r.id)}
                      title={r.name}
                    >
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ background: r.color }} />
                      <span className="truncate flex-1 text-gray-200">
                        {r.id === activeRouteId ? '● ' : ''}{r.name}
                        <span className="text-gray-400"> ({r.points.length})</span>
                        {warn && <span className="ml-1 text-red-400">⚠</span>}
                      </span>
                      <button
                        className="text-gray-400 hover:text-red-400 shrink-0"
                        onClick={(e) => { e.stopPropagation(); deleteRoute(r.id); }}
                        title="Удалить маршрут"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                {routesList.length > 200 && (
                  <p className="text-[10px] text-gray-500">…показаны первые 200 из {routesList.length}</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default ActionModePanel;
