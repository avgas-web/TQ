// ─── ПАНЕЛЬ УПРАВЛЕНИЯ ПОЛЬЗОВАТЕЛЬСКИМИ ТАКТИЧЕСКИМИ КАРТАМИ (Задача 2, п.5) ──
// Импорт файлов GeoTIFF / KML / KMZ / GeoJSON / MBTiles / PNG / JPEG с жёстким
// сохранением координатной привязки; управление видимостью и прозрачностью
// слоёв поверх базовой карты. Метаданные — Zustand (persist), payload-ы — IndexedDB.
import React, { useRef, useState } from 'react';
import { useStore } from '../store/useStore';

const ACCEPT_FORMATS = '.tif,.tiff,.kml,.kmz,.geojson,.json,.mbtiles,.png,.jpg,.jpeg';

const FORMAT_LABELS: Record<string, string> = {
  geotiff: 'GeoTIFF', kml: 'KML', kmz: 'KMZ', geojson: 'GeoJSON',
  mbtiles: 'MBTiles', image: 'Растр',
};

const TacticalLayersPanel: React.FC = () => {
  const project = useStore((s) => s.project);
  const importTacticalOverlay = useStore((s) => s.importTacticalOverlay);
  const updateTacticalOverlay = useStore((s) => s.updateTacticalOverlay);
  const removeTacticalOverlay = useStore((s) => s.removeTacticalOverlay);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const layers = project.tacticalOverlays || [];

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError('');
    for (const f of Array.from(files)) {
      try {
        await importTacticalOverlay(f);
      } catch (e: any) {
        // ЖЁСТКОЕ требование: слой без корректного bounding box не импортируется
        setError(`«${f.name}»: ${e?.message || 'ошибка импорта'}`);
      }
    }
    setBusy(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="p-3 space-y-2 text-sm">
      <div className="font-bold text-cyan-300 uppercase tracking-wide text-xs">
        Тактические карты (пользовательские слои)
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPT_FORMATS}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={busy}
        className="w-full py-1.5 px-2 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white"
      >
        {busy ? 'Импорт…' : '⬆ Импортировать карту (GeoTIFF/KML/KMZ/GeoJSON/MBTiles/PNG/JPEG)'}
      </button>
      {error && <div className="text-red-400 text-xs whitespace-pre-wrap">{error}</div>}

      {layers.length === 0 && (
        <div className="text-slate-400 text-xs">
          Слои не загружены. Растровые форматы требуют геопривязку (GDAL-теги /
          EXIF-GPS / world-file); импорт без bounding box отклоняется.
        </div>
      )}

      <div className="space-y-2">
        {layers.map((l) => (
          <div key={l.id} className="rounded border border-slate-700 bg-slate-800/60 p-2 space-y-1">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={l.visible}
                onChange={(e) => updateTacticalOverlay(l.id, { visible: e.target.checked })}
                title="Видимость слоя"
              />
              <span className="truncate flex-1" title={l.name}>{l.name}</span>
              <span className="text-[10px] text-slate-400">{FORMAT_LABELS[l.format] || l.format}</span>
              <button
                onClick={() => removeTacticalOverlay(l.id)}
                className="text-red-400 hover:text-red-300 px-1"
                title="Удалить слой из сектора"
              >✕</button>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <span className="w-16 text-slate-400">Прозрачность</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(l.opacity * 100)}
                onChange={(e) => updateTacticalOverlay(l.id, { opacity: Number(e.target.value) / 100 })}
                className="flex-1 accent-cyan-500"
              />
              <span className="w-9 text-right">{Math.round(l.opacity * 100)}%</span>
            </div>
            <div className="text-[10px] text-slate-500">
              EPSG:{l.georef.projection.split(':')[1]} · bbox [{l.georef.boundsWgs84.west.toFixed(4)},{' '}
              {l.georef.boundsWgs84.south.toFixed(4)}, {l.georef.boundsWgs84.east.toFixed(4)},{' '}
              {l.georef.boundsWgs84.north.toFixed(4)}]
              {l.zoomRange ? ` · z${l.zoomRange.min}–${l.zoomRange.max}` : ''} · {(l.sizeBytes / 1024).toFixed(0)} КБ
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TacticalLayersPanel;
