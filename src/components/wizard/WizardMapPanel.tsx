// WizardMapPanel — полноценная интерактивная тайловая карта (OSM/2ГИС/Carto/Topo)
// внутри шагов Мастера миссий, требующих работы с картой.
// Корневая причина «карты не видно в мастере»: MapCanvas рендерился только в
// legacy-режиме «Редактор», а мастер использовал SVG-заглушку MiniMapCanvas без
// подложки. Здесь мастер получает тот же MapCanvas: контейнер имеет явные
// height:100%/flex:1 (ResizeObserver в MapCanvas инициализирует загрузку тайлов),
// z-index слоя тайлов ниже canvas-оверлея объектов — конфликта нет.
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

export function WizardMapPanel({ hint, onMapLoaded }: WizardMapPanelProps) {
  const project = useStore((s) => s.project);
  const status = getProviderStatus(project, (project.openStreetMap?.tileServer ?? 'osm') as TileProviderId);
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

  return (
    <div className="flex h-full min-h-0 w-full flex-col rounded-lg border border-slate-800 bg-slate-950" data-testid="wizard-map-panel">
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
    </div>
  );
}

export default WizardMapPanel;
