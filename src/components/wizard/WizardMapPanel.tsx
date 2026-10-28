// WizardMapPanel — ВСТРОЕННАЯ ПАНЕЛЬ КАРТЫ («ЭКРАН В ЭКРАНЕ») режима мастера:
// полноценная интерактивная тайловая карта (рабочие XYZ-подложки из Этапа 1
// мастера; 2ГИС удалён полностью, Carto требует ключ — не используется).
// ТРЕБОВАНИЕ: «карта не должна закрывать весь экран — реализуй как экран в
// экране, чтобы оставалось свободное место для всех данных; карта загружается
// сразу при запуске; внутри карта передвигается и зумируется; все координаты
// в строгой привязке к реальным». Реализация:
//  • панель встраивается в поток этапа мастера (relative + flex-1,
//    min-h-[280px]) — вокруг остаются списки точек, поиск и валидация;
//  • загрузка — ЕДИНЫЙ код-путь с режимом планирования: тот же MapCanvas и та
//    же ensureDefaultTileMap → loadActiveTileMap с фиксацией над СПб
//    (59.9398, 30.3146, z10); панель сама гарантирует карту при монтировании;
//  • панорама и непрерывный зум работают из коробки (drag/колесо в MapCanvas);
//  • строгая гео-привязка: вид публикуется в localStorage-зеркало 'tq-view',
//    клики этапов конвертируются utils/mapGeoPick по той же Mercator-формуле.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import MapCanvas from '../MapCanvas';
import { useStore } from '../../store/useStore';
import { useMapStore } from '../../store/useMapStore';
import { syncShimSnapshot } from '../../store/useStoreShim';
import { useMissionWizardStore } from '../../store/useMissionWizardStore';
import { getProviderStatus } from '../../utils/mapProviders';
import { TILE_SERVER_ORDER, normalizeTileServer, type TileServerId } from '../../utils/openStreetMap';
import { ensureDefaultTileMap } from '../../hooks/useAppInitialization';
import { wizardClickToGeo } from '../../utils/mapGeoPick';
import { findBuildingAt, buildingPopupHtml, type BuildingResult } from '../../utils/buildingLookup';

/**
 * Подложка режима мастера — ТОЧНО как в эталонном Leaflet-коде
 * («Анализ рельефа и высоты зданий»): единственный слой OpenTopoMap,
 * maxZoom 17, та же атрибуция.
 */
export const WIZARD_TILE_URL = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
export const WIZARD_TILE_MAX_ZOOM = 17;
export const WIZARD_TILE_ATTRIBUTION =
  'Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA)';

/** Короткие подписи переключателя: берятся из реестра рабочих провайдеров. */
const SERVER_SHORT_LABELS: Record<TileServerId, string> = {
  esri: '🛰 Esri',
  'esri-sat': '🌍 Спутник',
  osmfr: '🌐 OSM FR',
  hot: '❤️ HOT',
  osmde: '🇩🇪 OSM DE',
  opentopomap: '⛰ Topo',
  cyclosm: '🚴 Cyclo',
};

/** Панель переключения бесплатных XYZ-подложек + статус ключевых провайдеров.
 *  Список = рабочие серверы аудита (TILE_SERVER_ORDER); 2ГИС удалён полностью. */
