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
  | { kind: "found"; building: BuildingInfo }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/** Список серверов (если один недоступен, пробуем следующий) — как в эталоне. */
export const OVERPASS_ENDPOINTS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

// ФАЗА 2 (XSS): buildingPopupHtml() удалён — он возвращал сырой HTML из
// тегов OSM (props.building / height / levels могут содержать произвольные
// строки, например `<img src=x onerror=...>`), который вставлялся в DOM через
// dangerouslySetInnerHTML. Попап рендерится чистыми React-компонентами
// (см. components/wizard/BuildingPopupCard.tsx) — текст экранируется автоматически.

interface OverpassElement {
  tags?: Record<string, string>;
}

export interface FindBuildingOptions {
  /**
   * Сигнал отмены (ФАЗА 4.3): при abort прерывается текущий fetch И цикл
   * перебора эндпоинтов — устаревший запрос не должен порождать ни результат,
   * ни лишние сетевые обращения к следующим серверам.
   */
  signal?: AbortSignal;
}

/** Признак «запрос отменён» (AbortError / signal.aborted) — без магических строк. */
function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException || e instanceof Error) {
    return e.name === "AbortError";
  }
  return false;
}

/**
 * Поиск ближайшего здания в радиусе 20 м от точки клика.
 * Возвращает found / not-found / error — статусы соответствуют сообщениям
 * setStatus() из эталона.
 *
 * ФАЗА 4.3 (аудит): поддержка AbortSignal. Если сигнал снят ДО запуска или во
 * время ожидания ответа — возвращается kind='aborted' (не 'error'): это не
 * сбой сети, и UI не должен показывать «Не удалось связаться с сервером».
 * Отмена также останавливает перебор эндпоинтов.
 */
export async function findBuildingAt(
  lat: number,
  lng: number,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  opts: FindBuildingOptions = {},
): Promise<BuildingResult | { kind: "aborted" }> {
  const { signal } = opts;
  // Отменённый «до старта» сигнал не должен порождать ни одного запроса.
  if (signal?.aborted) return { kind: "aborted" };

  const query = `[out:json][timeout:5];way["building"](around:20,${lat},${lng});out geom;`;
  const encodedQuery = encodeURIComponent(query);

  for (const baseUrl of OVERPASS_ENDPOINTS) {
    if (signal?.aborted) return { kind: "aborted" };
    try {
      const response = await fetchImpl(`${baseUrl}?data=${encodedQuery}`, {
        signal,
      });
      if (signal?.aborted) return { kind: "aborted" };
      if (!response.ok) continue;

      const data = (await response.json()) as { elements?: OverpassElement[] };
      // Ответ пришёл, но запрос уже не актуален (пользователь кликнул дальше) —
      // данные выбрасываем, попап перезапишет только самый новый запрос.
      if (signal?.aborted) return { kind: "aborted" };

      if (data.elements && data.elements.length > 0) {
        // Берем первое найденное здание
        const building = data.elements[0];
        const props = building.tags || {};

        const heightTag = props.height || props["building:height"];
        const levelsTag = props["building:levels"] || props.levels;

        let heightStr = "нет данных";
        if (heightTag) {
          heightStr = `${parseFloat(heightTag).toFixed(1)} м`;
        } else if (levelsTag) {
          heightStr = `~${(parseFloat(levelsTag) * 3).toFixed(1)} м (оценка)`;
        }

        const levelsStr = levelsTag || "—";
        const typeStr = props.building || props.type || "здание";

        return { kind: "found", building: { heightStr, levelsStr, typeStr } };
      }

      return { kind: "not-found" };
    } catch (e) {
      // ФАЗА 4.3: отмена — НЕ ошибка: выходим немедленно, без следующих эндпоинтов.
      if (isAbortError(e) || signal?.aborted) return { kind: "aborted" };
      // Сервер не ответил — пробуем следующий (как в эталоне)
    }
  }

  return {
    kind: "error",
    message: "Не удалось связаться с сервером OSM. Попробуйте позже.",
  };
}
