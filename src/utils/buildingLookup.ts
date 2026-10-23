// ═══════════════════════════════════════════════════════════════
// buildingLookup — «умный поиск зданий по клику» (Overpass API).
// Полностью повторяет логику эталонного Leaflet-кода («Анализ рельефа
// и высоты зданий», раздел 3): тот же запрос way["building"](around:20,...),
// те же три эндпоинта с перебором (если один недоступен — пробуем
// следующий), тот же разбор height / building:height / building:levels
// (оценка ~3 м за этаж) и тот же текст попапа.
// ═══════════════════════════════════════════════════════════════

export interface BuildingInfo {
  /** Строка высоты: либо фактическая высота, либо оценка по этажам, либо «нет данных». */
  heightStr: string;
  levelsStr: string;
  typeStr: string;
}

export type BuildingResult =
  | { kind: 'found'; building: BuildingInfo }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

/** Список серверов (если один недоступен, пробуем следующий) — как в эталоне. */
export const OVERPASS_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

/** HTML попапа здания — 1:1 разметка эталонного кода (класс .building-popup). */
export function buildingPopupHtml(b: BuildingInfo): string {
  return `<div class="building-popup">` +
    `<div><b>Высота:</b> ${b.heightStr}</div>` +
    `<div><b>Этажей:</b> ${b.levelsStr}</div>` +
    `<div><b>Тип:</b> ${b.typeStr}</div>` +
    `</div>`;
}

interface OverpassElement {
  tags?: Record<string, string>;
}

/**
 * Поиск ближайшего здания в радиусе 20 м от точки клика.
 * Возвращает found / not-found / error — статусы соответствуют сообщениям
 * setStatus() из эталона.
 */
export async function findBuildingAt(
  lat: number,
  lng: number,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<BuildingResult> {
  const query = `[out:json][timeout:5];way["building"](around:20,${lat},${lng});out geom;`;
  const encodedQuery = encodeURIComponent(query);

  for (const baseUrl of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetchImpl(`${baseUrl}?data=${encodedQuery}`);
      if (!response.ok) continue;

      const data = (await response.json()) as { elements?: OverpassElement[] };

      if (data.elements && data.elements.length > 0) {
        // Берем первое найденное здание
        const building = data.elements[0];
        const props = building.tags || {};

        const heightTag = props.height || props['building:height'];
        const levelsTag = props['building:levels'] || props.levels;

        let heightStr = 'нет данных';
        if (heightTag) {
          heightStr = `${parseFloat(heightTag).toFixed(1)} м`;
        } else if (levelsTag) {
          heightStr = `~${(parseFloat(levelsTag) * 3).toFixed(1)} м (оценка)`;
        }

        const levelsStr = levelsTag || '—';
        const typeStr = props.building || props.type || 'здание';

        return { kind: 'found', building: { heightStr, levelsStr, typeStr } };
      }

      return { kind: 'not-found' };
    } catch {
      // Сервер не ответил — пробуем следующий (как в эталоне)
    }
  }

  return { kind: 'error', message: 'Не удалось связаться с сервером OSM. Попробуйте позже.' };
}
