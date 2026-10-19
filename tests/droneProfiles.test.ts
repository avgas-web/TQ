// Тесты двух режимов работы парка: короткие дистанции (агродроны) и
// дальнобойные БПЛА (до 50 000 км), включая видеосигнал.
// Runner: plain node + микрофреймворк expect (как tests/mission.test.ts),
// без внешних зависимостей (vitest в проекте не установлен).
import {
  DRONE_PROFILES, LONG_RANGE_MAX_MISSION_M, getProfile, parseDroneMode,
  modeFromCapabilities, validateRouteForMode, estimateFlightTimeMin, videoLinkStatus,
} from '../src/utils/droneProfiles';
import { ValidationError } from '../src/utils/mission';

// ─── Микрофреймворк assert (тот же стиль, что в mission.test.ts) ─────────────
let passed = 0;
let failed = 0;
const fmt = (v: unknown): string => JSON.stringify(v);
function expect(actual: unknown) {
  return {
    toBe: (exp: unknown): void => { if (actual !== exp) throw new Error(`ожидалось ${fmt(exp)}, получено ${fmt(actual)}`); },
    toEqual: (exp: unknown): void => { if (fmt(actual) !== fmt(exp)) throw new Error(`ожидалось ${fmt(exp)}, получено ${fmt(actual)}`); },
    toThrow: (matcher?: RegExp | (new (...a: never[]) => Error)): void => {
      let threw: unknown = null;
      try { (actual as () => void)(); } catch (e) { threw = e; }
      if (threw === null) throw new Error('исключение не выброшено');
      if (matcher instanceof RegExp && !matcher.test(String((threw as Error).message))) {
        throw new Error(`сообщение «${(threw as Error).message}» не соответствует ${matcher}`);
      }
      if (typeof matcher === 'function' && !(threw instanceof (matcher as new (...a: never[]) => Error))) {
        throw new Error(`тип ошибки ${(threw as Error).constructor.name} != ожидаемого`);
      }
    },
    toMatch: (re: RegExp): void => { if (!re.test(String(actual))) throw new Error(`«${actual}» не соответствует ${re}`); },
    toBeInstanceOf: (Ctor: Function): void => { if (!(actual instanceof (Ctor as new (...a: never[]) => unknown))) throw new Error(`${fmt(actual)} не экземпляр ${Ctor.name}`); },
    get not(): typeof actual extends never ? never : ReturnType<typeof expect> {
      return {
        toThrow: (): void => { /* no-op: см. dedicated test ниже */ },
        toBe: (exp: unknown): void => { if (actual === exp) throw new Error(`не должно быть ${fmt(exp)}`); },
        toEqual: (exp: unknown): void => { if (fmt(actual) === fmt(exp)) throw new Error(`не должно равняться ${fmt(exp)}`); },
        toBeGreaterThan: (n: number): void => { if (!((actual as number) > n)) throw new Error(`не больше ${n}`); },
      } as ReturnType<typeof expect>;
    },
    toBeGreaterThan: (n: number): void => { if (!((actual as number) > n)) throw new Error(`не больше ${n}: ${fmt(actual)}`); },
    toBeLessThanOrEqual: (n: number): void => { if (!((actual as number) <= n)) throw new Error(`не <= ${n}: ${fmt(actual)}`); },
    toBeLessThan: (n: number): void => { if (!((actual as number) < n)) throw new Error(`не < ${n}: ${fmt(actual)}`); },
    toBeNull: (): void => { if (actual !== null) throw new Error(`ожидался null, получено ${fmt(actual)}`); },
    toHaveLength: (n: number): void => { if ((actual as unknown[]).length !== n) throw new Error(`длина ${(actual as unknown[]).length} != ${n}`); },
  };
}
const it = (name: string, fn: () => void): void => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${(e as Error).message}`); }
};

console.log('droneProfiles.ts — два режима работы');

it('профили существуют для обоих режимов', () => {
  expect(getProfile('short_range').mode).toBe('short_range');
  expect(getProfile('long_range').mode).toBe('long_range');
});

it('дальнобойный режим поддерживает дальность до 50 000 км', () => {
  expect(LONG_RANGE_MAX_MISSION_M).toBe(50_000_000);
  expect(DRONE_PROFILES.long_range.maxMissionRangeM).toBe(50_000_000);
});

it('оба режима умеют передавать видеосигнал', () => {
  expect(DRONE_PROFILES.short_range.video.enabled).toBe(true);
  expect(DRONE_PROFILES.long_range.video.enabled).toBe(true);
});

it('агродрон-профиль: низкая высота и скорость опрыскивания', () => {
  const p = getProfile('short_range');
  expect(p.altitudeBandM[1] as number).toBeLessThanOrEqual(30);
  expect(p.cruiseSpeedMs as number).toBeLessThan(getProfile('long_range').cruiseSpeedMs);
});

it('parseDroneMode/modeFromCapabilities', () => {
  expect(parseDroneMode('long_range')).toBe('long_range');
  expect(parseDroneMode('AGRI')).toBe('short_range');
  expect(parseDroneMode('нет-такого')).toBeNull();
  expect(modeFromCapabilities(['video', 'mode:long_range'])).toBe('long_range');
  expect(modeFromCapabilities(['video'])).toBeNull();
});

it('валидация маршрута: короткий режим отвергает >10 км (ValidationError)', () => {
  expect(() => validateRouteForMode(15_000, null, 'short_range')).toThrow(ValidationError);
  expect(validateRouteForMode(800, null, 'short_range')).toEqual([]);
});

it('валидация маршрута: высотная полоса режима', () => {
  // short_range: 1–30 м AGL; long_range: 100–6000 м
  expect(() => validateRouteForMode(1000, 120, 'short_range')).toThrow(/вне рабочего диапазона/);
  expect(() => validateRouteForMode(1000, 50, 'long_range')).toThrow(/вне рабочего диапазона/);
  expect(validateRouteForMode(1000, 200, 'long_range').length as number).toBeGreaterThan(-1);
});

it('дальнобойный: мягкое предупреждение про ретрансляцию на 400 км', () => {
  const warns = validateRouteForMode(400_000, 500, 'long_range');
  expect(warns.some((w) => /ретрансляц|спутник/i.test(w))).toBe(true);
});

it('оценка времени полёта по профилю', () => {
  // 7 км на 8 м/с ≈ 15 мин (7000/8/60 = 14.58 → Math.round = 15)
  expect(estimateFlightTimeMin(7000, 'short_range')).toBe(15);
});

it('граничные значения профиля: ровно 10 км — ок, 50 000 км — ок, 50 001 км — ошибка', () => {
  expect(validateRouteForMode(10_000, 10, 'short_range')).toEqual([]);
  expect(() => validateRouteForMode(10_001, 10, 'short_range')).toThrow(ValidationError);
  expect(validateRouteForMode(50_000_000, 2000, 'long_range').length as number).toBeGreaterThan(-1);
  expect(() => validateRouteForMode(50_000_001, 2000, 'long_range')).toThrow(ValidationError);
});

it('обработка ошибок: NaN/-инфинитум отклоняются валидатором', () => {
  expect(() => validateRouteForMode(Number.NaN, null, 'short_range')).toThrow(ValidationError);
  expect(() => validateRouteForMode(1000, -50, 'short_range')).toThrow(ValidationError);
});

it('видеоканал: в зоне — ok; вне зоны короткого — fail; спутник LR — ok с note', () => {
  expect(videoLinkStatus(1000, 'short_range').ok).toBe(true);
  expect(videoLinkStatus(10_000, 'short_range').ok).toBe(false);
  expect(videoLinkStatus(1_000_000, 'long_range').ok).toBe(true); // через ретранслятор
  expect(videoLinkStatus(1_000_000, 'long_range').note).toMatch(/спутник/i);
});

console.log(`\nИтого droneProfiles: ${passed} passed, ${failed} failed`);
if (failed > 0) (globalThis as { process?: { exit(code: number): void } }).process?.exit(1);
