// ═══════════════════════════════════════════════════════════════
// mapProviders — единый реестр картографических провайдеров.
// Корневая причина «белой карты» в мастере: Google/Яндекс требуют
// API-ключ, а без него MapCanvas молча не рендерил ни тайлов, ни
// оверлея. Здесь сосредоточена декларативная проверка готовности
// провайдера (ключ/включение) для graceful degradation UI.
// ═══════════════════════════════════════════════════════════════
import type { Project } from '../types';
import { getEffectiveApiKey } from '../store/useApiKeysStore';

/** Legacy-реестр провайдеров. «2gis» УДАЛЁН ПОЛНОСТЬЮ (ТЗ): слой убран из
 *  всех списков выбора; старые сохранения нормализует normalizeTileServer(). */
export type TileProviderId = 'osm' | 'opentopomap' | 'carto' | 'google' | 'yandex';

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

/** Бесплатные XYZ-провайдеры, работающие без ключа.
 *  «2ГИС» УДАЛЁН ПОЛНОСТЬЮ (ТЗ): публичный тайловый сервис закрыт
 *  (tile-b01.2gis.com не резолвится), слой убран из всех списков выбора. */
export const KEYLESS_PROVIDERS: ReadonlySet<TileProviderId> = new Set(['osm', 'opentopomap', 'carto']);

export function providerRequiresKey(id: TileProviderId): boolean {
  return id === 'google' || id === 'yandex';
}

/** URL-шаблон тайлов провайдера (для тестов и диагностики).
 *  ВНИМАНИЕ: это legacy-реестр для оценок готовности; РЕАЛЬНАЯ загрузка тайлов
 *  идёт через openStreetMap.getOSMTileUrl/normalizeTileServer, где по аудиту
 *  audit/index.fixed.html запрещены tile.openstreetmap.org (403 по Referer для
 *  github.io) и basemaps.cartocdn.com (требует ключ). Шаблоны ниже — канонические
 *  URL провайдеров, но osm/carto при рендере нормализуются в рабочие зеркала. */
export function tileUrlTemplate(id: TileProviderId): string {
  switch (id) {
    case 'opentopomap':
      return 'https://tile.opentopomap.org/{z}/{x}/{y}.png';
    case 'carto':
      // Carto требует API-ключ (пункт B аудита) → при рендере нормализуется в OSM France.
      return 'https://a.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png';
    case 'google':
      return 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}';
    case 'yandex':
      return 'https://core-jan-dev.webvisor.icu.ru/webmap/{z}/{y}/{x}.png';
    case 'osm':
    default:
      // tile.openstreetmap.org отдаёт 403 по Referer с github.io → при рендере
      // нормализуется в Esri World Street Map (стиль по умолчанию аудита).
      return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
  }
}

/**
 * Оценка готовности провайдера по состоянию проекта.
 * Чистая функция — легко тестируется без DOM.
 * ЭТАП 1.2: наличие ключа проверяется через getEffectiveApiKey (сессионный
 * стор / .env), а НЕ через персистентный project.*.apiKey (поле удалено).
 */
export function getProviderStatus(project: Pick<Project, 'googleMaps' | 'yandexMaps'>, id: TileProviderId): ProviderStatus {
  const base = { id, name: '', ready: true, requiresKey: providerRequiresKey(id) };
  switch (id) {
    case 'google': {
      const hasKey = !!getEffectiveApiKey('google') && project.googleMaps.enabled;
      return {
        ...base,
        name: 'Google Maps',
        ready: hasKey,
        message: hasKey
          ? undefined
          : 'Требуется API-ключ Google Maps. Введите его в панели «Карты» или переключитесь на бесплатную подложку (Esri/OSM).',
      };
    }
    case 'yandex': {
      const hasKey = !!getEffectiveApiKey('yandex') && project.yandexMaps.enabled;
      return {
        ...base,
        name: 'Яндекс.Карты',
        ready: hasKey,
        message: hasKey
          ? undefined
          : 'Требуется API-ключ Яндекс.Карт. Введите его в панели «Карты» или переключитесь на бесплатную подложку (Esri/OSM).',
      };
    }
    // «2gis» УДАЛЁН ПОЛНОСТЬЮ (ТЗ): ветки нет — значение попадает в default (Esri-подложка)
    case 'opentopomap':
      return { ...base, name: 'OpenTopoMap' };
    case 'carto':
      return { ...base, name: 'CartoDB Light' };
    case 'osm':
    default:
      return { ...base, name: 'OpenStreetMap' };
  }
}
