import { describe, it, expect } from 'vitest';
import { checkMissionCompatibility, classifyRouteMode, DRONE_PROFILES, LONG_RANGE_THRESHOLD_M } from '../src/utils/droneProfiles';
import type { Route } from '../src/types';

const routeWithLengthKm = (km: number): Route => ({
  id: 'r1', name: 'Long mission', color: '#fff', active: true, visible: true, createdAt: 'x',
  points: [
    { lat: 59.93, lng: 30.33, x: 0, y: 0 },
    { lat: 59.93 + km / 111.32, lng: 30.33, x: 100, y: 100 },
  ],
});

describe('Fleet compatibility (hard error)', () => {
  it('long-range миссия (>100км) на short-range дрон -> ok:false + причина', () => {
    const r = checkMissionCompatibility('qt-4-mini', routeWithLengthKm(120));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('превышает дальность');
    expect(LONG_RANGE_THRESHOLD_M).toBe(100_000);
  });
  it('та же миссия на long-range профиль -> ok:true', () => {
    expect(checkMissionCompatibility('vtol-lr', routeWithLengthKm(120)).ok).toBe(true);
  });
  it('классификация режима по длине', () => {
    expect(classifyRouteMode(routeWithLengthKm(150))).toBe('long-range');
    expect(classifyRouteMode(routeWithLengthKm(10))).toBe('short-range');
  });
  it('неизвестный профиль -> жёсткий отказ', () => {
    expect(checkMissionCompatibility('ghost', routeWithLengthKm(1)).ok).toBe(false);
  });
  it('превышение потолка AGL -> hard error', () => {
    const rt = routeWithLengthKm(5);
    rt.points.forEach((p) => { p.altitudeAGL = 300; });
    const r = checkMissionCompatibility('qt-4-mini', rt); // maxAltitudeAGL 120
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('потолок');
  });
  it('профиля достаточно для короткой миссии', () => {
    expect(Object.keys(DRONE_PROFILES).length).toBeGreaterThanOrEqual(3);
    expect(checkMissionCompatibility('qt-4-max', routeWithLengthKm(10)).ok).toBe(true);
  });
});
