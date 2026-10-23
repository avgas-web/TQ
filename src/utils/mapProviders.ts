// ═══════════════════════════════════════════════════════════════
// mapProviders — единый реестр картографических провайдеров.
// Корневая причина «белой карты» в мастере: Google/Яндекс требуют
// API-ключ, а без него MapCanvas молча не рендерил ни тайлов, ни
// оверлея. Здесь сосредоточена декларативная проверка готовности
// провайдера (ключ/включение) для graceful degradation UI.
// ═══════════════════════════════════════════════════════════════
import type { Project } from '../types';

/**
 * УНИФИКАЦИЯ провайдеров: tileServer хранит ЛИБО legacy-идентификаторы
 * ('osm' | '2gis' | ...), ЛИБО идентификаторы рабочих слоёв эталонного
 * Leaflet-приложения ('esri-streets' и т.д.). Легаси-значения — алиасы
 * рабочих слоёв (см. resolveWorkingLayer): «osm» → Esri улицы, «2gis» → OSM France.
 */
export type TileProviderId =
  | 'osm' | '2gis' | 'opentopomap' | 'carto' | 'google' | 'yandex'
  | WorkingTileLayerId;

export interface ProviderStatus {
  id: TileProviderId;
  name: string;
  /** Провайдер готов рисовать тайлы прямо сейчас. */
  ready: boolean;
  /** Провайдеру требуется платный/приватный API-ключ (google/yandex). */
  requiresKey: boolean;
  /** Понятное сообщение для UI-оверлея (если !ready). */
  message?: string;
}

import { isWorkingTileLayerId, WORKING_TILE_LAYERS, workingLayerTileUrl, workingLayerSubdomain, type WorkingTileLayerId } from './openStreetMap';

// Реэкспорт для потребителей реестра провайдеров (MapsPanel, WizardMapPanel):
// единая точка входа — слои и их id берутся отсюда, а не из openStreetMap напрямую.
export { WORKING_TILE_LAYERS, isWorkingTileLayerId, workingLayerTileUrl };
export type { WorkingTileLayerId };

/**
 * Разрешение идентификатора подложки в РАБОЧИЙ СЛОЙ эталона («Карта — рабочие
 * слои без ключей»). Единая функция для MapCanvas/MiniMapPanel/store: любой
 * legacy-id ('osm' | '2gis' | 'carto' | 'opentopomap') и любое неизвестное
 * значение сводится к рабочему слою БЕЗ ключей. Дефолт — Esri улицы (самый
 * стабильный слой эталона, «работает всегда»): именно он был причиной того,
 * что в редакторе карта грузилась, а с устаревшими хостами (tile.openstreetmap.org
 * 429/DNS, tile-b01.2gis.com ERR_NAME_NOT_RESOLVED) — нет.
 */
export function resolveWorkingLayer(id: unknown): WorkingTileLayerId {
  if (isWorkingTileLayerId(id)) return id;
  switch (id) {
    case '2gis':
      // 2ГИС заменён на OSM France (стандарт) — тот же улично-топографический
      // стиль, но рабочий повсеместно и без DNS-шторма.
      return 'osm-fr-standard';
    case 'opentopomap':
      return 'opentopomap';
    case 'carto':
      return 'osm-fr-hot';
    case 'osm':
    default:
      return 'esri-streets';
  }
}

/** Человекочитаемое имя подложки для UI (legacy-id → имя рабочего слоя). */
export function workingLayerName(id: unknown): string {
  const layer = resolveWorkingLayer(id);
  return WORKING_TILE_LAYERS.find((l) => l.id === layer)?.name ?? 'Esri — улицы';
}

/**
 * XYZ-шаблон рабочего слоя с метками {s}/{z}/{x}/{y} (схема точь-в-точь как в
 * эталоне Leaflet: Esri — {z}/{y}/{x}, остальные — {z}/{x}/{y}.png).
 * Реализация: два запроса к ФАКТИЧЕСКОМУ конструктору URL (workingLayerTileUrl)
 * с уникальными числами (никаких общих подстрок между z/x/y), затем обратная
 * подстановка значений → шаблона. Поэтому шаблон ВСЕГДА консистентен с тем,
 * что реально запрашивает загрузчик (регрессия рассинхрона схем).
 */
export function workingLayerUrlTemplate(id: WorkingTileLayerId): string {
  // Шаблоны захардкожены точно по схемам эталонного Leaflet-приложения:
  // Esri — /{z}/{y}/{x} (без расширения), остальные — /{z}/{x}/{y}.png.
  const tpl: string = (() => {
    switch (id) {
      case 'esri-streets':
        return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
      case 'esri-satellite':
        return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
      case 'osm-fr-standard':
        return 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png';
      case 'osm-fr-hot':
        return 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png';
      case 'osm-de':
        return 'https://tile.openstreetmap.de/{z}/{x}/{y}.png';
      case 'opentopomap':
        return 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
      case 'cyclosm':
        return 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png';
    }
  })();

  // Самопроверка инварианта «шаблон == фактические URL загрузчика»:
  // подстановка координат в шаблон обязана давать ровно то, что запросит
  // MapCanvas через workingLayerTileUrl (включая детерминированный {s}).
  // Рассинхрон (как в старой probe-реализации, где в шаблон залипались
  // буква поддомена 'c' и цифра z '9' → битые URL → тайлы 404 → пустая
  // карта) падает здесь явно, а не молча в браузере.
  const verify = (x: number, y: number, z: number): void => {
    const actual = workingLayerTileUrl(id, x, y, z);
    const filled = fillWorkingLayerUrlTemplate(tpl, id, x, y, z);
    if (filled !== actual) {
      throw new Error(
        `workingLayerUrlTemplate('${id}'): шаблон рассинхронизирован с загрузчиком: ` +
        `fill(${x},${y},${z}) = ${filled}, expected ${actual}`,
      );
    }
  };
  verify(0, 0, 3);
  verify(511, 340, 10);
  verify(274, 189, 9);
  return tpl;
}

