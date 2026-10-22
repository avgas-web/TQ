// WizardMapPanel — ВСТРОЕННАЯ ПАНЕЛЬ КАРТЫ («ЭКРАН В ЭКРАНЕ») режима мастера:
// полноценная интерактивная тайловая карта (OSM/2ГИС/Carto/Topo).
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
import React, { useEffect } from 'react';
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
}

/** Внутренний контент карты: переключатель подложек + MapCanvas. */
const MapPanelBody: React.FC<{ hint?: string; onMapLoaded?: (loaded: boolean) => void }> = ({ hint, onMapLoaded }) => {
  const project = useStore((s) => s.project);
  const status = getProviderStatus(project, (project.openStreetMap?.tileServer ?? 'osm') as TileProviderId);
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
      >
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