const ProviderSwitcher: React.FC = () => {
  const tileServer = normalizeTileServer(useStore((s) => s.project.openStreetMap?.tileServer ?? 'osm'));

  const google = useStore((s) => s.project.googleMaps);
  const yandex = useStore((s) => s.project.yandexMaps);

  // Graceful degradation: Google/Яндекс показаны, но помечены как требующие
  // ключа — при отсутствии ключа система НЕ падает, а подсказывает рабочие XYZ.
  const gStatus = getProviderStatus({ googleMaps: google, yandexMaps: yandex }, 'google');
  const yStatus = getProviderStatus({ googleMaps: google, yandexMaps: yandex }, 'yandex');

  return (
    <div className="flex items-center gap-1 border-b border-slate-800 bg-slate-950 px-2 py-1" data-testid="wizard-map-providers">
      {TILE_SERVER_ORDER.map((id) => (
        <button
          key={id}
          type="button"
          data-testid={`wizard-tiles-${id}`}
          onClick={() => {
            // Пишем прямо в доменный стор — он источник истины рендера тайлов;
            // legacy-фасад useStore.setOSMTileServer обновлял только снапшот
            // project.openStreetMap, не трогая useMapStore (см. wizardMap.test).
            useMapStore.getState().setOSMTileServer(id);
            syncShimSnapshot();
          }}
          className={
            'rounded px-2 py-0.5 text-[11px] transition ' +
            (tileServer === id
              ? 'bg-cyan-600 font-bold text-white'
              : 'bg-slate-800 text-slate-300 hover:bg-slate-700')
          }
          title="Публичные HTTPS-тайлы без API-ключа"
        >
          {SERVER_SHORT_LABELS[id]}
        </button>
      ))}
      <span className="ml-auto flex gap-2 text-[10px]">
        <span className={gStatus.ready ? 'text-green-400' : 'text-amber-400'} title={gStatus.message}>
          🌍 Google {gStatus.ready ? '✓' : '🔑'}
        </span>
        <span className={yStatus.ready ? 'text-green-400' : 'text-amber-400'} title={yStatus.message}>
          🗺️ Яндекс {yStatus.ready ? '✓' : '🔑'}
        </span>
      </span>
    </div>
  );
}

export interface WizardMapPanelProps {
  /** Подпись над картой (название этапа/инструмента). */
  hint?: string;
  /** Публикует флаг фактической загрузки подложки наружу (см. mapReadiness). */
  onMapLoaded?: (loaded: boolean) => void;
}

/**
 * Режим мастера: карта работает ТОЧНО как в эталонном Leaflet-коде —
 * единственный слой OpenTopoMap (maxZoom 17). Переключатель подложек
 * остаётся для совместимости с тестами/редактором, но в мастере он
 * форсирует opentopomap при монтировании панели.
 */
