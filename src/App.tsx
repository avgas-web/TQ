import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import MapCanvas from './components/MapCanvas';
import MapsPanel from './components/MapsPanel';
import Toolbar from './components/Toolbar';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import { MissionWizard } from './components/wizard/MissionWizard';
import { useStore } from './store/useStore';
import { initOpenStreetMap } from './utils/openStreetMap';
import { eventBus } from './utils/eventBus';
import { useAppInitialization } from './hooks/useAppInitialization';
import OfflineIndicator from './components/OfflineIndicator';

/** Компактная полоса загрузки карт для Мастера миссий.
 *  ФИКС #1 «полоса скрыта за строкой „Далее“»: раньше это был выпадающий
 *  dropdown (absolute/fixed от кнопки в шапке). Он перекрывался контентом
 *  этапов мастера (у каждого этапа свой stacking-контекст), а при раскрытии
 *  вниз уезжал за нижний край и накрывался футером «Назад/Далее».
 *  Теперь полоса рендерится ЧЕРЕЗ PORTAL в document.body с собственным
 *  stacking-контекстом и z-index выше всего интерфейса — её физически нечем
 *  перекрыть, включая футер с кнопкой «Далее».
 *  ФИКС #2 «копируем способ загрузки из режима планирования»: содержимое
 *  полосы — ТОТ ЖЕ самый компонент MapsPanel, что используется в редакторе
 *  (режиме планирования): те же обработчики handleLoadMap/loadActiveTileMap,
 *  та же активная тайловая карта OSM/2ГИС с фиксацией над объектом загрузки.
 *  Дублирующей логики загрузки в мастере больше нет — один код-путь на оба
 *  режима, поэтому карта загружается и видна одинаково везде. */
const WizardMapsStrip: React.FC = () => {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('tq-wizard-maps-open') === '1'; } catch { return false; }
  });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number }>({ top: 0, left: 0, maxHeight: 0 });

  const measure = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    const WIDTH = 336; // w-84 ≈ 336px
    const availableBelow = window.innerHeight - r.bottom - margin;
    const availableAbove = r.top - margin;
    // Открываемся в большую из свободных областей: если внизу места меньше
    // панели — полоса уходит ВВЕРХ и никогда не прячется под футером «Далее».
    const openUp = availableBelow < Math.min(availableAbove, 420);
    const maxHeight = Math.max(240, openUp ? availableAbove : availableBelow);
    const left = Math.min(Math.max(margin, r.left), Math.max(margin, window.innerWidth - WIDTH - margin));
    setPos(
      openUp
        ? { top: Math.max(margin, r.top - maxHeight - 4), left, maxHeight }
        : { top: r.bottom + 4, left, maxHeight },
    );
  }, []);

  // Позиционируем портал по факту раскрытия + при ресайзе/скролле окна.
  useEffect(() => {
    if (!open) return;
    measure();
    const onReflow = (): void => measure();
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, measure]);

  // Закрытие по клику вне полосы и по Escape. Работает именно потому, что
  // портал живёт в document.body — клик по любому элементу мастера попадает
  // в document-слушатель (в старом dropdown внутри header такие клики
  // терялись в других stacking-контекстах).
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
      try { localStorage.setItem('tq-wizard-maps-open', '0'); } catch { /* ignore */ }
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div data-testid="wizard-maps-strip">
      <button
        ref={btnRef}
        type="button"
        data-testid="wizard-maps-toggle"
        className="px-2 py-0.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded text-xs text-white"
        onClick={() => {
          setOpen((o) => {
            try { localStorage.setItem('tq-wizard-maps-open', o ? '0' : '1'); } catch { /* ignore */ }
            return !o;
          });
        }}
        title="Загрузка карт: тот же путь, что в режиме планирования (бесплатные подложки Esri/OSM France/OpenTopoMap — выбор на Этапе 1 мастера)"
      >
        🗺️ Карты {open ? '▾' : '▸'}
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          data-testid="wizard-maps-dropdown"
          className="fixed z-[2147483647] overflow-y-auto overscroll-contain rounded-lg border border-cyan-700/60 bg-gray-900 p-2 shadow-2xl text-white"
          style={{ top: pos.top, left: pos.left, width: Math.min(336, window.innerWidth - 16), maxHeight: pos.maxHeight }}
        >
          {/* КОПИЯ способа загрузки: точь-в-точь панель режима планирования
              (MapsPanel) — единый обработчик handleLoadMap → loadActiveTileMap
              с фиксацией над СПб и непрерывным зумом/панорамой. */}
          <MapsPanel />
        </div>,
        document.body,
      )}
    </div>
  );
};


