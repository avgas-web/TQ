// Определение высоты ландшафта через Open-Elevation (https://open-elevation.com).
// Используется для:
//  • проставления высоты точек маршрута/маркеров по рельефу;
//  • расчёта АГЛ (высоты полёта над землёй) на сегментах маршрута;
//  • автоматической коррекции маршрута, если он проходит сквозь высотные
//    ограничения (минимальная/максимальная высота полёта) — точки поднимаются
//    или опускаются так, чтобы лимиты НЕ стояли на пути маршрута.
import { haversineDistanceM } from './actionMode';

const OPEN_ELEVATION_URL = 'https://api.open-elevation.com/api/v1/lookup';

export interface ElevationPoint {
  lat: number;
  lng: number;
}

/** Кэш высот: "lat,lng" (округление до ~1 м) -> elevation (м). Открытый API
 *  Open-Elevation медленный и rate-limit-ится — повторные запросы тех же точек
 *  не должны идти в сеть. */
const elevCache = new Map<string, number>();

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

/** Сгруппировать одинаковые координаты (с точностью ~1 м), сохранив порядок */
function dedupe(points: ElevationPoint[]): ElevationPoint[] {
  const seen = new Set<string>();
  const out: ElevationPoint[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const k = cacheKey(p.lat, p.lng);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** Сброс кэша высот. Используется тестами для изоляции: module-level кэш
 *  живёт всю жизнь воркера, и без очистки мок-fetch из одного теста мог
 *  «прижить» значение для координат другого теста. */
export function __resetElevationCacheForTests(): void {
  elevCache.clear();
}

/** Запрос батча высот к Open-Elevation. Батчи разбиваются по ≤100 точек
 *  (защита от слишком больших URL/таймаутов), выполняются последовательно
 *  (публичный API бесплатно троттлит частые запросы). */
interface RawElevationResult {
  latitude?: unknown;
  longitude?: unknown;
  elevation?: unknown;
}
interface ElevationResponseShape {
  results?: unknown;
}

/** Таймаут одного запроса к публичному API: без него зависшее соединение
 *  (open-elevation медленно отвечает под нагрузкой) вешает весь прогон
 *  пересчёта высот — «кнопка Пересчитать не работает». */
const REQUEST_TIMEOUT_MS = 25_000;

/** Разобрать ответ API для чанка: сопоставление по координатам (API обычно
 *  сохраняет порядок, но надёжнее keyed-сопоставление), null для отсутствующих. */
function readChunkResults(
  json: ElevationResponseShape,
  chunk: ElevationPoint[],
  results: (number | null)[],
  off: number,
): (number | null)[] {
  const list: RawElevationResult[] = Array.isArray(json?.results) ? (json.results as RawElevationResult[]) : [];
  const isValidElev = (r: RawElevationResult | undefined): r is RawElevationResult & { elevation: number } =>
    !!r && typeof r.elevation === 'number' && Number.isFinite(r.elevation);
  // Сопоставление по координатам (API обычно сохраняет порядок, но надёжнее
  // keyed-сопоставление). Если ответ не содержит latitude/longitude (упрощённые
  // мок-ответы или нестандартные прокси) — откат на позиционное сопоставление:
  // API гарантирует тот же порядок locations, что и в запросе.
  const byKey = new Map<string, number>();
  let anyCoordMatched = false;
  for (const r of list) {
    if (isValidElev(r) && typeof r.latitude === 'number' && typeof r.longitude === 'number') {
      byKey.set(cacheKey(r.latitude, r.longitude), r.elevation);
    }
  }
  chunk.forEach((p, i) => {
    const v = byKey.get(cacheKey(p.lat, p.lng));
    if (v !== undefined) { results[off + i] = v; anyCoordMatched = true; }
    else if (byKey.size === 0) {
      // ни одна запись не имеет координат → используем порядок ответа
      results[off + i] = isValidElev(list[i]) ? list[i].elevation : null;
    } else results[off + i] = null;
  });
  void anyCoordMatched;
  return results;
}

export async function fetchElevationsBatch(points: ElevationPoint[], signal?: AbortSignal): Promise<(number | null)[]> {
  const results: (number | null)[] = new Array(points.length).fill(null);
  const CHUNK = 100;
  for (let off = 0; off < points.length; off += CHUNK) {
    const chunk = points.slice(off, off + CHUNK);
    // Собственный сигнал с таймаутом, наследующий отмену внешнего.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    const onOuterAbort = (): void => timeout.abort();
    signal?.addEventListener('abort', onOuterAbort);
    try {
      const resp = await fetch(OPEN_ELEVATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: chunk.map((p) => ({ latitude: p.lat, longitude: p.lng })) }),
        signal: timeout.signal,
      });
      // 429 Too Many Requests (публичный Open-Elevation троттлит частые
      // обращения): одна вежливая повторная попытка с backoff по Retry-After
      // (или 3 с). Если снова 429 — НЕ роняем приложение: мягкая деградация
      // ниже (null-высоты + warning в routeWarnings у вызывающего кода).
      if (resp.status === 429 && !timeout.signal.aborted) {
        const raHeader = Number(resp.headers?.get?.('Retry-After'));
        const delayMs = Number.isFinite(raHeader) && raHeader > 0 ? Math.min(raHeader * 1000, 10_000) : 3_000;
        await new Promise<void>((res) => {
          const t = setTimeout(res, delayMs);
          const stop = (): void => { clearTimeout(t); res(); };
          timeout.signal.addEventListener('abort', stop, { once: true });
        });
        if (!timeout.signal.aborted) {
          const retry = await fetch(OPEN_ELEVATION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locations: chunk.map((p) => ({ latitude: p.lat, longitude: p.lng })) }),
            signal: timeout.signal,
          });
          if (retry.ok) {
            const json = (await retry.json()) as ElevationResponseShape;
            // Аудит 1.1: НЕ возвращаем результат досрочно — readChunkResults
            // мутирует results по ссылке; цикл обязан пройти ВСЕ чанки
            // (маршруты >100 точек раньше обрывались на первом батче).
            readChunkResults(json, chunk, results, off);
            continue; // повтор успешен — читаем исходный 429-ответ нельзя
          }
        }
      }
      if (!resp.ok) throw new Error(`Open-Elevation HTTP ${resp.status}`);
      const json = (await resp.json()) as ElevationResponseShape;
      // Аудит 1.1: без return внутри цикла for — иначе хвост маршрутов
      // длиннее 100 точек оставался без высот (null).
      readChunkResults(json, chunk, results, off);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' && signal?.aborted) throw err; // явная отмена прогона — не глотаем
      console.warn('[elevation] запрос батча не выполнен:', (err as Error)?.message);
      // остальные чанки помечаем null — вызывающий код деградирует мягко
      for (let i = off; i < Math.min(off + CHUNK, points.length); i++) results[i] = null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
  return results;
}

