// WizardMapPanel — ОТДЕЛЬНОЕ ОКНО КАРТЫ режима мастера: полноценная
// интерактивная тайловая карта (OSM/2ГИС/Carto/Topo).
// ТРЕБОВАНИЕ: «окно с картой в режиме мастера — отдельное; карта загружается в
// него СРАЗУ ПРИ ЗАПУСКЕ; внутри карта передвигается и зумируется; все
// координаты в строгой привязке к реальным». Реализация:
//  • окно рендерится через createPortal в document.body поверх всего интерфейса
//    (fixed, максимальный z-index) — его не перекрывают ни контент этапов,
//    ни футер «Назад/Далее»; открывается кнопкой «🗺️ Карта» в навигации мастера
//    и автоматически при первом входе на этап с картой;
//  • загрузка — ЕДИНЫЙ код-путь с режимом планирования: тот же MapCanvas и та
//    же ensureDefaultTileMap → loadActiveTileMap с фиксацией над СПб
//    (59.9398, 30.3146, z10); панель сама гарантирует карту при монтировании;
//  • панорама и непрерывный зум работают из коробки (drag/колесо в MapCanvas);
//  • строгая гео-привязка: вид публикуется в localStorage-зеркало 'tq-view',
//    клики этапов конвертируются utils/mapGeoPick по той же Mercator-формуле.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import MapCanvas from '../MapCanvas';
import { useStore } from '../../store/useStore';
import { getProviderStatus, type TileProviderId } from '../../utils/mapProviders';
import { ensureDefaultTileMap } from '../../hooks/useAppInitialization';

const SERVER_LABELS: Record<'osm' | 'opentopomap' | 'carto' | '2gis', string> = {
  osm: '🌐 OSM',
  '2gis': '🧭 2ГИС',
  opentopomap: '⛰ Topo',
  carto: '💡 Light',
};

