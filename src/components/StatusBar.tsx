import React from 'react';
import { useStore, selectViewForRender } from '../store/useStore';
import { pixelToGeoFromBounds } from '../utils/googleMaps';
import { haversineDistanceM } from '../utils/actionMode';


const StatusBar: React.FC = () => {
  const cursorPosition = useStore((s) => s.cursorPosition);
  // Вид — через стабильный селектор примитивов (см. selectViewForRender):
  // компонент не зависит от момента гидрации persist и никогда не увидит
  // undefined-viewState (краш «viewState is not defined» на проде).
  const view = useStore(selectViewForRender);
  const project = useStore((s) => s.project);
  const measurementPoints = useStore((s) => s.measurementPoints);

  const totalMeasurement = measurementPoints.length >= 2
    ? measurementPoints.reduce((sum, p, i) => {
      if (i === 0) return 0;
      const prev = measurementPoints[i - 1];
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      return sum + Math.sqrt(dx * dx + dy * dy);
    }, 0)
    : 0;

  return (
    <div className="flex items-center justify-between px-3 py-1 bg-gray-800 border-t border-gray-700 text-xs text-gray-400">
      <div className="flex items-center gap-4">
        {/* Cursor position */}
        {cursorPosition && (
          <span>
            📍 X: {Math.round(cursorPosition.x)}, Y: {Math.round(cursorPosition.y)}
            {(() => {
              // Если есть привязка к онлайн-картам, показываем географические координаты
              if (project.map?.bounds && (project.map?.source === 'google' || project.map?.source === 'yandex' || project.map?.source === 'osm')) {
                const geo = pixelToGeoFromBounds(
                  cursorPosition,
                  project.map.bounds,
                  project.map.width || 0,
                  project.map.height || 0
                );
                return (
                  <span className="ml-2 text-green-400">
                    | 🌍 {geo.lat.toFixed(6)}, {geo.lng.toFixed(6)}
                  </span>
                );
              }
              // Иначе показываем калибровочные координаты
              if (project.calibration?.enabled && project.calibration?.points?.length >= 2) {
                return (
                  <span className="ml-2 text-cyan-400">
                    | Geo: {cursorPosition.x.toFixed(4)}, {cursorPosition.y.toFixed(4)}
                  </span>
                );
              }
              return null;
            })()}
          </span>
        )}

        {/* Measurement */}
        {measurementPoints.length >= 2 && (
          <span className="text-yellow-400">
            📏 {Math.round(totalMeasurement)} px ({measurementPoints.length} точек)
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
        {/* Масштабная линейка для гео-привязанных карт */}
        {project.map?.bounds && (() => {
          const gCenter = pixelToGeoFromBounds(
            { x: project.map!.width / 2, y: project.map!.height / 2 },
            project.map.bounds, project.map.width, project.map.height
          );
          // Метров на 1 экранный пиксель — из точных границ карты (WGS-84)
          const gRight = pixelToGeoFromBounds(
            { x: project.map!.width / 2 + 1 / (view.scale || 1), y: project.map!.height / 2 },
            project.map.bounds, project.map.width, project.map.height
          );
          const metersPerScreenPx = haversineDistanceM(gCenter, gRight);
          if (!isFinite(metersPerScreenPx) || metersPerScreenPx <= 0) return null;
          const niceSteps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
          const targetPx = 120;
          let best = niceSteps[0];
          for (const st of niceSteps) {
            if (st / metersPerScreenPx <= targetPx) best = st;
          }
          const barW = Math.round(best / metersPerScreenPx);
          return (
            <span className="flex items-center gap-1" title="Масштабная линейка">
              <span className="inline-block border-b-2 border-l-2 border-r-2 border-gray-300" style={{ width: `${barW}px`, height: '4px' }} />
              <span className="text-gray-300">{best >= 1000 ? `${best / 1000} км` : `${best} м`}</span>
            </span>
          );
        })()}

        {/* Zoom */}
        <span>🔍 {((view.scale ?? 1) * 100).toFixed(0)}%</span>

        {/* Markers count */}
        <span>📍 {project.markers.length} точек</span>

        {/* Restrictions count */}
        <span>🚧 {project.restrictions.length} зон</span>

        {/* Map size */}
        {project.map && (
          <span>🗺️ {project.map.width || 0}×{project.map.height || 0}</span>
        )}
      </div>
    </div>
  );
};

export default StatusBar;
