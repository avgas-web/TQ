import React, { useState, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { decimalToDMS } from '../utils/geometry';
import { pixelToGeoFromBounds } from '../utils/googleMaps';
import {
  exportToCSV, exportToJSON, exportToGeoJSON, exportToGPX, exportToKML,
  downloadFile, importFromCSV, importFromGeoJSON, exportProject, importProject,
} from '../utils/export';
import MapsPanel from './MapsPanel';
import ActionModePanel from './ActionModePanel';

const Sidebar: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'action' | 'points' | 'restrictions' | 'export' | 'google'>('action');
  const [editingMarker, setEditingMarker] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editX, setEditX] = useState('');
  const [editY, setEditY] = useState('');
  const [editComment, setEditComment] = useState('');
  const [editType, setEditType] = useState('');

  const {
    project,
    selectedMarkerId,
    searchQuery,
    filterType,
    activeRestrictionId,
    selectMarker,
    updateMarker,
    deleteMarker,
    deleteRestriction,
    setActiveRestriction,
    addMarker,
    setSearchQuery,
    setFilterType,
    importProject: doImportProject,
  } = useStore();

  // Filtered markers
  const filteredMarkers = useMemo(() => {
    return project.markers.filter(m => {
      if (searchQuery && !m.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !m.comment.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }
      if (filterType && m.type !== filterType) return false;
      return true;
    });
  }, [project.markers, searchQuery, filterType]);

  // Unique types for filter
  const markerTypes = useMemo(() => {
    const types = new Set(project.markers.map(m => m.type));
    return Array.from(types);
  }, [project.markers]);

  const handleExport = (format: string) => {
    const markers = project.markers;
    const projectName = project.projectName || 'project';

    switch (format) {
      case 'csv':
        downloadFile(exportToCSV(markers, project), `${projectName}_markers.csv`, 'text/csv');
        break;
      case 'json':
        downloadFile(exportToJSON(markers), `${projectName}_markers.json`, 'application/json');
        break;
      case 'geojson':
        downloadFile(exportToGeoJSON(markers, project), `${projectName}_markers.geojson`, 'application/geo+json');
        break;
      case 'gpx':
        downloadFile(exportToGPX(markers, project), `${projectName}_markers.gpx`, 'application/gpx+xml');
        break;
      case 'kml':
        downloadFile(exportToKML(markers, project), `${projectName}_markers.kml`, 'application/vnd.google-earth.kml+xml');
        break;
      case 'project':
        downloadFile(exportProject(project), `${projectName}.tqproj`, 'application/json');
        break;
    }
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;

      if (file.name.endsWith('.tqproj')) {
        const proj = importProject(content);
        if (proj) {
          doImportProject(proj);
          alert('Проект успешно импортирован!');
        } else {
          alert('Ошибка импорта проекта');
        }
      } else if (file.name.endsWith('.csv')) {
        const markers = importFromCSV(content);
        markers.forEach(m => addMarker(m));
        alert(`Импортировано ${markers.length} точек`);
      } else if (file.name.endsWith('.geojson') || file.name.endsWith('.json')) {
        try {
          const data = JSON.parse(content);
          if (data.type === 'FeatureCollection') {
            const markers = importFromGeoJSON(content);
            markers.forEach(m => addMarker(m));
            alert(`Импортировано ${markers.length} точек`);
          } else if (data.version) {
            doImportProject(data);
            alert('Проект успешно импортирован!');
          } else if (Array.isArray(data)) {
            data.forEach((m: any) => addMarker(m));
            alert(`Импортировано ${data.length} точек`);
          }
        } catch {
          alert('Ошибка парсинга файла');
        }
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const startEditing = (markerId: string) => {
    const marker = project.markers.find(m => m.id === markerId);
    if (!marker) return;
    setEditingMarker(markerId);
    setEditName(marker.name);
    setEditX(marker.x.toString());
    setEditY(marker.y.toString());
    setEditComment(marker.comment);
    setEditType(marker.type);
  };

  const saveEditing = () => {
    if (!editingMarker) return;
    updateMarker(editingMarker, {
      name: editName,
      x: parseFloat(editX) || 0,
      y: parseFloat(editY) || 0,
      comment: editComment,
      type: editType,
    });
    setEditingMarker(null);
  };

  const selectedMarker = project.markers.find(m => m.id === selectedMarkerId);

  return (
    <div className="w-80 bg-gray-800 border-l border-gray-700 flex flex-col h-full overflow-hidden">
      {/* Tabs */}
      <div className="flex border-b border-gray-700 flex-wrap">
        <button
          onClick={() => setActiveTab('action')}
          className={`flex-1 px-2 py-2 text-xs font-medium ${activeTab === 'action' ? 'bg-gray-700 text-orange-400' : 'text-gray-400 hover:text-gray-200'}`}
        >
          🎯 Действия
        </button>
        <button
          onClick={() => setActiveTab('points')}
          className={`flex-1 px-2 py-2 text-xs font-medium ${activeTab === 'points' ? 'bg-gray-700 text-cyan-400' : 'text-gray-400 hover:text-gray-200'}`}
        >
          📍 Точки ({project.markers.length})
        </button>
        <button
          onClick={() => setActiveTab('restrictions')}
          className={`flex-1 px-2 py-2 text-xs font-medium ${activeTab === 'restrictions' ? 'bg-gray-700 text-cyan-400' : 'text-gray-400 hover:text-gray-200'}`}
        >
          🚧 Зоны ({project.restrictions.length})
        </button>
        <button
          onClick={() => setActiveTab('google')}
          className={`flex-1 px-2 py-2 text-xs font-medium ${activeTab === 'google' ? 'bg-gray-700 text-cyan-400' : 'text-gray-400 hover:text-gray-200'}`}
        >
          🗺️ Карты
        </button>
        <button
          onClick={() => setActiveTab('export')}
          className={`flex-1 px-2 py-2 text-xs font-medium ${activeTab === 'export' ? 'bg-gray-700 text-cyan-400' : 'text-gray-400 hover:text-gray-200'}`}
        >
          💾 Экспорт
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'action' && (
          <ActionModePanel />
        )}
        {activeTab === 'points' && (
          <div className="p-2">
            {/* Search & Filter */}
            <div className="flex gap-1 mb-2">
              <input
                type="text"
                placeholder="Поиск..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white placeholder-gray-400"
              />
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
              >
                <option value="">Все типы</option>
                {markerTypes.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            {/* Markers list */}
            <div className="space-y-1">
              {filteredMarkers.map(marker => (
                <div
                  key={marker.id}
                  onClick={() => selectMarker(marker.id)}
                  className={`p-2 rounded cursor-pointer text-sm ${
                    marker.id === selectedMarkerId
                      ? 'bg-cyan-900 border border-cyan-500'
                      : 'bg-gray-700 hover:bg-gray-600 border border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-white">
                      <span
                        className="inline-block w-3 h-3 rounded-full mr-1"
                        style={{ backgroundColor: marker.color }}
                      />
                      {marker.name}
                    </span>
                    <div className="flex gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); startEditing(marker.id); }}
                        className="px-1 text-xs text-gray-400 hover:text-white"
                      >✏️</button>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteMarker(marker.id); }}
                        className="px-1 text-xs text-gray-400 hover:text-red-400"
                      >🗑️</button>
                    </div>
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    X: {Math.round(marker.x)}, Y: {Math.round(marker.y)}
                    {(() => {
                      // Если есть привязка к онлайн-картам, вычисляем координаты автоматически
                      if (project.map?.bounds && (project.map?.source === 'google' || project.map?.source === 'yandex' || project.map?.source === 'osm')) {
                        const geo = pixelToGeoFromBounds(
                          { x: marker.x, y: marker.y },
                          project.map.bounds,
                          project.map.width || 0,
                          project.map.height || 0
                        );
                        return (
                          <span className="ml-2 text-green-400">
                            | {geo.lat.toFixed(5)}, {geo.lng.toFixed(5)}
                          </span>
                        );
                      }
                      // Иначе показываем сохранённые координаты
                      if (marker.lat !== null && marker.lon !== null) {
                        return (
                          <span className="ml-2">
                            | {marker.lat.toFixed(5)}, {marker.lon.toFixed(5)}
                          </span>
                        );
                      }
                      return null;
                    })()}
                    {marker.type !== 'default' && (
                      <span className="ml-2 text-cyan-400">[{marker.type}]</span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {filteredMarkers.length === 0 && (
              <p className="text-gray-500 text-sm text-center mt-4">
                {project.markers.length === 0 ? 'Нет точек. Используйте инструмент «Точка».' : 'Нет совпадений.'}
              </p>
            )}
          </div>
        )}

        {activeTab === 'restrictions' && (
          <div className="p-2">
            <div className="space-y-1">
              {project.restrictions.map(restriction => (
                <div
                  key={restriction.id}
                  className={`p-2 rounded text-sm ${
                    restriction.id === activeRestrictionId
                      ? 'bg-red-900/30 border border-red-500'
                      : 'bg-gray-700 border border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-white">
                      {restriction.type === 'polygon' ? '⬡' : restriction.type === 'rectangle' ? '▭' : '⭕'}
                      {' '}{restriction.name}
                    </span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setActiveRestriction(
                          restriction.id === activeRestrictionId ? null : restriction.id
                        )}
                        className={`px-1 text-xs ${restriction.active ? 'text-red-400' : 'text-gray-400 hover:text-white'}`}
                        title="Активировать"
                      >
                        {restriction.active ? '🔴' : '⚪'}
                      </button>
                      <button
                        onClick={() => deleteRestriction(restriction.id)}
                        className="px-1 text-xs text-gray-400 hover:text-red-400"
                      >🗑️</button>
                    </div>
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    {restriction.type === 'circle'
                      ? `Центр: (${Math.round(restriction.points[0]?.x || 0)}, ${Math.round(restriction.points[0]?.y || 0)}), R: ${Math.round(restriction.radius || 0)}px`
                      : `${restriction.points.length} вершин`
                    }
                  </div>
                </div>
              ))}
            </div>
            {project.restrictions.length === 0 && (
              <p className="text-gray-500 text-sm text-center mt-4">
                Нет ограничений. Используйте инструменты рисования.
              </p>
            )}
          </div>
        )}

        {activeTab === 'google' && (
          <MapsPanel />
        )}

        {activeTab === 'export' && (
          <div className="p-3 space-y-3">
            <h3 className="text-sm font-medium text-gray-300">Экспорт точек</h3>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => handleExport('csv')} className="px-3 py-2 bg-green-700 hover:bg-green-600 text-white rounded text-xs">CSV</button>
              <button onClick={() => handleExport('json')} className="px-3 py-2 bg-green-700 hover:bg-green-600 text-white rounded text-xs">JSON</button>
              <button onClick={() => handleExport('geojson')} className="px-3 py-2 bg-green-700 hover:bg-green-600 text-white rounded text-xs">GeoJSON</button>
              <button onClick={() => handleExport('gpx')} className="px-3 py-2 bg-green-700 hover:bg-green-600 text-white rounded text-xs">GPX</button>
              <button onClick={() => handleExport('kml')} className="px-3 py-2 bg-green-700 hover:bg-green-600 text-white rounded text-xs">KML</button>
            </div>

            <h3 className="text-sm font-medium text-gray-300 mt-4">Проект</h3>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => handleExport('project')} className="px-3 py-2 bg-purple-700 hover:bg-purple-600 text-white rounded text-xs">Сохранить .tqproj</button>
              <label className="px-3 py-2 bg-purple-700 hover:bg-purple-600 text-white rounded text-xs text-center cursor-pointer">
                Загрузить .tqproj
                <input type="file" accept=".tqproj,.json,.geojson,.csv" className="hidden" onChange={handleImport} />
              </label>
            </div>

            <h3 className="text-sm font-medium text-gray-300 mt-4">Импорт точек</h3>
            <label className="block px-3 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded text-xs text-center cursor-pointer">
              Импорт CSV / GeoJSON / JSON
              <input type="file" accept=".csv,.geojson,.json" className="hidden" onChange={handleImport} />
            </label>

            <div className="mt-4 p-2 bg-gray-700 rounded text-xs text-gray-400">
              <p>💡 Форматы экспорта:</p>
              <ul className="mt-1 space-y-0.5">
                <li>• CSV — таблица с ; разделителем</li>
                <li>• JSON — массив точек</li>
                <li>• GeoJSON — FeatureCollection</li>
                <li>• GPX — GPS waypoints</li>
                <li>• KML — Google Earth</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* Selected marker properties */}
      {selectedMarker && (
        <div className="border-t border-gray-700 p-3 bg-gray-750">
          <h3 className="text-sm font-medium text-cyan-400 mb-2">Свойства точки</h3>
          <div className="space-y-1 text-xs text-gray-300">
            <p><span className="text-gray-500">ID:</span> {selectedMarker.id.slice(0, 8)}...</p>
            <p><span className="text-gray-500">Имя:</span> {selectedMarker.name}</p>
            <p><span className="text-gray-500">Пиксели:</span> X={Math.round(selectedMarker.x)}, Y={Math.round(selectedMarker.y)}</p>
            {(() => {
              // Если есть привязка к онлайн-картам, вычисляем координаты автоматически
              if (project.map?.bounds && (project.map?.source === 'google' || project.map?.source === 'yandex' || project.map?.source === 'osm')) {
                const geo = pixelToGeoFromBounds(
                  { x: selectedMarker.x, y: selectedMarker.y },
                  project.map.bounds,
                  project.map.width || 0,
                  project.map.height || 0
                );
                return (
                  <>
                    <p><span className="text-gray-500">Координаты:</span> <span className="text-green-400">{geo.lat.toFixed(6)}, {geo.lng.toFixed(6)}</span></p>
                    <p><span className="text-gray-500">DMS:</span> {decimalToDMS(geo.lat, true)} {decimalToDMS(geo.lng, false)}</p>
                  </>
                );
              }
              // Иначе показываем сохранённые координаты
              if (selectedMarker.lat !== null && selectedMarker.lon !== null) {
                return (
                  <>
                    <p><span className="text-gray-500">Координаты:</span> {selectedMarker.lat.toFixed(6)}, {selectedMarker.lon.toFixed(6)}</p>
                    <p><span className="text-gray-500">DMS:</span> {decimalToDMS(selectedMarker.lat, true)} {decimalToDMS(selectedMarker.lon, false)}</p>
                  </>
                );
              }
              return null;
            })()}
            <p><span className="text-gray-500">Тип:</span> {selectedMarker.type}</p>
            <p><span className="text-gray-500">Слой:</span> {project.layers.find(l => l.id === selectedMarker.layer)?.name || '—'}</p>
            {selectedMarker.comment && <p><span className="text-gray-500">Комментарий:</span> {selectedMarker.comment}</p>}
            <p><span className="text-gray-500">Создана:</span> {new Date(selectedMarker.createdAt).toLocaleString('ru')}</p>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editingMarker && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-4 w-72">
            <h3 className="text-sm font-medium text-white mb-3">Редактировать точку</h3>
            <div className="space-y-2">
              <div>
                <label className="text-xs text-gray-400">Название</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-xs text-gray-400">X</label>
                  <input
                    type="number"
                    value={editX}
                    onChange={(e) => setEditX(e.target.value)}
                    className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-xs text-gray-400">Y</label>
                  <input
                    type="number"
                    value={editY}
                    onChange={(e) => setEditY(e.target.value)}
                    className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-400">Тип</label>
                <input
                  type="text"
                  value={editType}
                  onChange={(e) => setEditType(e.target.value)}
                  className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400">Комментарий</label>
                <textarea
                  value={editComment}
                  onChange={(e) => setEditComment(e.target.value)}
                  className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
                  rows={2}
                />
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={saveEditing} className="flex-1 px-3 py-1 bg-cyan-600 hover:bg-cyan-700 text-white rounded text-sm">Сохранить</button>
              <button onClick={() => setEditingMarker(null)} className="flex-1 px-3 py-1 bg-gray-600 hover:bg-gray-500 text-white rounded text-sm">Отмена</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Sidebar;
