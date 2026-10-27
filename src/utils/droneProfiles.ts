// ═══════════════════════════════════════════════════════════════
// Профили дронов: два режима работы парка (ТЗ пользователя)
//   • short_range — короткие дистанции, включая агродроны (полив/опыление,
//     малая высота, низкая скорость, видеосигнал с камеры подвеса);
//   • long_range  — дальнобойные БПЛА до 50 000 км (эшелонный полёт,
//     крейсерская высота, спутниковый канал, видео через сжатый downlink).
// Валидация маршрутов по дальности/скорости/высоте выполняется здесь;
// сторы и UI используют эти константы как единственный источник правил.
// ═══════════════════════════════════════════════════════════════

import { ValidationError } from './mission';

/** Режим работы дрона (профиль парка). */
export type DroneMode = 'short_range' | 'long_range';

export const DRONE_MODES: readonly DroneMode[] = ['short_range', 'long_range'];

/** Класс применения: обычный / агродрон (спрей-распылитель). */
export type DroneClass = 'standard' | 'agri';

export interface VideoProfile {
  /** Способен ли дрон передавать видеосигнал на GCS. */
  enabled: boolean;
  /** Пропускная способность канала, Мбит/с (видео + телеметрия). */
  bitrateMbps: number;
  /** Разрешение потока. */
  resolution: '720p' | '1080p' | '4K';
  /** Частота кадров. */
  fps: number;
  /** Дальность устойчивого видеоканала, м. */
  videoRangeM: number;
}

export interface DroneProfileSpec {
  mode: DroneMode;
  label: string;
  /** Максимальная дальность миссии, м. */
  maxMissionRangeM: number;
  /** Крейсерская скорость, м/с. */
  cruiseSpeedMs: number;
  /** Максимальная скорость, м/с. */
  maxSpeedMs: number;
  /** Рабочий диапазон высот AGL, м. */
  altitudeBandM: [number, number];
  /** Типичное время автономной работы, мин. */
  enduranceMin: number;
  /** Радиус действия прямой радиосвязи (data-link), м. */
  datalinkRangeM: number;
  /** Профиль видеосигнала. */
  video: VideoProfile;
  /** Требуется ли ретрансляция/спутник при превышении datalink. */
  relayRequiredBeyondDatalink: boolean;
}

/** Дальнобойный профиль: верхняя граница ТЗ — 50 000 км. */
export const LONG_RANGE_MAX_MISSION_M = 50_000_000; // 50 000 км

export const DRONE_PROFILES: Record<DroneMode, DroneProfileSpec> = {
  short_range: {
    mode: 'short_range',
    label: 'Короткие дистанции (в т.ч. агродроны)',
    maxMissionRangeM: 10_000,            // 10 км — типовой регламент VLOS/EVLOS
    cruiseSpeedMs: 8,
    maxSpeedMs: 15,
    altitudeBandM: [1, 30],              // агроопрыскивание 1–5 м, облет до 30 м
    enduranceMin: 45,
    datalinkRangeM: 5_000,               // прямая радиолиния 900 МГц/2.4 ГГц
    video: { enabled: true, bitrateMbps: 25, resolution: '1080p', fps: 60, videoRangeM: 3_000 },
    relayRequiredBeyondDatalink: false,
  },
  long_range: {
    mode: 'long_range',
    label: 'Дальнобойные БПЛА (до 50 000 км)',
    maxMissionRangeM: LONG_RANGE_MAX_MISSION_M,
    cruiseSpeedMs: 35,
    maxSpeedMs: 80,
    altitudeBandM: [100, 6000],          // эшелон патрулирования
    enduranceMin: 480,                   // 8 ч+ (барражирование)
    datalinkRangeM: 300_000,             // наземная РЛС-линия; дальше — спутник
    video: { enabled: true, bitrateMbps: 8, resolution: '720p', fps: 30, videoRangeM: 300_000 },
    relayRequiredBeyondDatalink: true,
  },
};

/** Агродрон — вариант короткого профиля с пониженной скоростью опрыскивания. */
export const AGRI_SPEED_MS = 5;

