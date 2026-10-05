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

  const { project, loadMapWithStorage, addMarker, selectMarker, actionMode, setActionMode } = useStore();

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
        </>
      )}
    </div>
  );
};

export default ActionModePanel;