/**
 * Массив высот ландшафта (м, WGS-84/EGM96) для точек. Гарантирует тот же
 * порядок и длину, что и вход: недоступные точки — null. Кэшируется.
 */
export async function fetchElevations(points: ElevationPoint[], signal?: AbortSignal): Promise<(number | null)[]> {
  const out: (number | null)[] = new Array(points.length).fill(null);
  const uniq = dedupe(points);
  const missing = uniq.filter((p) => !elevCache.has(cacheKey(p.lat, p.lng)));
  const fetched = missing.length > 0 ? await fetchElevationsBatch(missing, signal) : [];
  missing.forEach((p, i) => {
    const v = fetched[i];
    if (typeof v === 'number') elevCache.set(cacheKey(p.lat, p.lng), v);
  });
  points.forEach((p, i) => {
    const v = elevCache.get(cacheKey(p.lat, p.lng));
    out[i] = v !== undefined ? v : null;
  });
  return out;
}

/** Высота одной точки (или null, если сервис недоступен) */
export async function fetchElevation(lat: number, lng: number, signal?: AbortSignal): Promise<number | null> {
  const r = await fetchElevations([{ lat, lng }], signal);
  return r[0];
}

/** Линейная интерполяция профиля высот вдоль ломаной с фиксированным шагом */
export function interpolateProfile(points: ElevationPoint[], stepMeters = 500, maxSamples = 200): ElevationPoint[] {
  if (points.length < 2) return points.slice();
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += haversineDistanceM(points[i], points[i + 1]);
  if (!Number.isFinite(total) || total <= 0) return points.slice();
  const n = Math.max(points.length, Math.min(maxSamples, Math.ceil(total / stepMeters) + 1));
  const segLens: number[] = [];
  for (let i = 0; i < points.length - 1; i++) segLens.push(haversineDistanceM(points[i], points[i + 1]));
  const out: ElevationPoint[] = [];
  for (let s = 0; s < n; s++) {
    const dTarget = (total * s) / (n - 1);
    let acc = 0, si = 0;
    while (si < segLens.length - 1 && acc + segLens[si] < dTarget) { acc += segLens[si]; si++; }
    const t = segLens[si] > 0 ? Math.min(1, Math.max(0, (dTarget - acc) / segLens[si])) : 0;
    const a = points[si], b = points[si + 1];
    out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
  }
  return out;
}

