import React, { useRef } from 'react';
import { useStore } from '../store/useStore';
import type { Tool, MapData } from '../types';

const Toolbar: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    currentTool,
    project,
    setTool,
    loadMap,
    resetProject,
    clearDrawingPoints,
    setMeasurementPoints,
  } = useStore();

  const handleLoadMap = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'];
    if (!validTypes.includes(file.type)) {
      alert('Поддерживаются только форматы: PNG, JPG, JPEG, WebP, BMP');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      const img = new Image();
      img.onload = () => {
        const mapData: MapData = {
          name: file.name,
          width: img.width,
          height: img.height,
          dataUrl,
        };
        loadMap(mapData);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const tools: { id: Tool; label: string; icon: string; title: string }[] = [
    { id: 'pan', label: 'Пан', icon: '✋', title: 'Панорамирование (пробел+ЛКМ)' },
    { id: 'select', label: 'Выбор', icon: '👆', title: 'Выбор и перемещение точек' },
    { id: 'addMarker', label: 'Точка', icon: '📍', title: 'Добавить точку' },
    { id: 'drawRect', label: 'Прям.', icon: '▭', title: 'Нарисовать прямоугольник' },
    { id: 'drawPolygon', label: 'Полиг.', icon: '⬡', title: 'Нарисовать полигон (двойной клик — завершить)' },
    { id: 'drawCircle', label: 'Круг', icon: '⭕', title: 'Нарисовать круг' },
    { id: 'measure', label: 'Линейка', icon: '📏', title: 'Измерение расстояний' },
  ];

  return (
    <div className="flex items-center gap-1 p-2 bg-gray-800 border-b border-gray-700 flex-wrap">
      {/* File operations */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/bmp"
        className="hidden"
        onChange={handleFileChange}
      />
      <button
        onClick={handleLoadMap}
        className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-colors"
        title="Загрузить карту"
      >
        🗺️ Карта
      </button>

      <div className="w-px h-8 bg-gray-600 mx-1" />

      {/* Tools */}
      {tools.map(tool => (
        <button
          key={tool.id}
          onClick={() => {
            setTool(tool.id);
            clearDrawingPoints();
            setMeasurementPoints([]);
          }}
          className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
            currentTool === tool.id
              ? 'bg-cyan-600 text-white'
              : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
          }`}
          title={tool.title}
        >
          <span className="mr-1">{tool.icon}</span>
          <span className="hidden sm:inline">{tool.label}</span>
        </button>
      ))}

      <div className="w-px h-8 bg-gray-600 mx-1" />

      {/* Map info */}
      {project.map && (
        <span className="text-xs text-gray-400 px-2">
          {project.map.name || 'Карта'} ({project.map.width || 0}×{project.map.height || 0})
        </span>
      )}

      <div className="flex-1" />

      {/* Map source indicator */}
      {project.map?.source === 'google' && (
        <span className="text-xs text-green-400 px-2">
          🌍 Google Maps
        </span>
      )}

      {/* Reset */}
      <button
        onClick={() => {
          if (confirm('Сбросить проект? Все данные будут потеряны.')) {
            resetProject();
          }
        }}
        className="px-3 py-2 bg-red-700 hover:bg-red-800 text-white rounded text-sm font-medium transition-colors"
        title="Новый проект"
      >
        🔄 Сброс
      </button>
    </div>
  );
};

export default Toolbar;
