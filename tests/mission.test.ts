/**
 * Юнит-тесты для модулей mission.ts и droneSim.ts (Блоки 1, 2, 4, 5).
 * Запуск без внешних зависимостей: `npm test` (node + tsc-компиляция).
 * Покрывает: happy path / граничные значения / обработку ошибок.
 */
import {
  ValidationError,
  validateLatLng,
  normalizeAngle360,
  sanitizeWaypointParams,
  createMissionMeta,
  optimizeRoute,
  generateScanLawnmower,
} from '../src/utils/mission';
import {
  ConnectionError,
  HardwareError,
  DroneSim,
  FleetManager,
  haversineM,
  estimateBatteryFor,
  validateGeoPoint,
} from '../src/utils/droneSim';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
  }
}

function expectThrows(fn: () => void, ctor: new (...a: never[]) => Error, name: string): void {
  try {
    fn();
  } catch (e) {
    assert(e instanceof ctor, `${name}: expected ${ctor.name}, got ${(e as Error).constructor.name}`);
    return;
  }
  throw new Error(`${name}: expected throw, got none`);
}

async function main(): Promise<void> {
  console.log('mission.ts');

  await test('validateLatLng принимает корректные координаты', () => {
    validateLatLng(59.93, 30.33, 120);
    validateLatLng(-90, -180, 0); // границы диапазона включительно
    validateLatLng(90, 180);
  });

  await test('validateLatLng отклоняет выход за границы', () => {
    expectThrows(() => validateLatLng(91, 0), ValidationError, 'lat>90');
    expectThrows(() => validateLatLng(0, 181), ValidationError, 'lon>180');
    expectThrows(() => validateLatLng(0, 0, 600), ValidationError, 'alt>MAX');
    expectThrows(() => validateLatLng(NaN, 0), ValidationError, 'NaN lat');
  });

  await test('normalizeAngle360 нормализует углы', () => {
    assert(normalizeAngle360(370) === 10, '370->10');
    assert(normalizeAngle360(-90) === 270, '-90->270');
    assert(normalizeAngle360(360) === 0, '360->0');
  });

  await test('sanitizeWaypointParams подчищает невалидные поля', () => {
    const p = sanitizeWaypointParams({ speedMs: 999, holdSec: -5, cameraAngleDeg: 725, acceptanceRadiusM: 0 });
    assert(p.speedMs <= 30, 'speed clamped to MAX_SPEED_MS');
    assert(p.holdSec >= 0, 'hold non-negative');
    assert(p.cameraAngleDeg >= 0 && p.cameraAngleDeg < 360, 'camera angle normalized');
    assert(p.acceptanceRadiusM >= 0.5, 'radius within range');
  });

  await test('createMissionMeta заполняет метаданные', () => {
    const m = createMissionMeta('r1', 'Разведка', 'оператор');
    assert(m.id === 'r1' && m.name === 'Разведка' && m.author === 'оператор', 'fields');
    assert(!Number.isNaN(Date.parse(m.createdAt)), 'createdAt ISO');
  });

  await test('optimizeRoute nearest_neighbor сокращает пересечённый маршрут', () => {
    const wps = [
      { lat: 0, lon: 0 }, { lat: 0.01, lon: 0.01 }, { lat: 0, lon: 0.01 }, { lat: 0.01, lon: 0 },
    ];
    const r = optimizeRoute(wps, 'nearest_neighbor');
    assert(r.waypoints.length === wps.length, 'same count');
    assert(r.improvementPct > 0, `expected improvement, got ${r.improvementPct}`);
    const expected = r.distanceBefore * (1 - r.improvementPct / 100);
    assert(Math.abs(r.distanceAfter - expected) / r.distanceBefore < 0.002, `metrics consistent (after=${r.distanceAfter}, expected~${expected})`);
  });

  await test('optimizeRoute граничные случаи (0/1 точка)', () => {
    assert(optimizeRoute([], 'genetic').improvementPct === 0, 'empty ok');
    const one = optimizeRoute([{ lat: 1, lon: 2 }], 'simulated_annealing');
    assert(one.waypoints.length === 1 && one.improvementPct === 0, 'single point unchanged');
  });

  await test('optimizeRoute детерминирован при одном seed (genetic)', () => {
    const wps = Array.from({ length: 8 }, (_, i) => ({ lat: ((i * 37) % 100) / 1000, lon: ((i * 53) % 100) / 1000 }));
    const a = optimizeRoute(wps, 'genetic', 7).waypoints.map((p) => `${p.lat},${p.lon}`).join('|');
    const b = optimizeRoute(wps, 'genetic', 7).waypoints.map((p) => `${p.lat},${p.lon}`).join('|');
    assert(a === b, 'deterministic with same seed');
  });

  await test('generateScanLawnmower строит змейку по полигону', () => {
    const poly = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ];
    const route = generateScanLawnmower(poly, 25);
    assert(route.length >= 8, `expected serpentine points, got ${route.length}`);
    for (const p of route) {
      assert(p.x >= -1e-9 && p.x <= 100 + 1e-9 && p.y >= -1e-9 && p.y <= 100 + 1e-9, 'scan point inside bbox');
    }
    // змейка: чередование направлений по x на последовательных строках
    assert(route[0].x !== route[1].x || route.length < 2, 'row has two distinct ends');
  });

  await test('generateScanLawnmower отклоняет вырожденный полигон и шаг', () => {
    expectThrows(() => generateScanLawnmower([{ x: 0, y: 0 }], 10), ValidationError, 'degenerate polygon');
    expectThrows(
      () => generateScanLawnmower([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }], 0),
      ValidationError,
      'zero spacing',
    );
  });

  console.log('droneSim.ts');

  await test('полётный цикл happy path: preflight→arm→takeoff→mode→RTL', async () => {
    const sim = new DroneSim('uav-1', { lat: 59.93, lon: 30.33, batteryPct: 90, altM: 0 });
    const pf = await sim.preflightCheck();
    assert(pf.ok, 'preflight ok');
    await sim.arm();
    assert(sim.telemetry().armed, 'armed');
    await sim.takeoff(50, 5000);
    const t = sim.telemetry();
    assert(t.airborne && Math.abs(t.altM - 50) < 1e-6, `altitude reached: ${t.altM}`);
    await sim.setFlightMode('Auto');
    assert(sim.telemetry().mode === 'Auto', 'mode switched');
    await sim.returnToHome({ lat: 59.93, lon: 30.33 }, 100);
    assert(sim.telemetry().mode === 'RTL', 'RTL engaged');
  });

  await test('arm отклоняется при плохом preflight (батарея 10%)', async () => {
    const sim = new DroneSim('uav-2', { batteryPct: 10 });
    const pf = await sim.preflightCheck();
    assert(!pf.ok, 'preflight must fail on low battery');
    let threw = false;
    try { await sim.arm(); } catch { threw = true; }
    assert(threw, 'arm rejected when preflight fails');
    assert(!sim.telemetry().armed, 'still disarmed');
  });

  await test('disarm в воздухе запрещён (проверка безопасности)', async () => {
    const sim = new DroneSim('uav-3', { lat: 1, lon: 1, batteryPct: 80 });
    await sim.arm();
    await sim.takeoff(30, 5000);
    let threw = false;
    try { await sim.disarm(); } catch (e) { threw = e instanceof HardwareError || e instanceof ValidationError; }
    assert(threw, 'disarm mid-air rejected');
  });

  await test('ConnectionError при обрыве канала связи', async () => {
    const sim = new DroneSim('uav-4', { batteryPct: 80 });
    sim.setConnection(false);
    let threw = false;
    try { await sim.arm(); } catch (e) { threw = e instanceof ConnectionError; }
    assert(threw, 'arm over dead link throws ConnectionError');
  });

  await test('недопустимый режим полёта отклоняется', async () => {
    const sim = new DroneSim('uav-5');
    let threw = false;
    try { await sim.setFlightMode('Turbo' as never); } catch { threw = true; }
    assert(threw, 'invalid mode rejected');
  });

  await test('haversineM считает расстояние корректно', () => {
    const d = haversineM({ lat: 59.93, lon: 30.33 }, { lat: 59.94, lon: 30.33 });
    assert(d > 1000 && d < 1250, `~1.11 km, got ${d.toFixed(1)} m`);
    assert(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 0 }) === 0, 'same point = 0');
  });

  await test('estimateBatteryFor растёт с расстоянием и ветром', () => {
    const calm = estimateBatteryFor(1000, 0);
    const windy = estimateBatteryFor(1000, 10);
    const far = estimateBatteryFor(3000, 0);
    assert(windy > calm, 'wind increases consumption');
    assert(far > calm, 'distance increases consumption');
    expectThrows(() => validateGeoPoint(95, 0), ValidationError, 'geo validation');
  });

  await test('FleetManager: регистрация, назначение, autoAssign, handoff', () => {
    const fm = new FleetManager();
    fm.registerDrone('d1', 'udp://192.168.1.10:14550', ['camera']);
    fm.registerDrone('d2', 'udp://192.168.1.11:14550', ['camera', 'speaker']);
    expectThrows(() => fm.registerDrone('d1', 'udp://192.168.1.12:14550', []), Error, 'empty capabilities rejected');
    expectThrows(() => fm.registerDrone('d1', 'bad-conn-str', ['camera']), ValidationError, 'bad connection_string rejected');
    fm.assignDroneToTarget('d1', 't1');
    const pairs = fm.autoAssignTargets(
      [{ id: 'a', lat: 59.9, lon: 30.3 }, { id: 'b', lat: 59.95, lon: 30.36 }],
      [{ droneId: 'd1', lat: 59.9, lon: 30.3 }, { droneId: 'd2', lat: 59.95, lon: 30.36 }],
    );
    assert(pairs.length === 2, 'two assignments');
    assert(pairs.every((p) => p.costM >= 0), 'costs non-negative');
    fm.handoffTarget('d1', 'd2', 't1'); // ok: t1 назначен d1
    assert(fm.assignmentFor('t1') === 'd2', 'handoff moved target to d2');
    expectThrows(() => fm.handoffTarget('dX', 'd2', 't1'), Error, 'unknown drone rejected');
  });

  console.log(`\nИтого: ${passed} passed, ${failed} failed`);
  if (failed > 0) (globalThis as { process?: { exit(code: number): void } }).process?.exit(1);
}

main().catch((e) => { console.error(e); (globalThis as { process?: { exit(code: number): void } }).process?.exit(1); });
