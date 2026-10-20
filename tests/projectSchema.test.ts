import { describe, it, expect } from 'vitest';
import { parseProject, parseViewState, DEFAULT_VIEW_STATE } from '../src/utils/projectSchema';

const validProject = () => ({
  version: '1', projectName: 'P', createdAt: 'c', updatedAt: 'u',
  map: null,
  calibration: { enabled: false, points: [] },
  restrictions: [], markers: [], routes: [], layers: [{ id: 'l', name: 'L', visible: true, locked: false }],
  settings: { showGrid: true, gridSize: 10, showCoordinates: true, theme: 'dark' },
  googleMaps: { apiKey: '', enabled: false }, yandexMaps: { apiKey: '', enabled: false },
  openStreetMap: { enabled: false, tileServer: 'osm' },
});

describe('parseProject (Zod)', () => {
  it('принимает корректный проект', () => {
    const r = parseProject(validProject());
    expect(r.ok).toBe(true);
  });
  it('NaN в lat -> { ok:false, errors } без краша', () => {
    const p = validProject();
    p.markers = [{ id: 'm1', name: 'M', x: 0, y: 0, lat: NaN, lon: 30.3, type: 't', color: '#fff', comment: '', layer: 'default', createdAt: 'x' }];
    const r = parseProject(p);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.errors.some((e) => e.includes('markers.0.lat'))).toBe(true);
  });
  it('missing fields -> ошибки, не undefined', () => {
    const r = parseProject({ foo: 'bar' });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.errors.length).toBeGreaterThan(3);
  });
  it('out-of-bounds lat/lon отклоняются', () => {
    const p = validProject();
    p.calibration.points = [{ pixelX: 1, pixelY: 1, lat: 95, lon: 200 }];
    const r = parseProject(p);
    expect(r.ok).toBe(false);
  });
  it('polygon < 3 вершин -> понятная ошибка семантики', () => {
    const p = validProject();
    p.restrictions = [{ id: 'r1', type: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: '#f00', name: 'NFZ', active: true }];
    const r = parseProject(p);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.errors[0]).toContain('polygon');
  });
  it('битый JSON-вход (null, строка) не крашится', () => {
    expect(parseProject(null).ok).toBe(false);
    expect(parseProject('nope').ok).toBe(false);
  });
});

describe('parseViewState', () => {
  it('битые данные -> безопасные дефолты', () => {
    expect(parseViewState(null)).toEqual(DEFAULT_VIEW_STATE);
    expect(parseViewState({ offsetX: NaN, scale: -5 })).toEqual({ ...DEFAULT_VIEW_STATE, offsetY: 0 });
    expect(parseViewState('junk')).toEqual(DEFAULT_VIEW_STATE);
  });
  it('валидные поля сохраняются', () => {
    expect(parseViewState({ offsetX: 10, offsetY: 20, scale: 2.5, z0: 12 })).toEqual({ offsetX: 10, offsetY: 20, scale: 2.5, z0: 12 });
  });
});