export interface RouteAltitudeInfo {
  /** Требуемая высота ABS (над уровнем моря, м) для каждого узла route.points */
  absM: (number | null)[];
  /** Максимальный AGL (над рельефом, м) вдоль маршрута при заданной высоте полёта */
  maxAglM: number | null;
  /** Минимальный AGL вдоль маршрута (главный показатель «не задевает ли рельеф») */
  minAglM: number | null;
  /** Есть ли участки, где маршрут ниже вершин рельефа (полёт сквозь холмы) */
  terrainConflict: boolean;
  /** Пиковая высота рельефа вдоль маршрута, м */
  maxTerrainM: number | null;
}

/**
 * Определить высоту полёта маршрута исходя из высоты ландшафта:
 * профиль рельефа запрашивается у Open-Elevation (с интерполяцией между
 * узлами), требуемая ABS-высота каждого узла = max(terrain+clearance, floorAbs).
 */
export async function computeRouteAltitude(
  geoPoints: ElevationPoint[],
  opts: { clearanceM?: number; floorAbsM?: number } = {},
  signal?: AbortSignal,
): Promise<RouteAltitudeInfo> {
  const clearance = Number.isFinite(opts.clearanceM as number) ? (opts.clearanceM as number) : 50;
  const empty: RouteAltitudeInfo = { absM: geoPoints.map(() => null), maxAglM: null, minAglM: null, terrainConflict: false, maxTerrainM: null };
  if (geoPoints.length < 2) return empty;

  const profile = interpolateProfile(geoPoints);
  const profElev = await fetchElevations(profile, signal);
  if (profElev.every((v) => v === null)) return empty; // сервис недоступен — мягкая деградация

  // Для каждого узла — рельеф на его позиции + максимум рельефа на соседних
  // сэмплах профиля (между узлами интерполяция высот линейна, поэтому пик
  // рельефа на сегменте лежит в одном из сэмплов профиля).
  const nodeIdx: number[] = [];
  {
    // узлы geoPoints соответствуют профилю: первый = 0, последний = profile.length-1,
    // промежуточные — ближайший сэмпл по накопленной дистанции
    let acc = 0;
    nodeIdx.push(0);
    const segTotals: number[] = [];
    for (let i = 0; i < geoPoints.length - 1; i++) {
      acc += haversineDistanceM(geoPoints[i], geoPoints[i + 1]);
      segTotals.push(acc);
    }
    const totalD = acc || 1;
    for (let i = 1; i < geoPoints.length - 1; i++) {
      const frac = segTotals[i - 1] / totalD;
      nodeIdx.push(Math.round(frac * (profile.length - 1)));
    }
    nodeIdx.push(profile.length - 1);
  }

  const absM: (number | null)[] = geoPoints.map(() => null);
  let maxTerrain: number | null = null;
  for (let i = 0; i < geoPoints.length; i++) {
    const lo = i === 0 ? 0 : nodeIdx[i - 1];
    const hi = i === geoPoints.length - 1 ? profile.length - 1 : nodeIdx[i + 1];
    let best: number | null = null;
    for (let s = lo; s <= hi; s++) {
      const e = profElev[s];
      if (e === null) continue;
      if (best === null || e > best) best = e;
    }
    // собственный сэмел узла обязателен, если доступен
    const own = profElev[nodeIdx[i]];
    const terr = best !== null ? best : own;
    if (terr === null) continue;
    let need = terr + clearance;
    if (Number.isFinite(opts.floorAbsM as number)) need = Math.max(need, opts.floorAbsM as number);
    absM[i] = Math.round(need * 10) / 10;
    if (maxTerrain === null || terr > maxTerrain) maxTerrain = terr;
  }

  // AGL вдоль всего профиля: abs на сэмпле = интерполяция absM между узлами
  let minAgl: number | null = null;
  let maxAgl: number | null = null;
  let conflict = false;
  if (absM.some((v) => v !== null)) {
    for (let s = 0; s < profile.length; s++) {
      const te = profElev[s];
      if (te === null) continue;
      // найти surrounding nodes
      let i = 0;
      while (i < nodeIdx.length - 1 && nodeIdx[i + 1] < s) i++;
      const a = absM[i], b = absM[Math.min(i + 1, absM.length - 1)];
      if (a === null && b === null) continue;
      let abs: number;
      if (a === null) abs = b as number;
      else if (b === null) abs = a;
      else {
        const na = nodeIdx[i], nb = nodeIdx[Math.min(i + 1, nodeIdx.length - 1)];
        const t = nb > na ? Math.min(1, Math.max(0, (s - na) / (nb - na))) : 0;
        abs = a + (b - a) * t;
      }
      const agl = abs - te;
      if (minAgl === null || agl < minAgl) minAgl = agl;
      if (maxAgl === null || agl > maxAgl) maxAgl = agl;
      if (agl < 0) conflict = true;
    }
  }

  return {
    absM,
    maxAglM: maxAgl === null ? null : Math.round(maxAgl * 10) / 10,
    minAglM: minAgl === null ? null : Math.round(minAgl * 10) / 10,
    terrainConflict: conflict,
    maxTerrainM: maxTerrain === null ? null : Math.round(maxTerrain),
  };
}

