// Утилиты для работы с OpenStreetMap
import { calculateBoundsFromCenter, latToMercatorY } from './googleMaps';
import type { TileServerId } from '../types';

/**
 * Разрешение legacy-алиасов подложек в рабочие слои эталона. Реализация —
 * в mapProviders.resolveWorkingLayer; связь односторонняя: mapProviders
 * импортирует ЭТОТ модуль (WORKING_TILE_LAYERS и т.д.), а здесь алиасы
 * разворачиваются локальной таблицей (без цикла импортов). Таблица обязана
 * оставаться синхронной resolveWorkingLayer в mapProviders.ts.
 */
const LEGACY_ALIAS_TO_WORKING_LAYER: Record<'osm' | '2gis' | 'carto' | 'opentopomap', WorkingTileLayerId> = {
  osm: 'esri-streets',      // Esri World_Street_Map — «работает всегда» (эталон)
  '2gis': 'osm-fr-standard',// замена мёртвого tile-b01.2gis.com (DNS-шторм, PR #111)
  carto: 'osm-fr-hot',      // светлый «light» стиль без блокируемого cartocdn
  opentopomap: 'opentopomap',
};
function resolveWorkingLayer(id: unknown): WorkingTileLayerId {
  if (isWorkingTileLayerId(id)) return id;
  if (id === 'osm' || id === '2gis' || id === 'carto' || id === 'opentopomap') {
    return LEGACY_ALIAS_TO_WORKING_LAYER[id];
  }
  return DEFAULT_WORKING_LAYER;
}

/**
 * Рабочие XYZ-зеркала OpenStreetMap, проверенные на доступность БЕЗ ключей и
 * без DNS-блокировок. Основной пул tile.openstreetmap.org в ряде сетей отдаёт
 * 429/ERR_CONNECTION_TIMED_OUT, а tile-b01.2gis.com — ERR_NAME_NOT_RESOLVED
 * (см. TwoGis ниже). Список взят из заведомо рабочего эталона (Leaflet-приложение):
 *  - Esri World_Street_Map / World_Imagery — самые стабильные, работают всегда;
 *  - OSM France ({s}=a/b/c) и OSM Germany — независимые серверы OSM-сообщества,
 *    не делят лимиты основного tile.openstreetmap.org;
 *  - OpenTopoMap / CyclOSM — тематические подложки без ключей.
 * Порядок = приоритет: первый хост дефолтный, остальные подключаются
 * автоматически при сбоях (watchLayerErrors-логика перебора зеркал).
 */
export const OSM_WORKING_HOSTS = {
  esriStreets: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile',
  esriImagery: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile',
  osmFrSub: ['a', 'b', 'c'] as const,
  /**
   * ВАЖНО (регрессия «{s} залипает в URL → тайлы не грузятся»): базы хранятся
   * БЕЗ метки '{s}' в хосте. Метка внутри hostname ломает и `new URL()`
   * (валидация address-URI), и строковый `.replace('{s}', …)` в некоторых
   * окружениях — итог: запрос на https://a.tile.openstreetmap.fr/osmfr/{s}/3/0/0.png
   * (404 на каждый тайл). Поддомен подставляется функцией workingLayerHost()
   * конкатенацией, а не replace'ом.
   */
  osmFrBase: 'https://.tile.openstreetmap.fr/osmfr',
  osmFrHotBase: 'https://.tile.openstreetmap.fr/hot',
  osmDe: 'https://tile.openstreetmap.de',
  opentopoBase: 'https://.tile.opentopomap.org',
  cyclosmBase: 'https://.tile-cyclosm.openstreetmap.fr/cyclosm',
} as const;

/** Хост рабочего слоя с детерминированным поддоменом {a,b,c} (как subdomains:'abc' в эталоне). */
function workingLayerHost(base: string, id: WorkingTileLayerId, x: number, y: number): string {
  if (!workingLayerUsesSubdomain(id)) return base;
  const sub = pickOsmFrSubdomain(x, y);
  // base вида 'https://.tile…' — вставляем поддомен сразу после '://'.
  return `${base.slice(0, base.indexOf('//') + 2)}${sub}${base.slice(base.indexOf('//') + 2)}`;
}

/**
 * Идентификаторы рабочих подложек эталонного Leaflet-приложения
 * («Карта — рабочие слои без ключей»): все они бесплатны и НЕ требуют API-ключей.
 * Встроены вместо OSM/2ГИС как единый набор слоёв для обоих режимов
 * (редактор и мастер используют один и тот же загрузчик MapCanvas).
 */
export type WorkingTileLayerId =
  | 'esri-streets'
  | 'esri-satellite'
  | 'osm-fr-standard'
  | 'osm-fr-hot'
  | 'osm-de'
  | 'opentopomap'
  | 'cyclosm';

/** Метаданные слоя для UI-селектора (порядок = как в эталоне). */
export interface WorkingTileLayerMeta {
  id: WorkingTileLayerId;
  name: string;
  attribution: string;
  /** Нативный максимум зума (сверх — тайлов нет; MapCanvas включает overzoom). */
  maxNativeZoom: number;
}

const OSM_ATTR = '© OpenStreetMap contributors';
const ESRI_ATTR = 'Tiles © Esri';