/**
 * Тост-уведомление об ошибках хранилища (quota-exceeded и т.п.).
 * storage.ts эмитит 'storage:error' через типобезопасный eventBus — молчаливая
 * потеря данных при переполнении localStorage теперь видна пользователю.
 */
const StorageToast: React.FC = () => {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const off = eventBus.on('storage:error', ({ message: msg }) => {
      if (msg) {
        setMessage(msg);
        window.setTimeout(() => setMessage(null), 6000);
      }
    });
    return off;
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
  // Режим мастера планирования миссий (по умолчанию — новый мастер; legacy-редактор доступен через переключатель в шапке)
  const [wizardMode, setWizardMode] = useState<boolean>(
    () => localStorage.getItem('tq-ui-mode') !== 'legacy',
  );
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
    undoDrawingPoint,
    redoDrawingPoint,
  } = useStore();

  // Стартовая инициализация доменных сторов: миграция legacy-хранилища,
  // восстановление карты из IndexedDB, кросс-стор подписки (зоны→маршруты).
  useAppInitialization();

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

    // Ctrl/Meta+буквы — браузерные связки (Ctrl+T новая вкладка, Ctrl+O открыть файл,
    // Ctrl+S сохранить и т.п.): не перехватываем их транслитерацией русской раскладки.
    // (кроме разобранных выше Ctrl+Z / Ctrl+Y)
    if (e.ctrlKey || e.metaKey) return;

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

    // Зум с клавиатуры — через единый обработчик канваса (zoomAt): фиксация на центре
    // окна + ограничение в тех же границах minZoom..maxNativeZoom, что и у колеса мыши.
    // Раньше здесь были жёсткие Math.min(50)/Math.max(0.01) без привязки к зум-шкале
    // тайловой карты — лимиты расходились с канвасом, а центр «прыгал» из-за смены
    // scale без корректировки offset.
    if (e.key === '+' || e.key === '=' || e.key === '§') {
      e.preventDefault();
      eventBus.emit('map:zoom-request', { factor: 1.2 });
      return;
    }

    if (e.key === '-' || e.key === '_' || e.key === '–') {
      e.preventDefault();
      eventBus.emit('map:zoom-request', { factor: 1 / 1.2 });
      return;
    }

    // Tool shortcuts (без drawRect/drawCircle: ограничения — только NFZ-полигоны)
    if (['1', '2', '3', '4', '5'].includes(e.key)) {
      e.preventDefault();
      const tools = ['pan', 'select', 'addMarker', 'drawPolygon', 'measure'] as const;
      setTool(tools[Number(e.key) - 1]);
      return;
    }

    // Одиночные горячие клавиши срабатывают ТОЛЬКО без Ctrl/Meta/Alt.
    // Раньше транслитерация перехватывала связки: Ctrl+T (новая вкладка),
    // Alt+F (меню браузера), Ctrl+S и т.п. — браузерные комбинации не должны
    // подменять действия приложения.
    if (!(e.ctrlKey || e.metaKey || e.altKey)) {
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
    }
  }, [currentTool, selectedMarkerId, setTool,
    clearDrawingPoints, setMeasurementPoints, deleteMarker, project.settings?.showGrid,
    project.settings?.theme, updateSettings,
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
      <div className={(theme === "dark" ? "flex items-center px-3 py-1 bg-gray-900 border-b border-gray-700" : "flex items-center px-3 py-1 bg-white border-b border-gray-300") + " relative"}>
        <h1 className="text-sm font-bold text-cyan-400">
          🎯 TotalQuadro Mission Planner
        </h1>
        <span className="ml-2 text-xs text-gray-500">v1.0</span>
        <button
          onClick={() => {
            const next = !wizardMode;
            setWizardMode(next);
            localStorage.setItem('tq-ui-mode', next ? 'wizard' : 'legacy');
          }}
          className="ml-3 px-2 py-0.5 bg-cyan-800 hover:bg-cyan-700 border border-cyan-600 rounded text-xs text-white"
          title="Переключить мастер планирования миссий / классический редактор"
        >
          {wizardMode ? '🧭 Мастер миссий' : '🗺️ Редактор'}
        </button>
        {wizardMode && (
          <span className="relative ml-2"><WizardMapsStrip /></span>
        )}
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

      {wizardMode ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <MissionWizard />
        </div>
      ) : (
      /* Main content: desktop — 2 колонки; mobile — вертикально, карта 300–400 px + панель */
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
      )}

      {!wizardMode && <StatusBar />}

      {/* ЭТАП 1.3: бейдж онлайн/офлайн + статус офлайн-кэша (PWA) */}
      <OfflineIndicator />

      <StorageToast />
    </div>
  );
};

export default App;