/**
 * Автокоррекция высотных ограничений: вернуть узлы маршрута с исправленными
 * altitudeAGL так, чтобы ни один сегмент не проходил сквозь минимум/максимум.
 *  • minHeightAGL: там, где AGL узла меньше минимума — поднимаем до минимума
 *    (по рельефу, если известна terrainM, иначе просто ставим минимум);
 *  • maxHeightAGL: там, где AGL больше максимума — опускаем до максимума.
 * Возвращает новый массив только если что-то изменилось (иначе — null).
 */
export function clampAltitudesToLimits(
  altitudes: (number | null)[],
  terrain: (number | null)[],
  limits: { minAGL?: number | null; maxAGL?: number | null },
): { changed: boolean; next: (number | null)[]; raised: number; lowered: number } {
  const minV = Number.isFinite(limits.minAGL as number) && (limits.minAGL as number) > 0 ? (limits.minAGL as number) : null;
  const maxV = Number.isFinite(limits.maxAGL as number) && (limits.maxAGL as number) > 0 ? (limits.maxAGL as number) : null;
  const next = altitudes.slice();
  let raised = 0, lowered = 0;
  for (let i = 0; i < next.length; i++) {
    const terr = terrain[i];
    if (minV !== null) {
      const cur = next[i];
      const agl = cur === null || cur === undefined ? null : (terr !== null && Number.isFinite(terr) ? cur - terr : cur);
      if (agl === null || agl < minV) {
        const targetAbs = terr !== null && Number.isFinite(terr) ? terr + minV : minV;
        next[i] = targetAbs;
        raised++;
        continue;
      }
    }
    if (maxV !== null) {
      const cur = next[i];
      if (cur !== null && cur !== undefined) {
        const agl = terr !== null && Number.isFinite(terr) ? cur - terr : cur;
        if (agl > maxV) {
          const targetAbs = terr !== null && Number.isFinite(terr) ? terr + maxV : maxV;
          next[i] = targetAbs;
          lowered++;
        }
      }
    }
  }
  const changed = raised + lowered > 0;
  return { changed, next, raised, lowered };
}

// Алиасы для регрессионных тестов аудита 1.1 (elevationBatches.test.ts)
export const __test_fetchElevationsBatch = fetchElevationsBatch;
export const __test_clearElevationCache = __resetElevationCacheForTests;