/** Панель переключения бесплатных XYZ-подложек + статус ключевых провайдеров. */
const ProviderSwitcher: React.FC = () => {
  const tileServer = useStore((s) => s.project.openStreetMap?.tileServer ?? 'osm');
  const setOSMTileServer = useStore((s) => s.setOSMTileServer);
  const google = useStore((s) => s.project.googleMaps);
  const yandex = useStore((s) => s.project.yandexMaps);

  // Graceful degradation: Google/Яндекс показаны, но помечены как требующие
  // ключа — при отсутствии ключа система НЕ падает, а подсказывает OSM/2ГИС.
  const gStatus = getProviderStatus({ googleMaps: google, yandexMaps: yandex }, 'google');
  const yStatus = getProviderStatus({ googleMaps: google, yandexMaps: yandex }, 'yandex');

  return (
    <div className="flex items-center gap-1 border-b border-slate-800 bg-slate-950 px-2 py-1" data-testid="wizard-map-providers">
      {(Object.keys(SERVER_LABELS) as Array<keyof typeof SERVER_LABELS>).map((id) => (
        <button
          key={id}
          type="button"
          data-testid={`wizard-tiles-${id}`}
          onClick={() => setOSMTileServer(id)}
          className={
            'rounded px-2 py-0.5 text-[11px] transition ' +
            (tileServer === id
              ? 'bg-cyan-600 font-bold text-white'
              : 'bg-slate-800 text-slate-300 hover:bg-slate-700')
          }
          title={id === '2gis' ? 'Публичные тайлы 2ГИС, API-ключ не требуется' : undefined}
        >
          {SERVER_LABELS[id]}
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
  /** Встроить карту в поток этапа вместо отдельного окна-портала.
   *  Нужно для jsdom-тестов (getBoundingClientRect нулевой → клики по окну
   *  не конвертируются в координаты) и для компактных layout'ов. */
  inline?: boolean;
}

/** Внутренний контент карты: переключатель подложек + MapCanvas.
 *  Используется и в отдельном окне мастера, и в inline-режиме (jsdom-тесты). */
const MapPanelBody: React.FC<{ hint?: string; onMapLoaded?: (loaded: boolean) => void }> = ({ hint, onMapLoaded }) => {
  const project = useStore((s) => s.project);
  const status = getProviderStatus(project, (project.openStreetMap?.tileServer ?? 'osm') as TileProviderId);
  return (
    <>
      <ProviderSwitcher />
      {hint && (
        <div className="border-b border-slate-800 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">{hint}</div>
      )}
      {/* Явные размеры контейнера обязательны: ResizeObserver внутри MapCanvas
          стартует загрузку тайлов только после получения ненулевых размеров. */}
      <div className="relative min-h-0 flex-1" style={{ height: '100%' }}>
        <MapCanvas onMapLoaded={onMapLoaded} />
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

/** Открывать ли отдельное окно карты по умолчанию при старте мастера.
 *  ТРЕБОВАНИЕ: «карта загружается в него СРАЗУ ПРИ ЗАПУСКЕ». Сохранённый вид
 *  ('tq-view') и hydrate-состояние мастера позволяют восстановить окно;
 *  значение можно принудительно выключить ключом 'tq-wizard-map-window'. */
function shouldOpenAtStartup(): boolean {
  try { if (localStorage.getItem('tq-wizard-map-window') === 'closed') return false; } catch { /* noop */ }
  return true;
}

export function WizardMapPanel({ hint, onMapLoaded }: WizardMapPanelProps) {
  useEnsureTileMap();
  // Встраиваемый режим (jsdom / узкие контейнеры): окно остаётся внутри потока.
  if (!document.body || typeof document.body.appendChild !== 'function') {
    return (
      <div className="flex h-full min-h-0 w-full flex-col rounded-lg border border-slate-800 bg-slate-950" data-testid="wizard-map-panel">
        <MapPanelBody hint={hint} onMapLoaded={onMapLoaded} />
      </div>
    );
  }
  return createPortal(
    <WizardMapWindow hint={hint} onMapLoaded={onMapLoaded} />,
    document.body,
  );
}

/** ОТДЕЛЬНОЕ ОКНО КАРТЫ мастера. Порталится в document.body с фиксированным
 *  позиционированием и максимальным z-index — перекрывающие слои (контент
 *  этапов, футер «Назад/Далее») ему не мешают. Панорама и зум — штатные жесты
 *  MapCanvas; координаты кликов этапов конвертируются через зеркало 'tq-view'
 *  (utils/mapGeoPick), поэтому остаются строго привязанными к реальности, даже
 *  когда окно свёрнуто полосой внизу экрана. */
function WizardMapWindow({ hint, onMapLoaded }: WizardMapPanelProps) {
  const [open, setOpen] = useState<boolean>(shouldOpenAtStartup);

  // Escape закрывает окно (в открытом состоянии оно перехватывает фокус мыши).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Синхронизация с глобальной кнопкой «🗺️ Карта» в навигации мастера
  // (MissionWizard публикует событие перед сменой этапа).
  useEffect(() => {
    const ev = 'tq:wizard-map-toggle';
    const onToggle = (): void => setOpen((o) => !o);
    const onShow = (): void => setOpen(true);
    window.addEventListener(ev, onToggle);
    window.addEventListener(`${ev}:show`, onShow);
    return () => {
      window.removeEventListener(ev, onToggle);
      window.removeEventListener(`${ev}:show`, onShow);
    };
  }, []);

  if (!open) {
    return (
      <div
        data-testid="wizard-map-window-collapsed"
        className="fixed bottom-1 left-1 z-[2147483646] rounded border border-cyan-700/60 bg-slate-950/90 px-2 py-1 text-[11px] text-cyan-300 shadow-lg"
      >
        🗺️ Карта свёрнута — нажмите «Карта» вверху мастера или{' '}
        <button
          type="button"
          data-testid="wizard-map-expand"
          className="rounded bg-cyan-700 px-1.5 py-0.5 font-bold text-white hover:bg-cyan-600"
          onClick={() => setOpen(true)}
        >
          развернуть
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="wizard-map-panel"
      data-open="1"
      className="fixed inset-1 z-[2147483646] flex min-h-0 w-auto flex-col rounded-lg border border-cyan-700/60 bg-slate-950 shadow-2xl"
    >
      {/* Заголовок окна: название + кнопки управления. drag/zoom карты
          живут ниже и работают как в редакторе. */}
      <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900 px-2 py-1">
        <span className="text-xs font-bold text-cyan-300">🗺️ Окно карты мастера · СПб · тяните для перемещения, колесо — зум</span>
        <span className="ml-auto text-[10px] text-slate-500">координаты — WGS84/Mercator, строгая привязка</span>
        <button
          type="button"
          data-testid="wizard-map-collapse"
          className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-700"
          title="Свернуть окно (вид и загрузка сохраняются)"
          onClick={() => setOpen(false)}
        >
          ▾ Свернуть
        </button>
      </div>
      <MapPanelBody hint={hint} onMapLoaded={onMapLoaded} />
    </div>
  );
}

export default WizardMapPanel;
