// ═══════════════════════════════════════════════════════════════
// mapProviders — единый реестр картографических провайдеров.
// Корневая причина «белой карты» в мастере: Google/Яндекс требуют
// API-ключ, а без него MapCanvas молча не рендерил ни тайлов, ни
// оверлея. Здесь сосредоточена декларативная проверка готовности
// провайдера (ключ/включение) для graceful degradation UI.
// ═══════════════════════════════════════════════════════════════
import type { Project } from '../types';

export type TileProviderId = 'osm' | '2gis' | 'opentopomap' | 'carto' | 'google' | 'yandex';

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

/** Бесплатные XYZ-провайдеры, работающие без ключа. */
export const KEYLESS_PROVIDERS: ReadonlySet<TileProviderId> = new Set(['osm', '2gis', 'opentopomap', 'carto']);

export function providerRequiresKey(id: TileProviderId): boolean {
  return id === 'google' || id === 'yandex';
}

/** URL-шаблон тайлов провайдера (для тестов и диагностики). */
export function tileUrlTemplate(id: TileProviderId): string {
  switch (id) {
    case '2gis':
      // Хост tile-b01.2gis.com не резолвится (ERR_NAME_NOT_RESOLVED) — слой «2ГИС»
      // рендерит бесплатную подложку Esri World Street Map (без ключа), как в getOSMTileUrl.
      return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
    case 'opentopomap':
      return 'https://tile.opentopomap.org/{z}/{x}/{y}.png';
    case 'carto':
      return 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
    case 'google':
      return 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}';
    case 'yandex':
      return 'https://core-jan-dev.webvisor.icu.ru/webmap/{z}/{y}/{x}.png';
    case 'osm':
    default:
      return 'https://tile.openstreetmap.org/{z}/{x}/{y}{r}.png';
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
      return { ...base, name: '2ГИС' };
    case 'opentopomap':
      return { ...base, name: 'OpenTopoMap' };
    case 'carto':
      return { ...base, name: 'CartoDB Light' };
    case 'osm':
    default:
      return { ...base, name: 'OpenStreetMap' };
  }
}