export const WORKING_TILE_LAYERS: readonly WorkingTileLayerMeta[] = [
  { id: 'esri-streets', name: 'Esri — улицы', attribution: ESRI_ATTR, maxNativeZoom: 19 },
  { id: 'esri-satellite', name: 'Esri — спутник', attribution: ESRI_ATTR, maxNativeZoom: 19 },
  { id: 'osm-fr-standard', name: 'OSM France (стандарт)', attribution: `${OSM_ATTR} | OSM France`, maxNativeZoom: 19 },
  { id: 'osm-fr-hot', name: 'OSM France (гуманитарный)', attribution: `${OSM_ATTR} | HOT France`, maxNativeZoom: 19 },
  { id: 'osm-de', name: 'OSM Germany', attribution: `${OSM_ATTR} | OSM Germany`, maxNativeZoom: 18 },
  { id: 'opentopomap', name: 'OpenTopoMap', attribution: `${OSM_ATTR} | OpenTopoMap (CC-BY-SA)`, maxNativeZoom: 17 },
  { id: 'cyclosm', name: 'CyclOSM', attribution: `${OSM_ATTR} | CyclOSM`, maxNativeZoom: 19 },
] as const;

/** Дефолтная подложка эталона — самая стабильная («работает всегда»). */
export const DEFAULT_WORKING_LAYER: WorkingTileLayerId = 'esri-streets';

export function isWorkingTileLayerId(v: unknown): v is WorkingTileLayerId {
  return typeof v === 'string' && WORKING_TILE_LAYERS.some((l) => l.id === v);
}

/**
 * Построение URL тайла по схеме слоя. Схемы точь-в-точь как в рабочем эталоне:
 *  - Esri: {z}/{y}/{x} (без расширения);
 *  - прочие XYZ: {z}/{x}/{y}.png.
 */
export function workingLayerTileUrl(id: WorkingTileLayerId, x: number, y: number, zRaw: number): string {
  switch (id) {
    case 'esri-streets': {
      const z = Math.min(Math.max(zRaw, 0), 19);
      return `${OSM_WORKING_HOSTS.esriStreets}/${z}/${y}/${x}`;
    }
    case 'esri-satellite': {
      const z = Math.min(Math.max(zRaw, 0), 19);
      return `${OSM_WORKING_HOSTS.esriImagery}/${z}/${y}/${x}`;
    }
    case 'osm-fr-standard': {
      const z = Math.min(Math.max(zRaw, 0), 19);
      return `${workingLayerHost(OSM_WORKING_HOSTS.osmFrBase, id, x, y)}/${z}/${x}/${y}.png`;
    }
    case 'osm-fr-hot': {
      const z = Math.min(Math.max(zRaw, 0), 19);
      return `${workingLayerHost(OSM_WORKING_HOSTS.osmFrHotBase, id, x, y)}/${z}/${x}/${y}.png`;
    }
    case 'osm-de': {
      const z = Math.min(Math.max(zRaw, 0), 18);
      return `${OSM_WORKING_HOSTS.osmDe}/${z}/${x}/${y}.png`;
    }
    case 'opentopomap': {
      const z = Math.min(Math.max(zRaw, 0), 17);
      return `${workingLayerHost(OSM_WORKING_HOSTS.opentopoBase, id, x, y)}/${z}/${x}/${y}.png`;
    }
    case 'cyclosm': {
      const z = Math.min(Math.max(zRaw, 0), 19);
      return `${workingLayerHost(OSM_WORKING_HOSTS.cyclosmBase, id, x, y)}/${z}/${x}/${y}.png`;
    }
  }
}

/**
 * Публичный доступ к детерминированному выбору поддомена слоя — используется
 * fillWorkingLayerUrlTemplate в mapProviders для консистентности шаблонов.
 */
export function workingLayerSubdomain(id: WorkingTileLayerId, x: number, y: number): string {
  if (!workingLayerUsesSubdomain(id)) return '';
  return pickOsmFrSubdomain(x, y);
}

function workingLayerUsesSubdomain(id: WorkingTileLayerId): boolean {
  return id === 'osm-fr-standard' || id === 'osm-fr-hot' || id === 'opentopomap' || id === 'cyclosm';
}

/** Детерминированный выбор поддомена {a,b,c} (как subdomains:'abc' в эталоне). */
function pickOsmFrSubdomain(x: number, y: number): 'a' | 'b' | 'c' {
  const subs = OSM_WORKING_HOSTS.osmFrSub;
  return subs[(Math.abs(x) + Math.abs(y)) % subs.length];
}

/** Запасные рабочие хосты того же стиля для отказоустойчивости (эталон watchTileErrors). */
function workingLayerFallbackIds(id: WorkingTileLayerId): WorkingTileLayerId[] {
  switch (id) {
    case 'esri-streets': return ['osm-fr-standard', 'osm-de'];
    case 'esri-satellite': return ['osm-fr-standard', 'osm-de'];
    case 'osm-fr-standard': return ['osm-de', 'esri-streets'];
    case 'osm-fr-hot': return ['osm-de', 'esri-streets'];
    case 'osm-de': return ['osm-fr-standard', 'esri-streets'];
    case 'opentopomap': return ['osm-fr-standard', 'esri-streets'];
    case 'cyclosm': return ['osm-fr-standard', 'esri-streets'];
  }
}

