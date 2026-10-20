// Профили дронов флота (Блок 5) + строгая проверка совместимости миссии с
// профилем. Контракт: назначение long-range миссии (>100 км) на short-range
// дрон — HARD ERROR (маршрут блокируется, в routeWarnings попадает запись с
// префиксом «FLEET:»), а не мягкое предупреждение.
import type { Route } from '../types';
import { routeLengthM } from './routing';

export type MissionMode = 'short-range' | 'long-range';

export interface DroneProfile {
  id: string;
  name: string;
  /** Максимальная дальность полёта на одном заряде, м */
  maxRangeM: number;
  /** Крейсерская скорость, м/с */
  cruiseSpeedMs: number;
  /** Максимальная высота AGL, м */
  maxAltitudeAGL: number;
  /** Режим, к которому привязан профиль */
  mode: MissionMode;
}

/** Порог long-range миссии: маршрут длиннее 100 км считается дальней. */
export const LONG_RANGE_THRESHOLD_M = 100_000;

export const DRONE_PROFILES: Record<string, DroneProfile> = {
  'qt-4-mini': {
    id: 'qt-4-mini',
    name: 'TotalQuadro QT-4 Mini (short-range)',
    maxRangeM: 30_000,
    cruiseSpeedMs: 12,
    maxAltitudeAGL: 120,
    mode: 'short-range',
  },
  'qt-4-max': {
    id: 'qt-4-max',
    name: 'TotalQuadro QT-4 Max (short-range)',
    maxRangeM: 60_000,
    cruiseSpeedMs: 16,
    maxAltitudeAGL: 150,
    mode: 'short-range',
  },
  'vtol-lr': {
    id: 'vtol-lr',
    name: 'TotalQuadro VTOL LR (long-range)',
    maxRangeM: 250_000,
    cruiseSpeedMs: 28,
    maxAltitudeAGL: 400,
    mode: 'long-range',
  },
};

export function getDroneProfile(id: string): DroneProfile | null {
  return DRONE_PROFILES[id] ?? null;
}

/** Классификация маршрута по дальности. */
export function classifyRouteMode(route: Route): MissionMode {
  const len = routeLengthM(route.points.map((p) => ({ lat: p.lat, lng: p.lng })));
  return len > LONG_RANGE_THRESHOLD_M ? 'long-range' : 'short-range';
}

export interface FleetCheckResult {
  ok: boolean;
  /** Протяжённость маршрута, м */
  lengthM: number;
  /** Причина отказа (для hard error) */
  reason?: string;
}

/**
 * ЖЁСТКАЯ проверка: можно ли назначить маршрут `route` дрону с профилем
 * `profile`. Превышение дальности или потолка высот — отказ (hard error),
 * вызывающий блокировку смены режима и запись в routeWarnings с префиксом
 * «FLEET:».
 */
export function checkMissionCompatibility(profileId: string, route: Route): FleetCheckResult {
  const profile = getDroneProfile(profileId);
  if (!profile) {
    return { ok: false, lengthM: 0, reason: `Неизвестный профиль дрона «${profileId}»` };
  }
  const lengthM = routeLengthM(route.points.map((p) => ({ lat: p.lat, lng: p.lng })));
  if (lengthM > profile.maxRangeM) {
    return {
      ok: false,
      lengthM,
      reason:
        `Маршрут «${route.name}» (${Math.round(lengthM / 100) / 10} км) превышает дальность ` +
        `${profile.name} (${Math.round(profile.maxRangeM / 100) / 10} км) — запуск заблокирован`,
    };
  }
  const maxAgl = route.points.reduce(
    (m, p) => (typeof p.altitudeAGL === 'number' && Number.isFinite(p.altitudeAGL) ? Math.max(m, p.altitudeAGL) : m),
    0,
  );
  if (maxAgl > profile.maxAltitudeAGL) {
    return {
      ok: false,
      lengthM,
      reason:
        `Высота этапов ${Math.round(maxAgl)} м AGL превышает потолок ${profile.name} ` +
        `(${profile.maxAltitudeAGL} м) — запуск заблокирован`,
    };
  }
  return { ok: true, lengthM };
}

/** Префикс hard-error сообщений флота в routeWarnings. */
export const FLEET_ERROR_PREFIX = 'FLEET:';