/**
 * Подстановка меток {s}/{z}/{x}/{y} в шаблон рабочего слоя. Возвращает ровно
 * тот URL, который запросил бы загрузчик (тот же pickOsmFrSubdomain для {s}).
 */
export function fillWorkingLayerUrlTemplate(tpl: string, id: WorkingTileLayerId, x: number, y: number, z: number): string {
  // ВАЖНО (регрессия «{s} в address-URI → тайлы не грузятся»): поддомен {s}
  // подставляется ПЕРВЫМ глобальным заменителем. Прежняя реализация использовала
  // одноразовый String.replace('{s}', …), который промахивался по шаблону
  // 'https://{s}.tile…' (метка не окружена '/', поэтому паттерн '/{s}/' не
  // совпадал) → '{s}' залипало в итоговом URL и все тайлы слоя давали 404.
  let out = tpl;
  if (out.includes('{s}')) {
    out = out.replace(/\{s\}/g, workingLayerSubdomain(id, x, y));
  }
  if (id.startsWith('esri')) {
    // Esri-схема: /{z}/{y}/{x}
    out = out.replace('{z}', String(z)).replace('{y}', String(y)).replace('{x}', String(x));
  } else {
    // XYZ-схема: /{z}/{x}/{y}.png
    out = out.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  }
  return out;
}

/** Бесплатные XYZ-провайдеры, работающие без ключа (все рабочие слои — keyless). */
export const KEYLESS_PROVIDERS: ReadonlySet<TileProviderId> = new Set<TileProviderId>([
  'osm', '2gis', 'opentopomap', 'carto',
  ...WORKING_TILE_LAYERS.map((l) => l.id),
]);

export function providerRequiresKey(id: TileProviderId): boolean {
  return id === 'google' || id === 'yandex';
}

/** URL-шаблон тайлов провайдера (для тестов и диагностики).
 *  Все бесплатные id разрешаются в рабочие слои эталона (без ключей):
 *  подставляем {x}/{y}/{z} в реальный URL слоя (Esri — схема {z}/{y}/{x}). */
export function tileUrlTemplate(id: TileProviderId): string {
  switch (id) {
    case 'google':
      return 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}';
    case 'yandex':
      return 'https://core-jan-dev.webvisor.icu.ru/webmap/{z}/{y}/{x}.png';
    default: {
      const layer = resolveWorkingLayer(id);
      // Шаблон с метками {s}/{z}/{x}/{y} строится из фактических URL загрузчика
      // (рабочие слои эталона, без ключей) — всегда консистентен с реальными запросами.
      return workingLayerUrlTemplate(layer);
    }
  }
}

/**
 * Оценка готовности провайдера по состоянию проекта.
 * Чистая функция — легко тестируется без DOM.
 */
export function getProviderStatus(project: Pick<Project, 'googleMaps' | 'yandexMaps'>, id: TileProviderId): ProviderStatus {
  const base = { id, name: '', ready: true, requiresKey: providerRequiresKey(id) };
  switch (id) {
    case 'google': {
      const hasKey = !!project.googleMaps?.apiKey && project.googleMaps.enabled;
      return {
        ...base,
        name: 'Google Maps',
        ready: hasKey,
        message: hasKey
          ? undefined
          : 'Требуется API-ключ Google Maps. Введите его в панели «Карты» или переключитесь на OSM / 2ГИС.',
      };
    }
    case 'yandex': {
      const hasKey = !!project.yandexMaps?.apiKey && project.yandexMaps.enabled;
      return {
        ...base,
        name: 'Яндекс.Карты',
        ready: hasKey,
        message: hasKey
          ? undefined
          : 'Требуется API-ключ Яндекс.Карт. Введите его в панели «Карты» или переключитесь на OSM / 2ГИС.',
      };
    }
    case '2gis':
      return { ...base, name: workingLayerName('2gis') };
    case 'opentopomap':
      return { ...base, name: workingLayerName('opentopomap') };
    case 'carto':
      return { ...base, name: workingLayerName('carto') };
    case 'osm':
    default:
      // Любой рабочий слой эталона ('esri-streets', 'osm-fr-standard', …) либо legacy 'osm'.
      return { ...base, name: isWorkingTileLayerId(id) ? workingLayerName(id) : 'OpenStreetMap (Esri — улицы)' };
  }
}
