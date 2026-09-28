import React from 'react';
import { useStore } from '../store/useStore';


const StatusBar: React.FC = () => {
  const {
    cursorPosition,
    viewState,
    project,
    measurementPoints,
  } = useStore();

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
            {project.calibration.enabled && project.calibration.points.length >= 2 && (
              <span className="ml-2 text-cyan-400">
                | Geo: {cursorPosition.x.toFixed(4)}, {cursorPosition.y.toFixed(4)}
              </span>
            )}
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
        {/* Zoom */}
        <span>🔍 {(viewState.scale * 100).toFixed(0)}%</span>

        {/* Markers count */}
        <span>📍 {project.markers.length} точек</span>

        {/* Restrictions count */}
        <span>🚧 {project.restrictions.length} зон</span>

        {/* Map size */}
        {project.map && (
          <span>🗺️ {project.map.width}×{project.map.height}</span>
        )}
      </div>
    </div>
  );
};

export default StatusBar;