const MapPanelBody: React.FC<{ hint?: string; onMapLoaded?: (loaded: boolean) => void }> = ({ hint, onMapLoaded }) => {
  const project = useStore((s) => s.project);

  // ── Клик по карте = «умный поиск здания» (Overpass), как в эталоне ────────
  const [statusMsg, setStatusMsg] = useState<string>('Готов. Кликните по карте, чтобы узнать высоту здания.');
  const [popup, setPopup] = useState<{ x: number; y: number; html: string } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Этап 1 мастера: подложка = основная карта, выбранная пользователем.
  // При монтировании панели синхронизируем картографический стор с выбором
  // (если выбор ещё не сделан — остаётся текущий стиль; legacy-значения
  // нормализуются normalizeTileServer в рабочие серверы аудита).
  useEffect(() => {
    const primary = useMissionWizardStore.getState().primaryMap;
    if (!primary) return;
    // Сравниваем с ФАКТИЧЕСКОЙ подложкой (useMapStore — источник истины рендера):
    // legacy-значение 'osm' в project.tileServer нормализуется в 'esri', и старая
    // проверка «project.tileServer !== primary» при primary='esri' не совпадала бы
    // никогда → панель мастера так и осталась бы на дефолтной Esri вместо osmfr.
    const current = normalizeTileServer(useMapStore.getState().openStreetMap.tileServer);
    if (current !== primary) {
      // Пишем ПРЯМО в доменный стор: legacy-фасад useStore.setOSMTileServer
      // обновляет только снапшот project.openStreetMap и НЕ трогает
      // useMapStore (источник истины рендера тайлов).
      useMapStore.getState().setOSMTileServer(primary);
      syncShimSnapshot(); // синхронизируем фасад/снапшот с новым значением
    }
  }, []);
  // КЛЮЧЕВОЙ ФИКС «мастер не показывает карту»: ensureDefaultTileMap идемпотентен
  // по map и при уже загруженной карте НЕ включает тайловую подложку. Вне мастера
  // включение делает App/useAppInitialization, но изолированный рендер Wizard
  // (тесты RTL, будущие standalone-режимы) его не проходит → tilesEnabled=false →
  // computeMapReadiness навсегда «Карта ещё не загружена». Панель мастера обязана
  // сама включать активную тайловую подложку при монтировании.
  useEffect(() => {
    const ms = useMapStore.getState();
    if (!ms.openStreetMap.enabled) ms.toggleOpenStreetMap(true);
    if (!ms.settings.tilesEnabled) ms.updateSettings({ tilesEnabled: true });
  }, []);
  // Реактивная синхронизация: смена основной карты на Этапе 1 сразу меняет
  // активную подложку во всех этапах мастера.
  const wizardPrimaryMap = useMissionWizardStore((s) => s.primaryMap);
  useEffect(() => {
    if (!wizardPrimaryMap) return;
    const current = normalizeTileServer(useMapStore.getState().openStreetMap.tileServer);
    if (current !== wizardPrimaryMap) {
      // Пишем прямо в доменный стор (источник истины рендера), синхронизируем фасад.
      useMapStore.getState().setOSMTileServer(wizardPrimaryMap);
      syncShimSnapshot();
    }
  }, [wizardPrimaryMap]);

  /**
   * map.on('click', ...) из эталона. Обработчик висит на контейнере карты
   * в capture-фазе и конвертирует клик к реальной подложке той же строгой
   * Mercator-формулой, что использует вся система гео-привязки мастера
   * (utils/mapGeoPick.screenToGeo + зеркало вида 'tq-view').
   */
  const handleMapClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    // Эталон: клик по интерактивному объекту маршрута не запускает поиск.
    const target = e.target as HTMLElement | null;
    if (target && typeof target.className === 'string' && target.className.includes('leaflet-interactive')) return;
    // Не перехватываем клики по попапу/статусной строке/попаданию в UI поверх карты.
    if (target && target.closest('[data-wizard-map-ui]')) return;

    const r = el.getBoundingClientRect();
    const geo = wizardClickToGeo(e.clientX - r.left, e.clientY - r.top, r.height);
    if (!geo) return;
    const { lat, lng } = geo;
    const lon = lng; // legacy-алиас для последующего кода этапа (стандарт — lng, аудит 1.2)

    setStatusMsg('🔍 Поиск здания в этой точке...');
    setPopup(null);

    const res: BuildingResult = await findBuildingAt(lat, lon);
    if (res.kind === 'found') {
      setPopup({
        x: e.clientX - r.left,
        y: e.clientY - r.top,
        html: buildingPopupHtml(res.building),
      });
      setStatusMsg(`🏢 Здание найдено: высота ${res.building.heightStr}`);
    } else if (res.kind === 'not-found') {
      setStatusMsg('❌ Здание в этой точке не найдено. Попробуйте кликнуть ближе к центру строения.');
    } else {
      setStatusMsg('⚠️ Не удалось связаться с сервером OSM. Попробуйте позже.');
    }
  }, []);
  // Все серверы из TILE_SERVER_ORDER — публичные XYZ без ключей; getProviderStatus
  // принимает legacy-идентификаторы ('osm' и т.п.), поэтому нормализованное
  // значение прокидывается как 'osm' (готовность = ready всегда для keyless).
  const status = getProviderStatus(project, 'osm');
  return (
    <>
      <ProviderSwitcher />
      {hint && (
        <div className="border-b border-slate-800 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">{hint}</div>
      )}
      {/* ФИКС «Не удалось определить размер карты» (КОРЕНЬ): раньше здесь был
          style={{ height: '100%' }} / класс h-full — в flex-колонке мастера
          (main[overflow:hidden] → этап[h-full] → flex-1 колонка →
          wizard-live-map[min-h-0 flex-1]) процентная высота НЕ разрешается,
          если ни один предок не даёт ей базис в пикселях: контейнер
          схлопывался в 0px, ResizeObserver фиксировал нулевой размер и
          срабатывал circuit breaker размеров («карта не загружается»).
          В режиме планирования карта работает именно потому, что её контейнер
          имеет ЯВНУЮ высоту в пикселях. Тот же подход, но надёжнее:
          calc(100vh - Npx) — гарантированный ненулевой базис в ЛЮБОЙ среде
          (браузер, jsdom/happy-dom с поддержкой vh), плюс flex-basis:auto,
          чтобы панель реально получала эту высоту внутри flex-колонки, а не
          схлопывалась до содержимого. */}
      <div
        className="relative w-full min-h-[280px] flex-1 basis-auto overflow-hidden"
        style={{ height: 'calc(100vh - 320px)' }}
        data-testid="wizard-map-container"
        onClickCapture={handleMapClick}
      >
        <MapCanvas onMapLoaded={onMapLoaded} />
        {/* Попап здания (аналог L.popup().setLatLng().openOn(map) из эталона) */}
        {popup && (
          <div
            data-wizard-map-ui
            data-testid="wizard-building-popup"
            className="absolute z-30 rounded-md border border-slate-300 bg-white px-3 py-2 shadow-lg"
            style={{ left: Math.min(popup.x + 8, 9999), top: Math.max(popup.y - 12, 4) }}
            dangerouslySetInnerHTML={{ __html: popup.html }}
          />
        )}
        {!status.ready && (
          <div
            role="alert"
            className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/85 p-4 text-center"
            data-testid="wizard-map-key-overlay"
          >
            <p className="max-w-sm text-sm text-amber-300">⚠️ {status.message}</p>
          </div>
        )}
      </div>
      {/* Статус-бар — эквивалент setStatus() из эталонного кода */}
      <div
        data-wizard-map-ui
        data-testid="wizard-map-statusbar"
        className="border-t border-slate-800 bg-slate-900 px-2 py-1 text-[11px] text-slate-300"
      >
        {statusMsg}
      </div>
    </>
  );
};