/** Полный URL-кандидаты для перебора при сбое основного слоя. */
export function workingLayerFallbackUrls(id: WorkingTileLayerId, x: number, y: number, z: number): string[] {
  return workingLayerFallbackIds(id).map((alt) => workingLayerTileUrl(alt, x, y, z));
}

/** Зеркала тайлового сервера tile.openstreetmap.org (перебираются при ошибках/таймаутах) */
const OSM_TILE_MIRRORS = [
  'https://tile.openstreetmap.org',
  'https://a.tile.openstreetmap.org',
  'https://b.tile.openstreetmap.org',
  'https://c.tile.openstreetmap.org',
];

/**
 * Санация УСТАРЕВШИХ 2ГИС-URL (полный вывод домена из загрузки).
 * По конSOLE-логам пользователя было установлено: ВСЕ хосты 2ГИС недоступны —
 *   - tile-b01.2gis.com → net::ERR_NAME_NOT_RESOLVED (DNS-блокировка, PR #111);
 *   - sl{1..4}.2gis.com → таймауты/ошибки соединения (не резолвятся либо
 *     блокируются сетью/файрволом) — даже после перебора зеркал карта в
 *     мастере оставалась пустой.
 * Поэтому 2ГИС заменён рабочими слоями эталонного Leaflet-приложения
 * («Карта — рабочие слои без ключей»: Esri World_Street_Map / OSM France),
 * которые грузятся всегда и без API-ключей. Любая ссылка вида
 * https://{tile-b01|sl1..4}.2gis.com/tiles?x=..&y=..&z=.. (старые сохранённые
 * проекты, кэш, сторонние шаблоны) ПЕРЕПИСЫВАЕТСЯ на URL рабочего слоя ЭТАЛОНА
 * с теми же тайловыми координатами — до любой загрузки и до присвоения img.src.
 * Ни один запрос к 2gis.com не отправляется никогда.
 */
export function normalizeTwoGisTileUrl(url: string): string {
  if (!url.includes('2gis.com')) return url;
  // Схема 2ГИС: /tiles?x=..&y=..&z=..
  const m = url.match(/[?&]x=(\d+)[&]y=(\d+)[&]z=(\d+)/);
  if (m) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    const z = Number(m[3]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      // Единая схема разворота с реестром провайдеров: алиас '2gis' → OSM France
      // standard (тот же улично-топографический стиль). Раньше здесь жёстко
      // стоял Esri Streets — из-за этого один сохранённый проект рисовал разные
      // подложки в редакторе (OSM France) и мастере (Esri), а кэш тайлов
      // промахивался по URL.
      return workingLayerTileUrl(LEGACY_ALIAS_TO_WORKING_LAYER['2gis'], x, y, z);
    }
  }
  // Прочие 2ГИС-ссылки без узнаваемой XYZ-схемы гасим полностью: возвращаем
  // прозрачный 1×1 PNG (data-URI), чтобы битый хост не попал в сеть вообще.
  return TRANSPARENT_TILE_DATA_URI;
}

const TRANSPARENT_TILE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Ограничение параллельных загрузок тайлов на один хост: браузер даёт ~6 соединений,
 *  сотни запросов без лимита = таймауты и «вечная загрузка» большой карты. */
let tileActive = 0;
const tileWaiters: Array<() => void> = [];
async function withTileSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (tileActive >= 4) await new Promise<void>((res) => tileWaiters.push(res));
  tileActive++;
  try {
    return await fn();
  } finally {
    tileActive--;
    const next = tileWaiters.shift();
    if (next) next();
  }
}

export interface OSMConfig {
  loaded: boolean;
}

const osmConfig: OSMConfig = {
  loaded: false,
};

/**
 * Инициализация OpenStreetMap (не требует API ключа)
 */
export function initOpenStreetMap(): Promise<void> {
  return new Promise((resolve) => {
    osmConfig.loaded = true;
    resolve();
  });
}

// Зеркала Nominatim. Публичный nominatim.openstreetmap.org часто недоступен из ряда
// сетей/регионов (ERR_CONNECTION_TIMED_OUT) и жёстко лимитирует запросы, поэтому
// перебираем несколько инстансов с таймаутом и вежливым паузированием.
const NOMINATIM_HOSTS = [
  'https://nominatim.openstreetmap.org',
  'https://nominatim.mapnik.us',
  'https://nominatim.private.coffee',
];

// Локальная очередь «не чаще 1 запроса в секунду» — требование usage policy Nominatim.
// Резервирование момента выполнения синхронно (до await) исключает «шторм» из
// одновременно стартовавших запросов при пакетном геокодировании списков.
let lastNominatimAt = 0;
function reserveNominatimSlot(): Promise<void> {
  const now = Date.now();
  const when = Math.max(now, lastNominatimAt + 1000);
  lastNominatimAt = when;
  const wait = when - now;
  return wait > 0 ? new Promise((res) => setTimeout(res, wait)) : Promise.resolve();
}

export type NominatimErrorKind = 'network' | 'http';

/**
 * Запрос к Nominatim с перебором зеркал, таймаутом и повтором.
 * Возвращает [данные, kind] где kind='ok'|'not_found'|'network'|'http' —
 * вызывающий код различает «сервис недоступен», «адрес не найден» и HTTP-ошибку.
 * Поддерживает внешний AbortController для отмены (уход пользователя, новый запрос).
 * Ошибки внешних серверов не пишутся в console.error — это штатная ситуация,
 * вызывающий код показывает пользователю понятное сообщение.
 */