export function getProfile(mode: DroneMode): DroneProfileSpec {
  const p = DRONE_PROFILES[mode];
  if (!p) throw new ValidationError(`Неизвестный режим дрона: ${String(mode)}`);
  return p;
}

/** Нормализация строки в режим (для парсинга capabilities/конфига). */
export function parseDroneMode(raw: string | undefined | null): DroneMode | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === 'short_range' || s === 'short' || s === 'agri') return 'short_range';
  if (s === 'long_range' || s === 'long' || s === 'lr') return 'long_range';
  return null;
}

/** Извлечение режима из capabilities-строки регистрации ('mode:long_range'). */
export function modeFromCapabilities(capabilities: string[]): DroneMode | null {
  for (const c of capabilities) {
    const m = /^mode:(.+)$/i.exec(c.trim());
    if (m) {
      const parsed = parseDroneMode(m[1]);
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * Валидация маршрута против лимитов профиля.
 * @param routeLengthM длина маршрута по гео, м.
 * @param maxAltAGL максимальная заявленная высота точек, м AGL (null — не задана).
 * @returns список предупреждений (пустой массив — маршрут валиден).
 * @throws ValidationError при выходе за жёсткие лимиты режима.
 */
export function validateRouteForMode(
  routeLengthM: number,
  maxAltAGL: number | null,
  mode: DroneMode,
): string[] {
  const p = getProfile(mode);
  const warns: string[] = [];
  if (!Number.isFinite(routeLengthM) || routeLengthM < 0) {
    throw new ValidationError(`Некорректная длина маршрута: ${routeLengthM}`);
  }
  if (routeLengthM > p.maxMissionRangeM) {
    throw new ValidationError(
      `Маршрут ${Math.round(routeLengthM / 1000)} км превышает лимит режима «${p.label}» (${Math.round(p.maxMissionRangeM / 1000)} км)`,
    );
  }
  if (maxAltAGL !== null && Number.isFinite(maxAltAGL)) {
    const [lo, hi] = p.altitudeBandM;
    if (maxAltAGL < lo || maxAltAGL > hi) {
      throw new ValidationError(
        `Высота ${maxAltAGL} м вне рабочего диапазона режима «${p.label}» (${lo}–${hi} м AGL)`,
      );
    }
  }
  // Мягкие предупреждения: связь и автономность
  if (routeLengthM > p.datalinkRangeM && p.relayRequiredBeyondDatalink) {
    warns.push(`Дальность ${Math.round(routeLengthM / 1000)} км > прямой радиоканал ${Math.round(p.datalinkRangeM / 1000)} км — требуется ретрансляция/спутник`);
  }
  const estMin = routeLengthM / 1000 / (p.cruiseSpeedMs * 3.6) * 60;
  if (estMin > p.enduranceMin) {
    warns.push(`Расчётное время ${Math.round(estMin)} мин > автономность ${p.enduranceMin} мин — нужны промежуточные точки посадки/подзарядки`);
  }
  return warns;
}

/** Оценка времени полёта по профилю, мин. */
export function estimateFlightTimeMin(routeLengthM: number, mode: DroneMode): number {
  const p = getProfile(mode);
  if (routeLengthM <= 0) return 0;
  return Math.round((routeLengthM / p.cruiseSpeedMs) / 60);
}

/** Статус видеосигнала для данного расстояния от GCS. */
export function videoLinkStatus(distanceM: number, mode: DroneMode): { ok: boolean; note: string } {
  const p = getProfile(mode);
  if (!p.video.enabled) return { ok: false, note: 'Видеоканал отсутствует' };
  if (distanceM <= p.video.videoRangeM) {
    return { ok: true, note: `Видео ${p.video.resolution}/${p.video.fps}fps, ${p.video.bitrateMbps} Мбит/с` };
  }
  if (p.relayRequiredBeyondDatalink) {
    return { ok: true, note: `Видео через спутниковый ретранслятор (задержка ↑, битрейт ↓)` };
  }
  return { ok: false, note: `Вне зоны видеоканала (${Math.round(p.video.videoRangeM / 1000)} км)` };
}