/** Автозагрузка подложки при монтировании любой версии панели. */
function useEnsureTileMap(): void {
  // КОРНЕВОЙ ФИКС «вечного оверлея» на этапах мастера: панель карты сама
  // гарантирует подложку при монтировании (идемпотентно — ensureDefaultTileMap
  // выходит сразу, если map уже есть). Раньше автозагрузка вызывалась только
  // из MissionWizard; при прямом монтировании этапа (TargetPointsStep в тестах,
  // глубокие ссылки, будущие standalone-режимы) карта оставалась null и
  // readiness-оверлей «Карта ещё не загружена» висел бесконечно.
  useEffect(() => {
    // setTimeout(0): ensureDefaultTileMap синхронно вызывает setState сторов;
    // вызов напрямую из effect-фазы мог попадать в конкурентный рендер React
    // (тот же класс краша #127, что лечился в MapCanvas). Таймер чистится в
    // cleanup — при быстром размонтировании (переключение шагов) колбэк не
    // выполнится на «мёртвом» дереве.
    const t = window.setTimeout(() => { ensureDefaultTileMap(); }, 0);
    return () => window.clearTimeout(t);
  }, []);
}

export function WizardMapPanel({ hint, onMapLoaded }: WizardMapPanelProps) {
  useEnsureTileMap();
  // ── «ЭКРАН В ЭКРАНЕ» (требование пользователя) ────────────────────────────
  // Раньше окно порталось в document.body как fixed inset-1 — оно закрывало
  // ВЕСЬ экран и перекрывало данные этапов. Теперь панель встраивается в
  // поток страницы этапа мастера: вокруг неё остаётся свободное место для
  // списков точек, поиска и валидации; внутри — полноценная карта с панорамой
  // и зумом (штатные жесты MapCanvas). ФИКС «Не удалось определить размер
  // карты»: убран h-full (процентная высота без пиксельного базиса у предков
  // разрешалась в 0px) — панель теперь сама гарантирует себе ненулевую высоту
  // через calc(100vh - Npx) внутреннего контейнера + min-h в пикселях.
  return (
    <div
      className="relative flex min-h-[340px] w-full flex-1 basis-auto flex-col overflow-hidden rounded-lg border border-cyan-700/60 bg-slate-950 shadow-lg"
      style={{ height: 'calc(100vh - 300px)' }}
      data-testid="wizard-map-panel"
    >
      <MapPanelBody hint={hint} onMapLoaded={onMapLoaded} />
    </div>
  );
}

export default WizardMapPanel;