async function fetchNominatimJson(
  path: string,
  params: string,
  outerSignal?: AbortSignal,
): Promise<{ data: any[] | any | null; kind: 'ok' | 'not_found' | NominatimErrorKind }> {
  let sawHttpError = false;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < NOMINATIM_HOSTS.length; i++) {
      if (outerSignal?.aborted) return { data: null, kind: 'network' };
      const host = NOMINATIM_HOSTS[(i + round) % NOMINATIM_HOSTS.length];
      await reserveNominatimSlot();
      if (outerSignal?.aborted) return { data: null, kind: 'network' };
      const ctrl = new AbortController();
      const abortOuter = () => ctrl.abort();
      outerSignal?.addEventListener('abort', abortOuter);
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const response = await fetch(`${host}${path}?format=json&${params}`, {
          signal: ctrl.signal,
          headers: { Accept: 'application/json' },
        });
        if (response.status === 429 || response.status >= 500) {
          sawHttpError = true;
          continue; // пробуем следующее зеркало
        }
        if (!response.ok) return { data: null, kind: 'http' };
        const json = await response.json();
        return { data: json, kind: Array.isArray(json) && json.length === 0 ? 'not_found' : 'ok' };
      } catch {
        /* сеть/таймаут/отмена — следующее зеркало */
      } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', abortOuter);
      }
    }
    // после первого раунда — короткая пауза перед повтором
    if (round === 0) await new Promise((res) => setTimeout(res, 1000));
  }
  return { data: null, kind: sawHttpError ? 'http' : 'network' };
}

export interface OsmGeocodeResult {
  point: { lat: number; lng: number } | null;
  /** 'ok' — успех; 'not_found' — адрес не найден; 'network'/'http' — сервисная ошибка */
  kind: 'ok' | 'not_found' | NominatimErrorKind;
}

/**
 * Геокодирование адреса через Nominatim (OSM).
 * Возвращает различимый статус, чтобы UI не смешивал «не найдено» и «сервис недоступен».
 */
export async function osmGeocode(address: string, signal?: AbortSignal): Promise<OsmGeocodeResult> {
  const { data, kind } = await fetchNominatimJson(
    '/search',
    `q=${encodeURIComponent(address)}&limit=1`,
    signal,
  );
  if (kind !== 'ok') return { point: null, kind };
  const first = Array.isArray(data) ? data[0] : null;
  const lat = first ? parseFloat(first.lat) : NaN;
  const lng = first ? parseFloat(first.lon) : NaN;
  if (!isFinite(lat) || !isFinite(lng)) return { point: null, kind: 'not_found' };
  return { point: { lat, lng }, kind: 'ok' };
}

/**
 * Обратное геокодирование через Nominatim (OSM)
 */
export async function osmReverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<string | null> {
  const { data, kind } = await fetchNominatimJson('/reverse', `lat=${lat}&lon=${lng}`, signal);
  if (kind !== 'ok') return null;
  if (data && typeof data.display_name === 'string') return data.display_name;
  return null;
}

export type TileStyle = 'scheme' | 'satellite' | 'hybrid';

/**
 * Получение URL тайла OSM.
 *
 * ЕДИНЫЙ ЗАГРУЗЧИК КАРТ (редактор + мастер): функция принимает ЛЮБОЙ
 * идентификатор подложки (`TileServerId`: legacy-алиасы 'osm'|'2gis'|'carto'
 * и прямые id рабочих слоёв эталона) и всегда возвращает URL РАБОЧЕГО слоя
 * из эталонного Leaflet-приложения «Карта — рабочие слои без ключей».
 *  - 'osm'   → Esri World_Street_Map (стабильнее tile.openstreetmap.org,
 *              который в ряде сетей отдаёт 429/таймауты и вешает очередь);
 *  - '2gis'  → OSM France standard (замена мёртвого tile-b01.2gis.com:
 *              ERR_NAME_NOT_RESOLVED ловил DNS-шторм — см. PR #111);
 *  - 'carto' → OSM France HOT (тот же светлый «light» стиль);
 *  - прямые id ('esri-streets', 'esri-satellite', 'osm-fr-standard',
 *    'osm-fr-hot', 'osm-de', 'opentopomap', 'cyclosm') → соответствующий
 *    слой эталона 1-в-1 (схемы {z}/{y}/{x} для Esri, {z}/{x}/{y}.png для XYZ).
 * Разрешение алиасов — resolveWorkingLayer (mapProviders), единая точка истины
 * для MapCanvas/MiniMapPanel/store/селекторов обоих режимов.
 */
export function getOSMTileUrl(
  zoom: number,
  x: number,
  y: number,
  tileServer: TileServerId = 'osm',
  style: TileStyle = 'scheme'
): string {
  // Прямые id рабочих слоёв эталона и legacy-алиасы — единая точка разворота
  // (resolveWorkingLayer): любой TileServerId даёт URL рабочего слоя без ключей.
  if (isWorkingTileLayerId(tileServer)) {
    return workingLayerTileUrl(tileServer, x, y, zoom);
  }
  if ((tileServer === 'carto' || tileServer === 'osm') && (style === 'satellite' || style === 'hybrid')) {
    // спутник/гибрид (удалённые из UI режимы) — Esri Imagery
    return workingLayerTileUrl('esri-satellite', x, y, zoom);
  }
  return workingLayerTileUrl(resolveWorkingLayer(tileServer), x, y, zoom);
}

