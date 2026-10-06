import React, { useEffect, useCallback } from 'react';
import MapCanvas from './components/MapCanvas';
import Toolbar from './components/Toolbar';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import { useStore } from './store/useStore';
import { initOpenStreetMap } from './utils/openStreetMap';

const App: React.FC = () => {
  const {
    currentTool,
    setTool,
    viewState,
    setViewState,
    clearDrawingPoints,
    setMeasurementPoints,
    project,
    updateSettings,
    setProjectName,
    deleteMarker,
    selectedMarkerId,
    actionMode,
    setActionMode,
    undoDrawingPoint,
    redoDrawingPoint,
  } = useStore();

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Ignore if typing in input
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    // Undo/redo для рисования полигонов (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redoDrawingPoint();
      else undoDrawingPoint();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      redoDrawingPoint();
      return;
    }

    if (e.key === 'Escape') {
      clearDrawingPoints();
      setMeasurementPoints([]);
      setTool('pan');
    }

    if (e.key === 'Delete' && selectedMarkerId) {
      deleteMarker(selectedMarkerId);
    }

    if (e.key === '+' || e.key === '=') {
      const newScale = Math.min(50, viewState.scale * 1.2);
      setViewState({ scale: newScale });
    }

    if (e.key === '-') {
      const newScale = Math.max(0.01, viewState.scale / 1.2);
      setViewState({ scale: newScale });
    }

    // Tool shortcuts
    if (e.key === '1') setTool('pan');
    if (e.key === '2') setTool('select');
    if (e.key === '3') setTool('addMarker');
    if (e.key === '4') setTool('drawRect');
    if (e.key === '5') setTool('drawPolygon');
    if (e.key === '6') setTool('drawCircle');
    if (e.key === '7') setTool('measure');

    // Grid toggle
    if (e.key === 'g' || e.key === 'G' || e.key === 'п' || e.key === 'П') {
      updateSettings({ showGrid: !project.settings?.showGrid });
    }

    // Тема: T / M (и русские е/ь)
    if (e.key === 't' || e.key === 'T' || e.key === 'm' || e.key === 'M' || e.key === 'е' || e.key === 'м') {
      updateSettings({ theme: project.settings?.theme === 'light' ? 'dark' : 'light' });
    }

    // Режим действий: R (и русские к/я)
    if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
      setActionMode(!actionMode);
    }
  }, [currentTool, viewState, selectedMarkerId, setTool, setViewState,
    clearDrawingPoints, setMeasurementPoints, deleteMarker, project.settings?.showGrid,
    project.settings?.theme, updateSettings, actionMode, setActionMode,
    undoDrawingPoint, redoDrawingPoint]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Apply theme (dark по умолчанию, light — переключается кнопкой или клавишей T)
  const theme = project.settings?.theme || 'dark';
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.setAttribute('data-theme', theme);
  }, [theme]);

  // Restore map from IndexedDB on app load
  useEffect(() => {
    const restoreMap = async () => {
      await useStore.getState().restoreMapFromStorage();
    };
    restoreMap();
  }, []);

  // Initialize OpenStreetMap on app load (doesn't require API key)
  useEffect(() => {
    const initOSM = async () => {
      await initOpenStreetMap();
      useStore.getState().toggleOpenStreetMap(true);
    };
    initOSM();
  }, []);

  return (
    <div className={theme === "dark" ? "h-screen w-screen flex flex-col bg-gray-900 text-white overflow-hidden" : "h-screen w-screen flex flex-col bg-gray-100 text-gray-900 overflow-hidden"}>
      {/* Header */}
      <div className={theme === "dark" ? "flex items-center px-3 py-1 bg-gray-900 border-b border-gray-700" : "flex items-center px-3 py-1 bg-white border-b border-gray-300"}>
        <h1 className="text-sm font-bold text-cyan-400">
          🎯 TotalQuadro Coordinate Marker
        </h1>
        <span className="ml-2 text-xs text-gray-500">v1.0</span>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={project.projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="px-2 py-0.5 bg-gray-800 border border-gray-600 rounded text-xs text-white w-40"
            placeholder="Название проекта"
          />
          <label className="flex items-center gap-1 text-xs text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={project.settings?.showGrid || false}
              onChange={(e) => updateSettings({ showGrid: e.target.checked })}
              className="rounded"
            />
            Сетка
          </label>
          <button
            onClick={() => updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' })}
            className="px-2 py-0.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded text-xs text-white"
            title="Переключить тему (клавиша T)"
          >
            {theme === 'dark' ? '🌙 Тёмная' : '☀️ Светлая'}
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <Toolbar />

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Canvas */}
        <div className="flex-1 relative">
          <MapCanvas />

          {/* Help overlay */}
          {!project.map && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="bg-gray-800/90 border border-gray-600 rounded-lg p-6 max-w-md text-center">
                <h2 className="text-xl font-bold text-cyan-400 mb-3">Добро пожаловать!</h2>
                <p className="text-gray-300 text-sm mb-4">
                  Загрузите карту местности, затем добавляйте точки и ограничения.
                </p>
                <div className="text-left text-xs text-gray-400 space-y-1">
                  <p>🗺️ <strong>Карта</strong> — загрузить изображение</p>
                  <p>📍 <strong>Точка</strong> — кликнуть по карте для добавления</p>
                  <p>▭ <strong>Прям.</strong> — нарисовать прямоугольное ограничение</p>
                  <p>⬡ <strong>Полиг.</strong> — нарисовать полигональное ограничение</p>
                  <p>⭕ <strong>Круг</strong> — нарисовать круглое ограничение</p>
                  <p>📏 <strong>Линейка</strong> — измерить расстояние</p>
                  <p className="mt-2 text-gray-500">Горячие клавиши: 1–7 — инструменты · R — режим действий · T — тема · Ctrl+Z/Ctrl+Y — undo/redo рисования · +/- — зум · G — сетка · Del — удалить · Esc — отмена</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <Sidebar />
      </div>

      {/* Status bar */}
      <StatusBar />
    </div>
  );
};

export default App;
