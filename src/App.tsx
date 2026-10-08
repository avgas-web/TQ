import React, { useEffect, useCallback, useState } from 'react';
import MapCanvas from './components/MapCanvas';
import Toolbar from './components/Toolbar';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import { useStore } from './store/useStore';
import { initOpenStreetMap } from './utils/openStreetMap';


/**
 * Тост-уведомление об ошибках хранилища (quota-exceeded и т.п.).
 * storage.ts диспатчит window-событие 'tq:storage-error' — молчаливая потеря
 * данных при переполнении localStorage теперь видна пользователю.
 */
const StorageToast: React.FC = () => {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const onError = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === 'string' && detail) {
        setMessage(detail);
        window.setTimeout(() => setMessage(null), 6000);
      }
    };
    window.addEventListener('tq:storage-error', onError);
    return () => window.removeEventListener('tq:storage-error', onError);
  }, []);
  if (!message) return null;
  return (
    <div
      role="alert"
      className="fixed top-12 left-1/2 -translate-x-1/2 z-[9999] max-w-md px-4 py-2 rounded-lg border border-red-500 bg-red-600/95 text-white text-xs shadow-lg pointer-events-none"
    >
      ⚠️ {message}
    </div>
  );
};

const App: React.FC = () => {
  const {
    currentTool,
    setTool,
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

    // Нормализуем клавишу: нижний регистр + транслит русской раскладки в физическую клавишу QWERTY
    const k = e.key.toLowerCase();
    const RU_TO_EN: Record<string, string> = {
      // Ctrl+И / Ctrl+Я = Undo (физическая клавиша Z), Ctrl+Н = Redo (клавиша Y)
      и: 'z', я: 'z', н: 'y',
      ф: 'a', ы: 's', у: 'd', к: 'f', е: 't', г: 'u', ш: 'i', щ: 'o', з: 'p',
      х: 'h', ж: 'j', э: 'k', м: 'l', б: 'b', ю: 'm',
    };
    const key = RU_TO_EN[k] ?? k;

    // Undo/redo для рисования полигонов (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, включая русскую раскладку)
    if ((e.ctrlKey || e.metaKey) && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redoDrawingPoint();
      else undoDrawingPoint();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === 'y') {
      e.preventDefault();
      redoDrawingPoint();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      clearDrawingPoints();
      setMeasurementPoints([]);
      setTool('pan');
      return;
    }

    if (e.key === 'Delete' && selectedMarkerId) {
      e.preventDefault();
      deleteMarker(selectedMarkerId);
      return;
    }

    if (e.key === '+' || e.key === '=' || e.key === '§') {
      e.preventDefault();
      const newScale = Math.min(50, viewState.scale * 1.2);
      setViewState({ scale: newScale });
      return;
    }

    if (e.key === '-' || e.key === '_' || e.key === '–') {
      e.preventDefault();
      const newScale = Math.max(0.01, viewState.scale / 1.2);
      setViewState({ scale: newScale });
      return;
    }

    // Tool shortcuts
    if (['1', '2', '3', '4', '5', '6', '7'].includes(e.key)) {
      e.preventDefault();
      const tools = ['pan', 'select', 'addMarker', 'drawRect', 'drawPolygon', 'drawCircle', 'measure'] as const;
      setTool(tools[Number(e.key) - 1]);
      return;
    }

    // Grid toggle: G (и русская П на той же клавише)
    if (key === 'g') {
      e.preventDefault();
      updateSettings({ showGrid: !project.settings?.showGrid });
      return;
    }

    // Тема: T / M (транслит покрывает русские Е/Ь на тех же клавишах)
    if (key === 't' || key === 'm') {
      e.preventDefault();
      updateSettings({ theme: project.settings?.theme === 'light' ? 'dark' : 'light' });
      return;
    }

    // Полный экран: F (транслит покрывает русскую А)
    if (key === 'f') {
      e.preventDefault();
      const el = document.getElementById('map-container');
      if (el && document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (el) el.requestFullscreen?.().catch(() => {});
      return;
    }

    // Режим действий: R (транслит покрывает русскую К)
    if (key === 'r') {
      e.preventDefault();
      setActionMode(!actionMode);
      return;
    }
  }, [currentTool, viewState, selectedMarkerId, setTool, setViewState,
    clearDrawingPoints, setMeasurementPoints, deleteMarker, project.settings?.showGrid,
    project.settings?.theme, updateSettings, actionMode, setActionMode,
    undoDrawingPoint, redoDrawingPoint]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Адаптив: на мобильных (<768px) — карта фикс. высотой 300–400 px + панель слоёв снизу;
  // на десктопе — 2 колонки (карта + сайдбар) либо полный экран по клавише F.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

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

  // Initialize OpenStreetMap on app load (doesn't require API key).
  // НЕ включаем OSM безусловно: toggleOpenStreetMap(true) на каждом старте
  // перезаписывал сохранённый выбор пользователя (persist openStreetMap.enabled).
  // Инициализация конфигурации выполняется, а состояние берётся из стора.
  useEffect(() => {
    const initOSM = async () => {
      await initOpenStreetMap();
      const st = useStore.getState();
      if (!st.project.openStreetMap.enabled) {
        st.toggleOpenStreetMap(true);
      }
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
          <select
            title="Шаг гео-сетки в метрах (0 = автоподбор под масштаб)"
            value={String(project.settings?.gridSize ?? 0)}
            onChange={(e) => updateSettings({ gridSize: Number(e.target.value) })}
            className="px-1 py-0.5 bg-gray-800 border border-gray-600 rounded text-xs text-white"
          >
            <option value="0">Сетка: авто</option>
            <option value="10">10 м</option>
            <option value="50">50 м</option>
            <option value="100">100 м</option>
            <option value="200">200 м</option>
            <option value="500">500 м</option>
            <option value="1000">1 км</option>
            <option value="5000">5 км</option>
          </select>
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

      {/* Main content: desktop — 2 колонки; mobile — вертикально, карта 300–400 px + панель */}
      <div className={"flex-1 flex overflow-hidden relative " + (isMobile ? "flex-col" : "flex-row")}>
        {/* Canvas */}
        <div className={isMobile ? "relative w-full shrink-0" : "flex-1 relative"} style={isMobile ? { height: 350 } : undefined}>
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
        <div className={isMobile ? "flex-1 min-h-0 overflow-y-auto" : ""}>
          <Sidebar />
        </div>
      </div>

      {/* Status bar */}
      <StatusBar />

      <StorageToast />
    </div>
  );
};

export default App;