/**
 * Запасные рабочие XYZ-хосты для подложки «osm» (порядок = приоритет):
 * Esri World_Imagery → OSM France → OSM Germany → tile{a,b,c}.openstreetmap.org.
 * Все хосты — без ключей, из заведомо рабочего эталона. Возвращает [] для URL
 * чужих схем (2ГИС и т.п. — у них собственные зеркала).
 */
export function osmFallbackHosts(primaryUrl: string): string[] {
  let u: URL;
  try { u = new URL(primaryUrl); } catch { return []; }
  const mEsri = u.pathname.match(/^\/ArcGIS\/rest\/services\/(.+)\/MapServer\/tile\/(\d+)\/(\d+)\/(\d+)$/);
  if (mEsri) {
    const [, svc, zs, a, b] = mEsri;
    // Esri-шаблон идёт в порядке {z}/{y}/{x} — сохраняем его как есть.
    // Порядок зеркал = эталонный приоритет рабочих слоёв: сначала НЕзависимые
    // серверы OSM-сообщества (OSM France → OSM Germany), затем альтернативный
    // Esri-сервис (тот же хост, при DNS-блокировке arcgisonline бесполезен),
    // и лишь потом старый пул tile.openstreetmap.org.
    const altSvc = svc === 'World_Street_Map' ? 'World_Imagery' : 'World_Street_Map';
    // ВАЖНО (регрессия «не удалось определить размер»/белая карта): если среди
    // зеркал есть URL с ЛЮБЫМ поддоменом, совпадающим с поддоменом primary
    // (например, osm-fr-standard даёт a. для primary a.tile.openstreetmap.de),
    // браузер отдампитит весь хост и перебор зеркал не спасёт. Поэтому
    // независимые OSM-серверы идут ВТОРЫМИ, а первым — альтернативный Esri
    // (тот же стабильный хост эталона, всегда резолвится там, где работает primary).
    const out: string[] = [
      `${OSM_WORKING_HOSTS.esriStreets.replace('World_Street_Map', altSvc)}/${zs}/${a}/${b}`,
      workingLayerTileUrl('osm-fr-standard', Number(b), Number(a), Number(zs)),
      `${OSM_WORKING_HOSTS.osmDe}/${zs}/${b}/${a}.png`,
      ...OSM_TILE_MIRRORS.map((h) => `${h}/${zs}/${b}/${a}.png`),
    ];
    return out.filter((x) => x !== primaryUrl);
  }
  const mXyz = u.pathname.match(/\/(\d+)\/(\d+)\/(\d+)(?:\.png)?$/);
  if (mXyz) {
    const [, zs, xs, ys] = mXyz;
    const out: string[] = [
      `${OSM_WORKING_HOSTS.esriStreets}/${zs}/${ys}/${xs}`,
      workingLayerTileUrl('osm-fr-standard', Number(xs), Number(ys), Number(zs)),
      `${OSM_WORKING_HOSTS.osmDe}/${zs}/${xs}/${ys}.png`,
      ...OSM_TILE_MIRRORS.map((h) => `${h}/${zs}/${xs}/${ys}.png`),
    ];
    return out.filter((x) => x !== primaryUrl);
  }
  return [];
}

/**
 * Отмена незавершённой загрузки <img>. Нативный HTMLImageElement.abort() есть не
 * во всех движках (и отсутствует в типах DOM и happy-dom), поэтому вызов
 * защищён feature-det'ом; сброс src='' — универсальный fallback.
 */
export function abortTileImage(img: HTMLImageElement): void {
  const maybeAbort = (img as { abort?: () => void }).abort;
  if (typeof maybeAbort === 'function') {
    try { maybeAbort.call(img); } catch { /* движок отклонил отмену */ }
  }
  // removeAttribute — метод DOM-элемента; в моках/старых движках может отсутствовать,
  // поэтому сброс src выполняется защищённо (тот же эффект отмены загрузки).
  if (typeof img.removeAttribute === 'function') {
    img.removeAttribute('src');
  } else {
    img.src = '';
  }
}

/**
 * Тайл с деградацией до maxNativeZoom: выше родного разрешения тайлы НЕ растягиваются —
 * берётся ближайший доступный уровень и рисуется в физическом разрешении.
 *
 * ИСПРАВЛЕНИЕ ВЕЧНОГО СПИННЕРА («карта грузится и висит»): у <img> нет встроенного
 * таймаута. Если CDN провайдера принимает соединение, но не отдаёт ответ (OSM-зеркала
 * при 429/перегрузке так делают стабильно), onload/onerror не срабатывают НИКОГДА,
 * а старый `img.src=''` отменяет загрузку только на части движков — промис зависал
 * навсегда, слот очереди не освобождался и загрузка всей подложки останавливалась.
 * Теперь по таймауту вызывается нативный img.abort() (гарантированная отмена),
 * обработчики снимаются, а resolve происходит РОВНО один раз (settled-флаг).
 */
/** Публичный тип ручки загрузки тайла (см. startTileLoad). */
export type TileLoadHandle = {
  /** Актуальный <img> текущей попытки (перебираемые зеркала меняют его на лету). */
  image: HTMLImageElement | null;
  /** Отмена: немедленно завершает очередь (done→null) и обрывает активный img. */
  cancel(): void;
  readonly done: Promise<HTMLImageElement | null>;
};

