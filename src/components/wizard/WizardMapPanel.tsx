// WizardMapPanel — ЕДИНЫЙ ЗАГРУЗЧИК КАРТ для обоих режимов.
// ТРЕБОВАНИЕ: «загрузчик карт должен быть один (тот, который в редакторе) и
// работать одновременно и в редакторе, и в мастере; все точки и маршруты
// должны просматриваться в обоих режимах». Реализация:
//  • этот модуль больше НЕ создаёт собственную карту — единственный экземпляр
//    MapCanvas живёт НЕПРЕРЫВНО на уровне App.tsx (см. <PersistentMap />), а
//    мастер использует ЕГО ЖЕ: DOM-узел карты переставляется в эту панель
//    императивной adopt-вставкой (без remount → без сброса вида/тайлов);
//  • загрузка подложки — единый код-путь ensureDefaultTileMap →
//    loadActiveTileMap с фиксацией над СПб (59.9398, 30.3146, z10);
//  • панель встраивается в поток этапа («экран в экране», min-h в px) —
//    вокруг остаётся место для списков точек, поиска и валидации;
//  • панорама и непрерывный зум работают из коробки (drag/колесо в MapCanvas);
//  • строгая гео-привязка: вид публикуется в localStorage-зеркало 'tq-view',
//    клики этапов конвертируются utils/mapGeoPick по той же Mercator-формуле;
//  • маркеры мастера синхронизируются в общий стор useMapStore.markers,
//    поэтому точки и маршруты просматриваются в ОБОИХ режимах.
import React, { useEffect, useRef, useState } from 'react';
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
export const ProviderSwitcher: React.FC = () => {
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

/** Автозагрузка подложки при монтировании панели (идемпотентно). */
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

/**
 * Единый живой контейнер карты (MapCanvas) — физический DOM-узел, которым
 * владеет непрерывный экземпляр <PersistentMap /> в App.tsx. Мастер
 * переставляет его в свою панель adopt-вставкой, редактор оставляет у себя.
 * Экземпляр ВСЕГДА один: без дублирующих загрузчиков, без гонок двух канвасов
 * за tq-view/очередь тайлов, без перемонтирования при смене шагов.
 */
export function getLiveMapContainer(): HTMLElement | null {
  return document.getElementById('map-container');
}

/** КОРНЕВОЙ ФИКС «карта не загружается в мастере» (единый загрузчик):
 *  панель принимает живой узел карты ТОЛЬКО если он стоит НЕПОСРЕДСТВЕННО в
 *  её хосте (`wizard-map-container`). Если PersistentMap пристроил карту в
 *  ПРОМЕЖУТОЧНЫЙ div панели (между хостом и картой), такой узел считается
 *  «вне» — панель переприкрепляет его к себе напрямую. Без этой проверки
 *  карта могла остаться в невидимом слоте/промежуточном родителе с нулевой
 *  высотой → ResizeObserver фиксировал 0px → «не удалось определить размер». */
function isAdoptedInHost(host: HTMLElement): boolean {
  const live = getLiveMapContainer();
  if (!live) return false;
  return live === host || live.parentElement === host;
}

/** Adopt-вставка: перенимает единственный живой узел карты в данный контейнер. */
function adoptLiveMapInto(host: HTMLElement): boolean {
  const live = getLiveMapContainer();
  if (!live) return false;
  if (isAdoptedInHost(host)) return true;
  host.appendChild(live); // перестановка существующего узла — НЕ remount React
  return true;
}

/** Встраиваемая панель карты для этапов мастера («экран в экране»).
 *  Содержимое — единый MapCanvas из App (<PersistentMap />), переставленный
 *  сюда adopt-вставкой; собственная копия загрузчика больше не создаётся. */
export function WizardMapPanel({ hint }: WizardMapPanelProps) {
  useEnsureTileMap();
  const project = useStore((s) => s.project);
  const status = getProviderStatus(project, (project.openStreetMap?.tileServer ?? 'osm') as TileProviderId);
  const hostRef = useRef<HTMLDivElement>(null);
  const [adopted, setAdopted] = useState<boolean>(() => !!getLiveMapContainer());

  // Перенимаем живой узел карты при каждом ре-рендере панели (смена этапа,
  // возврат из редактора). MutationObserver ловит момент, когда PersistentMap
  // ещё не смонтирован (первый тик приложения), и пристёгивает карту сразу
  // после её появления в DOM.
  // ВАЖНО: observer НЕ отключается после первого успеха — при смене этапа
  // React пересоздаёт DOM-узел хоста (новый пустой wizard-map-container), а
  // adopt-эффект панели на этот момент уже «отработал». Observer перехватывает
  // вставку нового хоста и возвращает живую карту в него (adopt без remount →
  // тайлы/вид не сбрасываются; повторный appendChild того же узла — no-op).
  useEffect(() => {
    const tryAdopt = (): void => {
      const host = hostRef.current;
      if (!host) return;
      if (adoptLiveMapInto(host)) setAdopted(true);
    };
    tryAdopt();
    // КОРНЕВОЙ ФИКС «карта не загружается в мастере»: при смене этапа React
    // пересоздаёт DOM-узел хоста (новый пустой wizard-map-container), и этот
    // effect обязан забрать живую карту СРАЗУ. Но adopt отсюда конкурировал с
    // place() PersistentMap, которая вызывалась синхронно из MutationObserver
    // прямо в момент нашей вставки — на «недостроенном» DOM она принимала
    // неверное решение и уводила карту в невидимый слот навсегда (следующих
    // мутаций не было). Теперь панель после своего монтирования эмитит явное
    // событие 'tq:map-place-request', а PersistentMap обрабатывает его в
    // микро-тик ПОСЛЕ завершения commit'а React — карта детерминированно
    // занимает актуальный хост. Двойной adopt идемпотентен (appendChild того
    // же узла = перестановка без remount).
    window.dispatchEvent(new Event('tq:map-place-request'));
    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(tryAdopt);
      mo.observe(document.body, { childList: true, subtree: true });
      return () => mo.disconnect();
    }
    return undefined;
  });

  return (
    <div
      className="relative flex min-h-[340px] w-full flex-1 basis-auto flex-col overflow-hidden rounded-lg border border-cyan-700/60 bg-slate-950 shadow-lg"
      style={{ height: 'calc(100vh - 300px)' }}
      data-testid="wizard-map-panel"
    >
      <ProviderSwitcher />
      {hint && (
        <div className="border-b border-slate-800 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">{hint}</div>
      )}
      {/* ФИКС «Не удалось определить размер карты» (КОРЕНЬ): раньше здесь был
          style={{ height: '100%' }} / h-full — в flex-колонке мастера
          процентная высота НЕ разрешается без пиксельного базиса у предков,
          контейнер схлопывался в 0px и срабатывал circuit breaker размеров.
          calc(100vh - Npx) даёт гарантированный ненулевой базис в ЛЮБОЙ среде,
          flex-basis:auto — реальную высоту внутри flex-колонки. */}
      <div
        ref={hostRef}
        className="relative w-full min-h-[280px] flex-1 basis-auto overflow-hidden"
        style={{ height: 'calc(100vh - 320px)' }}
        data-testid="wizard-map-container"
      >
        {/* aria-hidden: не перекликаться с aria-live-зонами этапов (role="status")
            в доступности; визуально — обычный индикатор ожидания. */}
        {!adopted && (
          <div
            aria-hidden="true"
            data-testid="wizard-map-waiting"
            className="absolute inset-0 flex items-center justify-center text-xs text-slate-400"
          >
            ⏳ Инициализация единой карты…
          </div>
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
    </div>
  );
}

export default WizardMapPanel;