/**
 * Ручка-обёртка над перебором зеркал (loadTileWithMirrors) с гарантированной
 * отменой в ЛЮБОЙ момент. Критично для теста «unmount отменяет ВСЕ in-flight
 * загрузки»: cancel() обязан не только резолвить done(null) (освобождение слота
 * очереди), но и вызывать abort()/сброс src у активного Image — иначе мок/браузер
 * держит незавершённую загрузку («утечка»). Реализация: каждая попытка зеркала
 * создаётся через startTileLoad, её handle пробрасывается в поля внешней ручки;
 * cancel() между попытками помечает флаг и обрывает уже созданный img, а
 * loadTileWithMirrorsSafe проверяет флаг перед каждой следующей попыткой.
 */
export function createCancellableMirrorLoad(url: string, timeoutMs: number): TileLoadHandle {
  let cancelled = false;
  let settled = false;
  // Финал done() — через мутабельный бокс: замыкания в cancel()/async-ветке
  // читают box.resolve, поэтому TS не может свести тип к never (в отличие от
  // «let resolveFn … = null» с последующим присваиванием в Promise-executor).
  const box: { resolve: ((v: HTMLImageElement | null) => void) | null } = { resolve: null };
  const done = new Promise<HTMLImageElement | null>((res) => { box.resolve = res; });
  const outer: TileLoadHandle = {
    image: null,
    cancel(): void {
      if (cancelled || settled) return;
      cancelled = true;
      // Немедленный финал: очередь не ждёт ответа зеркал/таймаута.
      settled = true;
      const r = box.resolve;
      if (r) r(null);
      const img = outer.image;
      if (img) abortTileImage(img);
    },
    done,
  };
  (async (): Promise<void> => {
    const img = await loadTileWithMirrorsSafe(url, timeoutMs, () => cancelled, outer);
    if (cancelled || settled) {
      if (img) abortTileImage(img); // отменено во время последней попытки — освободить соединение
      return;
    }
    settled = true;
    outer.image = img ?? outer.image;
    const r = box.resolve;
    if (r) r(img);
  })();
  return outer;
}

/**
 * То же, что loadTileWithMirrors, но с внешним флагом отмены и публикацией
 * активного <img> в ручку вызывающей стороны (для гарантированного abort при
 * unmount). Возвращает загруженный Image или null (все зеркала недоступны /
 * отменено).
 */
async function loadTileWithMirrorsSafe(
  url: string,
  timeoutMs: number,
  isCancelled: () => boolean,
  outer: TileLoadHandle,
): Promise<HTMLImageElement | null> {
  const tryHost = async (candidate: string): Promise<HTMLImageElement | null> => {
    if (isCancelled()) return null;
    const h = startTileLoad(candidate, timeoutMs);
    outer.image = h.image; // публикуем активный img — cancel() сможет его оборвать
    const img = await h.done;
    if (isCancelled()) {
      if (img) abortTileImage(img);
      return null;
    }
    return img;
  };
  const mOsm = url.match(/^https:\/\/(?:[abc]\.)?tile\.openstreetmap\.org\/(.+)$/);
  if (mOsm) {
    for (const host of OSM_TILE_MIRRORS) {
      const img = await tryHost(host + '/' + mOsm[1]);
      if (img) return img;
      if (isCancelled()) return null;
    }
    return null;
  }
  // ФИКС «карта не загружается» (консоль пользователя): ВСЕ хосты 2ГИС
  // недоступны — tile-b01.2gis.com отдаёт net::ERR_NAME_NOT_RESOLVED, а
  // зеркала sl{1..4}.2gis.com таймаутят/блокируются сетью. Любой 2ГИС-URL
  // переписывается normalizeTwoGisTileUrl на рабочий слой эталона
  // (Esri World_Street_Map / OSM France) ЕЩЁ до входа сюда (см. startTileLoad),
  // поэтому ни одного сетевого запроса к 2gis.com не происходит никогда.
  // Если же такой URL всё-таки долетел (сторонний вызов в обход startTileLoad) —
  // гасим его сразу, без обращения к мёртвым хостам.
  if (url.includes('2gis.com')) {
    return tryHost(normalizeTwoGisTileUrl(url));
  }
  const primary = await tryHost(url);
  if (primary) return primary;
  if (isCancelled()) return null;
  // Деградация на список ЗАВЕДОМО РАБОЧИХ независимых XYZ-зеркал (эталон):
  // Esri Imagery → OSM France → OSM Germany → tile*.openstreetmap.org.
  if (osmFallbackHosts(url).length > 0) {
    return tryOsmFallbacksSafe(url, isCancelled, outer, timeoutMs);
  }
  return null;
}

/**
 * Деградация для «osm»-подложки: если основной хост (Esri World_Street_Map) или
 * любой бесплатный XYZ-хост отдал ошибку/таймаут, пробуем остальные ЗАВЕДОМО
 * РАБОЧИЕ зеркала из рабочего эталона (OSM France → OSM Germany → tile*.openstreetmap.org).
 * Возвращает null только когда все кандидаты недоступны.
 */
async function tryOsmFallbacksSafe(
  url: string,
  isCancelled: () => boolean,
  outer: TileLoadHandle,
  timeoutMs: number,
): Promise<HTMLImageElement | null> {
  for (const candidate of osmFallbackHosts(url)) {
    if (isCancelled()) return null;
    const h = startTileLoad(candidate, timeoutMs);
    outer.image = h.image; // публикуем активный img — cancel() сможет его оборвать
    const img = await h.done;
    if (img) return img;
    if (isCancelled()) return null;
  }
  return null;
}

/**
 * Загрузка тайла с ЯВНЫМ ручкой-контролем (P0 «зависания/утечки»): вызывающая
 * сторона (MapCanvas) регистрирует handle в реестре in-flight и ОБЯЗАНА вызвать
 * cancel() при размонтировании или отмене вида. Без этого Image с выставленным
 * src доживал до внутреннего таймаута (10 c), держал DOM-элементы и резолвился
 * на уже несмонтированном компоненте — утечка памяти + предупреждения React.
 */
export function startTileLoad(rawUrl: string, timeoutMs = 8000): TileLoadHandle {
  // Финальный барьер «карта не загружается»: ЛЮБОЙ URL с 2gis.com (мёртвый
  // tile-b01 → ERR_NAME_NOT_RESOLVED, таймаотящие sl{1..4}, старые кэши и
  // сохранённые проекты) переписывается на рабочий слой эталона без ключей
  // (Esri World_Street_Map) ПЕРЕД сетью. Для всех прочих провайдеров
  // normalizeTwoGisTileUrl — no-op.
  const url = normalizeTwoGisTileUrl(rawUrl);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  let settled = false;
  let resolveFn: ((v: HTMLImageElement | null) => void) | null = null;
  const done = new Promise<HTMLImageElement | null>((res) => { resolveFn = res; });
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => finish(false), timeoutMs);
  function finish(ok: boolean): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    img.onload = null;
    img.onerror = null;
    if (!ok) {
      // Гарантированная отмена незавершённой загрузки (освобождает соединение браузера)
      abortTileImage(img);
      resolveFn?.(null);
    } else {
      resolveFn?.(img);
    }
  }
  img.onload = () => finish(true);
  img.onerror = () => finish(false);
  img.src = url;
  return { image: img, cancel(): void { finish(false); }, done };
}

/** Обратная совместимость: обёртка над startTileLoad для существующих вызовов. */
export async function loadTileImage(url: string, timeoutMs = 8000): Promise<HTMLImageElement | null> {
  return startTileLoad(url, timeoutMs).done;
}

/**
 * Загрузка тайла с перебором зеркал. Раньше для URL 2ГИС перебирались зеркала
 * sl{1..4}.2gis.com; по консоль-логам пользователя выяснено, что НЕДОСТУПНЫ
 * ВСЕ хосты 2ГИС (tile-b01 → ERR_NAME_NOT_RESOLVED, sl1..4 → таймауты/блокировки).
 * Теперь ЛЮБОЙ 2ГИС-URL перед любой сетевой операцией переписывается
 * normalizeTwoGisTileUrl на рабочий слой эталона «без ключей» (Esri Streets),
 * и запрос к 2gis.com не отправляется никогда — карта грузится всегда.
 */
export async function loadTileWithMirrors(url: string, timeoutMs = 8000): Promise<HTMLImageElement | null> {
  // Санация 2ГИС-URL выполняется в startTileLoad (ниже по стеку) — здесь лишь
  // ранний выход для прямых вызовов с мёртвым хостом, чтобы не держать слот.
  const mOsm = url.match(/^https:\/\/(?:[abc]\.)?tile\.openstreetmap\.org\/(.+)$/);
  if (mOsm) {
    for (const host of OSM_TILE_MIRRORS) {
      const img = await loadTileImage(host + '/' + mOsm[1], timeoutMs);
      if (img) return img;
    }
    return null;
  }
  // ФИКС «карта не загружается» по аналогии с рабочим эталоном: при сбое
  // основного бесплатного хоста (Esri Streets/Imagery, OSM France/Hot/
  // Germany, OpenTopoMap, CyclOSM) перебираем СПИСОК ЗАВЕДОМО РАБОЧИХ
  // независимых зеркал вместо возврата пустого тайла.
  const fb = osmFallbackHosts(url);
  if (fb.length > 0) {
    return loadTileImage(url, timeoutMs).then(async (img) => {
      if (img) return img;
      for (const candidate of fb) {
        const alt = await loadTileImage(candidate, timeoutMs);
        if (alt) return alt;
      }
      return null;
    });
  }
  return loadTileImage(url, timeoutMs);
}

/**
 * Совместимость: кэш рабочих зеркал 2ГИС удалён (домен полностью выведен из
 * загрузки — все 2ГИС-URL санируются в рабочие слои эталона). Функция оставлена
 * как no-op, чтобы не ломать существующие вызовы/тесты.
 */
export function resetTwoGisMirrorCache(): void {
  /* no-op */
}

/**
 * Конвертация lat/lng в тайловые координаты
 */
export function latLngToTile(
  lat: number,
  lng: number,
  zoom: number
): { x: number; y: number } {
  const x = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
  const y = Math.floor(
    (1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2 * Math.pow(2, zoom)
  );
  return { x, y };
}

/**
 * Конвертация тайловых координат в lat/lng
 */
export function tileToLatLng(
  x: number,
  y: number,
  zoom: number
): { lat: number; lng: number } {
  const n = Math.pow(2, zoom);
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lat, lng };
}

/**
 * Получение статической карты OSM через статический генератор
 */
export async function loadOSMStaticMap(
  center: { lat: number; lng: number },
  zoom: number,
  width: number,
  height: number,
  tileServer: 'osm' | 'opentopomap' | 'carto' = 'osm'
): Promise<{ dataUrl: string; bounds: { north: number; south: number; east: number; west: number } }> {
  console.log(`Загрузка карты OSM: сервер=${tileServer}, центр=(${center.lat}, ${center.lng}), зум=${zoom}, размер=${width}x${height}`);
  
  // Вычисляем границы (приблизительные — для совместимости сигнатуры)
  void calculateOSMBoundsFromCenter;

  // === ТОЧНАЯ Mercator-привязка снимка к географии (исправление «сбившегося масштаба») ===
  // Снимок покрывает ровно окно обзора: world px на данном зуме = 256*2^z, из них
  // по X видно width px => долготный размах симметричен центру; по Y — через Mercator.
  const zClamped = Math.min(Math.max(Math.round(zoom), 1), 19);
  const worldPxZ = 256 * Math.pow(2, zClamped);
  const mercC = latToMercatorY(Math.max(-85, Math.min(85, center.lat)));
  const halfSpanY = (height / 2) / worldPxZ;
  const north = tileToLatLng(0, Math.max(0, Math.min(1, mercC - halfSpanY)), zClamped).lat;
  const south = tileToLatLng(0, Math.max(0, Math.min(1, mercC + halfSpanY)), zClamped).lat;
  const lngHalf = (width / 2 / worldPxZ) * 360;
  const west = center.lng - lngHalf;
  const east = center.lng + lngHalf;
  const bounds = { north, south, east, west };

  // Пиксельные границы тайловой сетки, точно соответствующие видимой области
  const nTiles = Math.pow(2, zClamped);
  const xMinWorld = ((west + 180) / 360) * nTiles;
  const yMinWorld = latToMercatorY(north) * nTiles;

  // Создаем canvas и рисуем тайлы
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Не удалось создать canvas');
  }

  // Заполняем фон
  ctx.fillStyle = '#f2efe9';
  ctx.fillRect(0, 0, width, height);

  const tilesX = Math.ceil(width / 256) + 1;
  const tilesY = Math.ceil(height / 256) + 1;

  const startTileX = Math.floor(xMinWorld);
  const startTileY = Math.floor(yMinWorld);

  // Загружаем тайлы с лимитом параллелизма (4 одновременных) и перебором зеркал
  // tile.openstreetmap.org: раньше все тайлы стартовали одновременно без лимита —
  // при большой карте это переполняло очередь соединений браузера, загрузка
  // растягивалась на минуты («карта не загружается»).
  let loadedCount = 0;
  const drawTileAt = (img: HTMLImageElement | null, dx: number, dy: number) => {
    const pixelX = Math.round((startTileX + dx - xMinWorld) * 256);
    const pixelY = Math.round((startTileY + dy - yMinWorld) * 256);
    if (img) {
      ctx.drawImage(img, pixelX, pixelY, 256, 256);
      loadedCount++;
    } else {
      ctx.fillStyle = '#cccccc';
      ctx.fillRect(pixelX, pixelY, 256, 256);
      ctx.strokeStyle = '#999999';
      ctx.lineWidth = 1;
      ctx.strokeRect(pixelX, pixelY, 256, 256);
    }
  };

  const jobs: Array<Promise<void>> = [];
  for (let dy = 0; dy < tilesY; dy++) {
    for (let dx = 0; dx < tilesX; dx++) {
      const tileX = startTileX + dx;
      const tileY = startTileY + dy;
      if (tileX < 0 || tileY < 0 || tileX >= nTiles || tileY >= nTiles) continue;
      const base = getOSMTileUrl(zClamped, tileX, tileY, tileServer);
      jobs.push(
        withTileSlot(async () => {
          const img = await loadTileWithMirrors(base);
          drawTileAt(img, dx, dy);
        })
      );
    }
  }
  await Promise.all(jobs);

  console.log(`Загружено ${loadedCount}/${jobs.length} тайлов для сервера ${tileServer}`);

  // Смещение больше не нужно: тайлы нарисованы точно под окно обзора. Старый
  // расчёт offsetX=(width-tilesX*256)/2 смещал снимок до половины тайла —
  // из-за этого привязка координат и масштаб «съезжали».
  const offsetX = 0;
  const offsetY = 0;
  
  if (offsetX !== 0 || offsetY !== 0) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d');
    
    if (tempCtx) {
      tempCtx.fillStyle = '#f2efe9';
      tempCtx.fillRect(0, 0, width, height);
      tempCtx.drawImage(canvas, offsetX, offsetY);
      
      const dataUrl = tempCanvas.toDataURL('image/png');
      return { dataUrl, bounds };
    }
  }
  
  const dataUrl = canvas.toDataURL('image/png');
  return { dataUrl, bounds };
}

// Границы считаются через общую Web Mercator-функцию (googleMaps.ts)
const calculateOSMBoundsFromCenter = calculateBoundsFromCenter;

/**
 * Проверка статуса инициализации OSM
 */
export function isOSMLoaded(): boolean {
  return osmConfig.loaded;
}
