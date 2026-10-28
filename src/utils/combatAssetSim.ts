// Симулятор полётного контроллера (Блоки 2, 3, 4, 5, 6).
// Прототип работает в браузере без реального железа, поэтому команды
// управления выполняются против in-memory модели боевого аппарата с очередью команд,
// таймаутами, retry-логикой и журналированием. Публичный API повторяет
// имена функций из ТЗ (preflight_check, arm, takeoff, ...), стиль — camelCase.

import { MAX_ALTITUDE_M, ValidationError, normalizeAngle360 } from './mission';

export type FlightMode = 'Manual' | 'Stabilize' | 'Loiter' | 'Guided' | 'Auto' | 'RTL' | 'Land';
export const FLIGHT_MODES: readonly FlightMode[] = ['Manual', 'Stabilize', 'Loiter', 'Guided', 'Auto', 'RTL', 'Land'];

export type GeofenceAction = 'report' | 'loiter' | 'rtl' | 'land';
export type AdizShape = 'cylinder' | 'polygon' | 'sphere';
export type TargetType = 'person' | 'vehicle' | 'structure';
export type PayloadAction = 'release' | 'siren_on' | 'siren_off' | 'laser_fire' | 'laser_stop';
export type FormationType = 'line' | 'v_shape' | 'grid';

/** Ошибки симулятора по категориям из ТЗ. */
export class ConnectionError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'ConnectionError';
  }
}
export class TimeoutError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'TimeoutError';
  }
}
export class HardwareError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'HardwareError';
  }
}

export interface Telemetry {
  lat: number;
  lon: number;
  altM: number;
  yawDeg: number;
  batteryPct: number;
  sats: number;
  windMs: number;
  tempC: number;
  armed: boolean;
  airborne: boolean;
  mode: FlightMode;
  timestamp: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: Record<string, string>;
}

export interface Geofence {
  polygon: Array<{ lat: number; lon: number }>;
  actionOnBreach: GeofenceAction;
}

export interface AdizZone {
  id: string;
  shape: AdizShape;
  center?: { lat: number; lon: number; altM?: number };
  radiusM?: number;
  polygon?: Array<{ lat: number; lon: number }>;
  ceilingM: number;
}

export interface Failsafes {
  battery: { rtlPct: number; landPct: number; criticalPct: number };
  gcs: { timeoutSec: number; action: GeofenceAction };
  gpsLossAction: 'land' | 'loiter' | 'rtl';
}

export interface MissionExecutionState {
  missionId: string | null;
  wpIndex: number;
  status: 'idle' | 'running' | 'paused' | 'done' | 'aborted';
}

type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
interface LogRecord {
  level: LogLevel;
  message: string;
  at: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_BASE_DELAY_MS = 100;
const MIN_SATS = 6;
const MIN_BATTERY_ARM_PCT = 50;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function assertFinite(name: string, v: number): void {
  if (!Number.isFinite(v)) throw new ValidationError(`${name}: нечисловое значение ${String(v)}`);
}

/**
 * Одна модель боевого аппарата: состояние, геозоны, failsafe, журнал телеметрии.
 * Все публичные методы async, защищают общее состояние «замком» очереди
 * (одновременные команды сериализуются) и имеют таймаут + retry.
 */
export class CombatAssetSim {
  readonly assetId: string;
  private state: Telemetry;
  private geofence: Geofence | null = null;
  private adizZones: AdizZone[] = [];
  private failsafes: Failsafes = {
    battery: { rtlPct: 30, landPct: 15, criticalPct: 5 },
    gcs: { timeoutSec: 10, action: 'rtl' },
    gpsLossAction: 'loiter',
  };
  private targets: Map<string, { lat: number; lon: number; altM: number; priority: number; type: TargetType }> = new Map();
  private trackedTargetId: string | null = null;
  private gimbal = { pitch: 0, roll: 0, yaw: 0 };
  private media = { photos: 0, videoRecording: false };
  private mission: MissionExecutionState = { missionId: null, wpIndex: 0, status: 'idle' };
  private log: LogRecord[] = [];
  private connectionUp = true;
  private lockChain: Promise<unknown> = Promise.resolve();

  constructor(assetId: string, start: Partial<Telemetry> = {}) {
    this.assetId = assetId;
    this.state = {
      lat: 0,
      lon: 0,
      altM: 0,
      yawDeg: 0,
      batteryPct: 100,
      sats: 12,
      windMs: 0,
      tempC: 20,
      armed: false,
      airborne: false,
      mode: 'Stabilize',
      timestamp: new Date().toISOString(),
      ...start,
    };
  }

  /** Имитация обрыва/восстановления канала связи (для тестов). */
  setConnection(up: boolean): void {
    this.connectionUp = up;
    this.pushLog(up ? 'INFO' : 'WARNING', `Связь ${up ? 'восстановлена' : 'утеряна'}`);
  }

  telemetry(): Telemetry {
    return { ...this.state };
  }

  getLog(): LogRecord[] {
    return [...this.log];
  }

  private pushLog(level: LogLevel, message: string): void {
    this.log.push({ level, message, at: new Date().toISOString() });
    if (this.log.length > 5000) this.log.splice(0, this.log.length - 5000);
  }

  private requireConnection(): void {
    if (!this.connectionUp) throw new ConnectionError(`Нет связи с боевым аппаратом ${this.assetId}`);
  }

  /** Сериализация команд через «замок» промисов (потокобезопасность). */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockChain.then(fn, fn);
    this.lockChain = run.catch(() => undefined);
    return run;
  }

  /** Выполняет команду с таймаутом и повторными попытками (эксп. задержка). */
  private async withRetry<T>(label: string, fn: () => Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        const res = await Promise.race([
          fn(),
          sleep(timeoutMs).then(() => {
            throw new TimeoutError(`Таймаут (${timeoutMs} мс): ${label}`);
          }),
        ]);
        this.pushLog('INFO', `${label}: ок`);
        return res;
      } catch (e) {
        attempt++;
        if (attempt > retries || e instanceof ValidationError) throw e;
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        this.pushLog('WARNING', `${label}: попытка ${attempt}/${retries + 1}, ретрай через ${delay} мс (${(e as Error).message})`);
        await sleep(delay);
      }
    }
  }

  // ────────────────────────── Блок 2: управление полётом ──────────────────────────

  /**
   * Полная предполётная проверка (preflight_check).
   *
   * Returns:
   *   PreflightResult: ok=true, если все проверки пройдены; иначе — список
   *   причин в поле checks.
   */
  async preflightCheck(): Promise<PreflightResult> {
    return this.withLock(async () => {
      this.requireConnection();
      const checks: Record<string, string> = {};
      if (this.state.sats < MIN_SATS) checks.gps = `GPS fix слабый: ${this.state.sats} спутников (мин. ${MIN_SATS})`;
      checks.compass = 'ok';
      if (this.state.batteryPct <= MIN_BATTERY_ARM_PCT) checks.battery = `Заряд ${this.state.batteryPct}% ≤ ${MIN_BATTERY_ARM_PCT}%`;
      checks.link = 'ok';
      if (this.state.armed && !this.state.airborne) checks.state = 'Боевой аппарат захвачен на земле';
      const ok = Object.values(checks).every((v) => v === 'ok');
      this.pushLog(ok ? 'INFO' : 'WARNING', `preflight: ${ok ? 'готов' : 'отказ'}`);
      return { ok, checks };
    });
  }

  /** Вооружение моторов с проверками безопасности (arm). */
  async arm(): Promise<void> {
    return this.withLock(() =>
      this.withRetry('arm', async () => {
        this.requireConnection();
        if (this.state.armed) throw new ValidationError('Боевой аппарат уже вооружён');
        if (this.state.airborne) throw new ValidationError('Нельзя вооружить боевой аппарат в воздухе повторно');
        const pf = await this.preflightCheck();
        if (!pf.ok) throw new HardwareError(`Preflight не пройден: ${Object.values(pf.checks).filter((v) => v !== 'ok').join('; ')}`);
        this.state.armed = true;
        this.pushLog('INFO', 'Моторы вооружены');
      }),
    );
  }

  /** Сброс вооружения; в воздухе disarm запрещён (disarm). */
  async disarm(): Promise<void> {
    return this.withLock(() =>
      this.withRetry('disarm', async () => {
        this.requireConnection();
        if (!this.state.armed) throw new ValidationError('Боевой аппарат не вооружён');
        if (this.state.airborne) throw new ValidationError('Нельзя снять вооружение в воздухе');
        this.state.armed = false;
        this.pushLog('INFO', 'Моторы сброшены');
      }),
    );
  }

  /** Взлёт на высоту с контролем достижения (takeoff). */
  async takeoff(altitudeM: number, timeoutMs = 15000): Promise<void> {
    assertFinite('altitude', altitudeM);
    if (altitudeM <= 0 || altitudeM > MAX_ALTITUDE_M) {
      throw new ValidationError(`Высота взлёта вне диапазона [0..${MAX_ALTITUDE_M}]: ${altitudeM}`);
    }
    return this.withLock(() =>
      this.withRetry('takeoff', async () => {
        this.requireConnection();
        if (!this.state.armed) throw new HardwareError('Вооружите моторы перед взлётом');
        if (this.state.airborne) throw new ValidationError('Боевой аппарат уже в воздухе');
        this.setModeInternal('Guided');
        this.state.altM = altitudeM;
        this.state.airborne = true;
        this.drainBattery(altitudeM / 100);
        this.pushLog('INFO', `Взлёт выполнен: ${altitudeM} м`);
      }, timeoutMs),
    );
  }

  /** Посадка в текущей или заданной точке (land). */
  async land(location?: { lat: number; lon: number } | null): Promise<void> {
    return this.withLock(() =>
      this.withRetry('land', async () => {
        this.requireConnection();
        if (!this.state.airborne) throw new ValidationError('Боевой аппарат не в воздухе');
        if (location) {
          validateGeoPoint(location.lat, location.lon);
          this.state.lat = location.lat;
          this.state.lon = location.lon;
        }
        this.state.altM = 0;
        this.state.airborne = false;
        this.state.armed = false;
        this.setModeInternal('Land');
        this.pushLog('INFO', 'Посадка выполнена');
      }),
    );
  }

  /** Возврат на базу с оценкой запаса заряда (return_to_home). */
  async returnToHome(home: { lat: number; lon: number }, distanceM: number): Promise<void> {
    return this.withLock(() =>
      this.withRetry('rtl', async () => {
        this.requireConnection();
        const needed = estimateBatteryFor(distanceM, this.state.windMs);
        if (this.state.batteryPct < needed * 1.2) {
          throw new HardwareError(`Недостаточно заряда для RTL: ${this.state.batteryPct}% < ${Math.ceil(needed * 1.2)}% (ветер ${this.state.windMs} м/с)`);
        }
        validateGeoPoint(home.lat, home.lon);
        this.state.lat = home.lat;
        this.state.lon = home.lon;
        this.state.altM = 0;
        this.state.airborne = false;
        this.state.armed = false;
        this.drainBattery(needed);
        this.setModeInternal('RTL');
        this.pushLog('INFO', `RTL завершён (${distanceM} м, расход ${needed.toFixed(1)}%)`);
      }),
    );
  }

  /** Переключение режима с валидацией списка (set_flight_mode). */
  async setFlightMode(mode: FlightMode): Promise<void> {
    return this.withLock(() =>
      this.withRetry(`set_mode(${mode})`, async () => {
        this.requireConnection();
        if (!FLIGHT_MODES.includes(mode)) throw new ValidationError(`Недопустимый режим: ${String(mode)}`);
        this.setModeInternal(mode);
      }),
    );
  }

  private setModeInternal(mode: FlightMode): void {
    this.state.mode = mode;
    this.pushLog('DEBUG', `Режим → ${mode}`);
  }

  /** Вектор скорости NED на duration мс (set_velocity); смещает модель. */
  async setVelocity(vx: number, vy: number, vz: number, durationMs: number): Promise<void> {
    [vx, vy, vz].forEach((v, i) => assertFinite(['vx', 'vy', 'vz'][i], v));
    const speed = Math.hypot(vx, vy, vz);
    if (speed > 30) throw new ValidationError(`Скорость ${speed.toFixed(1)} м/с физически нереализуема (макс. 30)`);
    if (durationMs <= 0 || durationMs > 60000) throw new ValidationError(`duration вне (0..60000]: ${durationMs}`);
    return this.withLock(() =>
      this.withRetry('set_velocity', async () => {
        this.requireConnection();
        if (!this.state.airborne) throw new HardwareError('Боевой аппарат на земле — velocity невозможен');
        const dtH = durationMs / 3600000; // м/с → град/час упрощённо
        this.state.lat += vy * dtH;
        this.state.lon += vx * dtH;
        this.state.altM = Math.max(0, Math.min(MAX_ALTITUDE_M, this.state.altM + vz * (durationMs / 1000)));
        this.drainBattery(speed * durationMs / 100000);
      }),
    );
  }

  /** Поворот по рысканию (set_yaw) с направлением и системой отсчёта. */
  async setYaw(angleDeg: number, clockwise = true, relative = false): Promise<void> {
    assertFinite('yaw', angleDeg);
    return this.withLock(() =>
      this.withRetry('set_yaw', async () => {
        this.requireConnection();
        const target = relative ? this.state.yawDeg + (clockwise ? angleDeg : -angleDeg) : angleDeg;
        this.state.yawDeg = normalizeAngle360(target);
      }),
    );
  }

  /** Экстренная остановка: Loiter + отключение нагрузки (emergency_stop). */
  async emergencyStop(): Promise<void> {
    return this.withLock(async () => {
      this.media.videoRecording = false;
      this.trackedTargetId = null;
      this.mission.status = 'aborted';
      if (this.state.airborne) this.setModeInternal('Loiter');
      this.pushLog('CRITICAL', 'EMERGENCY STOP: Loiter, нагрузка отключена');
    });
  }

  // ──────────────────────── Блок 3: цели и полезная нагрузка ────────────────────────

  /** Ручное указание цели (designate_target). */
  designateTarget(id: string, lat: number, lon: number, altM: number, priority: number, type: TargetType): void {
    validateGeoPoint(lat, lon);
    assertFinite('alt', altM);
    if (!['person', 'vehicle', 'structure'].includes(type)) throw new ValidationError(`Неизвестный тип цели: ${String(type)}`);
    if (!Number.isFinite(priority) || priority < 1 || priority > 5) throw new ValidationError(`Приоритет вне [1..5]: ${priority}`);
    this.targets.set(id, { lat, lon, altM, priority, type });
    this.pushLog('INFO', `Цель ${id} (${type}, приоритет ${priority}) назначена`);
  }

  /** Автослежение за целью (track_target); CV-интеграция — заглушка. */
  trackTarget(objectId: string): void {
    if (!this.targets.has(objectId)) throw new ValidationError(`Цель ${objectId} не зарегистрирована`);
    this.trackedTargetId = objectId;
    this.pushLog('INFO', `Автослежение за ${objectId}`);
  }

  /** Управление подвесом камеры (set_gimbal), углы нормализуются. */
  setGimbal(pitch: number, roll: number, yaw: number): void {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    if (![pitch, roll, yaw].every(Number.isFinite)) throw new ValidationError('Углы подвеса должны быть числами');
    this.gimbal = { pitch: clamp(pitch, -90, 90), roll: clamp(roll, -45, 45), yaw: normalizeAngle360(yaw) };
    this.pushLog('DEBUG', `Подвес: p=${this.gimbal.pitch} r=${this.gimbal.roll} y=${this.gimbal.yaw}`);
  }

  /** Разворот боевого аппарата и камеры на цель (point_camera_at_target). */
  pointCameraAtTarget(targetId: string): { yawDeg: number; gimbalPitchDeg: number } {
    const t = this.targets.get(targetId);
    if (!t) throw new ValidationError(`Цель ${targetId} не найдена`);
    const dLat = t.lat - this.state.lat;
    const dLon = t.lon - this.state.lon;
    const yaw = normalizeAngle360((Math.atan2(dLon, dLat) * 180) / Math.PI);
    const horiz = Math.hypot(dLat, dLon) * 111000;
    const dz = t.altM - this.state.altM;
    const pitch = Math.max(-90, Math.min(0, -(Math.atan2(dz, Math.max(horiz, 1)) * 180) / Math.PI));
    this.state.yawDeg = yaw;
    this.gimbal.pitch = pitch;
    this.pushLog('INFO', `Наведение на ${targetId}: yaw ${yaw.toFixed(1)}°, pitch ${pitch.toFixed(1)}°`);
    return { yawDeg: yaw, gimbalPitchDeg: pitch };
  }

  captureImage(): number {
    this.media.photos += 1;
    this.pushLog('INFO', `Фото №${this.media.photos}`);
    return this.media.photos;
  }

  startVideo(): void {
    if (this.media.videoRecording) throw new ValidationError('Видео уже пишется');
    this.media.videoRecording = true;
    this.pushLog('INFO', 'Видео: старт');
  }

  stopVideo(): void {
    if (!this.media.videoRecording) throw new ValidationError('Видео не пишется');
    this.media.videoRecording = false;
    this.pushLog('INFO', 'Видео: стоп');
  }

  /** Универсальная команда нагрузки (trigger_payload). */
  triggerPayload(payloadId: string, action: PayloadAction, params: Record<string, number> = {}): void {
    if (!payloadId.trim()) throw new ValidationError('payload_id пуст');
    const known: PayloadAction[] = ['release', 'siren_on', 'siren_off', 'laser_fire', 'laser_stop'];
    if (!known.includes(action)) throw new ValidationError(`Неизвестное действие нагрузки: ${String(action)}`);
    if (action === 'laser_fire' && !(params.power ?? 1)) throw new ValidationError('Лазер: требуется power > 0');
    this.pushLog('INFO', `Нагрузка ${payloadId}: ${action} ${JSON.stringify(params)}`);
  }

  // ──────────────────────── Блок 4: безопасность и геозоны ────────────────────────

  /** Виртуальный забор (set_geofence); полигон проверяется на замкнутость. */
  setGeofence(polygon: Array<{ lat: number; lon: number }>, actionOnBreach: GeofenceAction): void {
    if (polygon.length < 4) throw new ValidationError('Геозона: минимум 3 вершины + замыкание');
    const first = polygon[0];
    const last = polygon[polygon.length - 1];
    if (first.lat !== last.lat || first.lon !== last.lon) throw new ValidationError('Полигон геозоны не замкнут');
    polygon.forEach((p) => validateGeoPoint(p.lat, p.lon));
    const acts: GeofenceAction[] = ['report', 'loiter', 'rtl', 'land'];
    if (!acts.includes(actionOnBreach)) throw new ValidationError(`Действие при выходе недопустимо: ${String(actionOnBreach)}`);
    this.geofence = { polygon, actionOnBreach };
    this.pushLog('INFO', `Геозона задана (${polygon.length - 1} вершин, ${actionOnBreach})`);
  }

  /** Запретная зона (add_adiz_zone) cylinder/polygon/sphere. */
  addAdizZone(zone: Omit<AdizZone, 'ceilingM'> & { ceilingM?: number }): string {
    const shapes: AdizShape[] = ['cylinder', 'polygon', 'sphere'];
    if (!shapes.includes(zone.shape)) throw new ValidationError(`Форма ADIZ недопустима: ${String(zone.shape)}`);
    if ((zone.shape === 'cylinder' || zone.shape === 'sphere') && !(zone.radiusM && zone.center)) {
      throw new ValidationError('Для cylinder/sphere нужны center и radiusM');
    }
    if (zone.shape === 'polygon' && (!zone.polygon || zone.polygon.length < 3)) {
      throw new ValidationError('Для polygon нужно >=3 вершин');
    }
    const id = zone.id || `adiz-${Date.now()}`;
    this.adizZones.push({ ...zone, id, ceilingM: zone.ceilingM ?? MAX_ALTITUDE_M });
    this.pushLog('INFO', `ADIZ ${id} (${zone.shape}) добавлена`);
    return id;
  }

  /** Пороги батарейных failsafe (set_failsafe_battery). */
  setFailsafeBattery(levelRtl: number, levelLand: number, levelCritical: number): void {
    if (!(levelCritical < levelLand && levelLand < levelRtl && levelRtl <= 100 && levelCritical >= 0)) {
      throw new ValidationError(`Пороги должны быть 0 ≤ crit < land < rtl ≤ 100, получено ${levelCritical}/${levelLand}/${levelRtl}`);
    }
    this.failsafes.battery = { rtlPct: levelRtl, landPct: levelLand, criticalPct: levelCritical };
    this.pushLog('INFO', `Failsafe батареи: ${levelRtl}/${levelLand}/${levelCritical}%`);
  }

  /** Реакция на потерю GCS (set_failsafe_gcs). */
  setFailsafeGcs(timeoutSec: number, action: GeofenceAction): void {
    if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 600) throw new ValidationError(`timeout вне [1..600] с: ${timeoutSec}`);
    if (!['report', 'loiter', 'rtl', 'land'].includes(action)) throw new ValidationError(`Действие недопустимо: ${String(action)}`);
    this.failsafes.gcs = { timeoutSec, action };
  }

  /** Реакция на потерю GPS (set_failsafe_gps). */
  setFailsafeGps(lossAction: 'land' | 'loiter' | 'rtl'): void {
    if (!['land', 'loiter', 'rtl'].includes(lossAction)) throw new ValidationError(`gps loss action недопустим: ${String(lossAction)}`);
    this.failsafes.gpsLossAction = lossAction;
  }

  /** Мониторинг батареи: ETA до базы с учётом ветра/расстояния (monitor_battery_health). */
  monitorBatteryHealth(distanceToBaseM: number): { etaMin: number; batteryNeededPct: number; batteryNowPct: number; verdict: 'ok' | 'rtl' | 'land' | 'critical' } {
    if (!Number.isFinite(distanceToBaseM) || distanceToBaseM < 0) throw new ValidationError(`distance < 0: ${distanceToBaseM}`);
    const cruiseMs = 10;
    const effMs = Math.max(3, cruiseMs - this.state.windMs * 0.5);
    const etaMin = distanceToBaseM / effMs / 60;
    const needed = estimateBatteryFor(distanceToBaseM, this.state.windMs);
    const now = this.state.batteryPct;
    const f = this.failsafes.battery;
    const verdict = now <= f.criticalPct ? 'critical' : now <= f.landPct ? 'land' : now <= f.rtlPct || now < needed * 1.2 ? 'rtl' : 'ok';
    return { etaMin: Math.round(etaMin * 10) / 10, batteryNeededPct: Math.round(needed * 10) / 10, batteryNowPct: now, verdict };
  }

  /** Погодные лимиты (check_weather_limits): блокирует взлёт при выходе за рамки. */
  checkWeatherLimits(windMax: number, tempMin: number, tempMax: number): { ok: boolean; reason?: string } {
    if (windMax <= 0 || tempMin >= tempMax) throw new ValidationError('wind_max должен быть > 0, temp_min < temp_max');
    if (this.state.windMs > windMax) return { ok: false, reason: `Ветер ${this.state.windMs} > ${windMax} м/с` };
    if (this.state.tempC < tempMin || this.state.tempC > tempMax) {
      return { ok: false, reason: `Температура ${this.state.tempC}°C вне [${tempMin}; ${tempMax}]` };
    }
    return { ok: true };
  }

  // ──────────────────────── Блок 6: логирование и аналитика ────────────────────────

  /** Запись телеметрии (log_flight_data): frequency_hz — частота сэмплов. */
  logFlightData(telemetry: Telemetry[], frequencyHz: number): number {
    if (!Number.isFinite(frequencyHz) || frequencyHz <= 0 || frequencyHz > 100) {
      throw new ValidationError(`frequency_hz вне (0..100]: ${frequencyHz}`);
    }
    telemetry.forEach((t) => validateGeoPoint(t.lat, t.lon));
    this.log.push(...telemetry.map((t) => ({ level: 'DEBUG' as LogLevel, message: `TLM ${t.lat},${t.lon},${t.altM}`, at: t.timestamp })));
    return telemetry.length;
  }

  /** Отчёт после полёта (generate_post_flight_report). */
  generatePostFlightReport(telemetry: Telemetry[]): { distanceM: number; durationMin: number; avgBatteryPctPerMin: number; maxAltM: number } {
    if (telemetry.length < 2) throw new ValidationError('Нужно минимум 2 записи телеметрии');
    let dist = 0;
    let maxAlt = 0;
    for (let i = 1; i < telemetry.length; i++) {
      dist += haversineM(telemetry[i - 1], telemetry[i]);
      maxAlt = Math.max(maxAlt, telemetry[i].altM);
    }
    const t0 = Date.parse(telemetry[0].timestamp);
    const t1 = Date.parse(telemetry[telemetry.length - 1].timestamp);
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) throw new ValidationError('Некорректные временные метки');
    const durMin = (t1 - t0) / 60000;
    const dBatt = telemetry[0].batteryPct - telemetry[telemetry.length - 1].batteryPct;
    return {
      distanceM: Math.round(dist),
      durationMin: Math.round(durMin * 10) / 10,
      avgBatteryPctPerMin: Math.round((dBatt / durMin) * 100) / 100,
      maxAltM: maxAlt,
    };
  }

  /** Поиск аномалий (detect_anomalies): падения высоты, скачки GPS, резкие крены. */
  detectAnomalies(telemetry: Telemetry[]): string[] {
    const out: string[] = [];
    for (let i = 1; i < telemetry.length; i++) {
      const a = telemetry[i - 1];
      const b = telemetry[i];
      const jump = haversineM(a, b);
      if (jump > 200) out.push(`Скачок GPS на ${i}: ${Math.round(jump)} м`);
      if (a.altM - b.altM > 20) out.push(`Резкое падение высоты на ${i}: ${(a.altM - b.altM).toFixed(0)} м`);
      const tilt = Math.abs(normalizeAngle360(b.yawDeg) - normalizeAngle360(a.yawDeg));
      if (Math.min(tilt, 360 - tilt) > 90) out.push(`Резкий разворот на ${i}: ${Math.round(Math.min(tilt, 360 - tilt))}°`);
    }
    return out;
  }

  /** Данные для воспроизведения (replay_mission). */
  replayMission(telemetry: Telemetry[]): Array<{ t: number; lat: number; lon: number; altM: number }> {
    if (!telemetry.length) return [];
    const t0 = Date.parse(telemetry[0].timestamp);
    return telemetry.map((s) => ({ t: (Date.parse(s.timestamp) - t0) / 1000, lat: s.lat, lon: s.lon, altM: s.altM }));
  }

  // ──────────────────────── Блок 1 (выполнение): миссия ────────────────────────

  loadMission(missionId: string): void {
    this.mission = { missionId, wpIndex: 0, status: 'running' };
    this.pushLog('INFO', `Миссия ${missionId} загружена`);
  }

  pauseMission(): void {
    if (this.mission.status !== 'running') throw new ValidationError('Миссия не выполняется');
    this.mission.status = 'paused';
    this.pushLog('INFO', 'Миссия приостановлена');
  }

  resumeMission(): void {
    if (this.mission.status !== 'paused') throw new ValidationError('Миссия не на паузе');
    this.mission.status = 'running';
    this.pushLog('INFO', 'Миссия продолжена');
  }

  skipTacticalNode(): number {
    if (this.mission.status !== 'running') throw new ValidationError('Миссия не выполняется');
    this.mission.wpIndex += 1;
    this.pushLog('WARNING', `Пропущена точка ${this.mission.wpIndex - 1}`);
    return this.mission.wpIndex;
  }

  startMission(): void {
    if (this.mission.status === 'idle') throw new ValidationError('Сначала загрузите миссию');
    this.mission.status = 'running';
  }

  missionState(): MissionExecutionState {
    return { ...this.mission };
  }

  private drainBattery(pct: number): void {
    this.state.batteryPct = Math.max(0, Math.round((this.state.batteryPct - pct) * 10) / 10);
  }
}

/** Валидация гео-точки; бросает ValidationError. */
export function validateGeoPoint(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new ValidationError(`Широта вне [-90; 90]: ${lat}`);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new ValidationError(`Долгота вне [-180; 180]: ${lon}`);
}

/** Расстояние по гаверсинусу, м. */
export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Оценка расхода батареи (%) на расстояние с поправкой на встречный ветер. */
export function estimateBatteryFor(distanceM: number, windMs: number): number {
  const base = distanceM / 1000; // условный расход: 1% на км
  const penalty = 1 + Math.max(0, windMs) * 0.04;
  return base * 8 * penalty; // 8%/км крейсерски
}

// ──────────────────────── Блок 5: управление парком ────────────────────────

export interface CombatAssetUnit {
  assetId: string;
  connectionString: string;
  capabilities: string[];
}

/** Реестр парка боевых аппаратов (register_combat_asset / assign / auto_assign / formation / handoff). */
export class FleetManager {
  private combatAssets = new Map<string, CombatAssetUnit>();
  private assignments = new Map<string, string>(); // targetId -> assetId

  registerCombatAsset(assetId: string, connectionString: string, capabilities: string[]): void {
    if (!assetId.trim()) throw new ValidationError('asset_id пуст');
    if (!/^[\w.-]+@[\w.-]+(:\d+)?$/.test(connectionString)) throw new ValidationError(`Некорректный connection_string: ${connectionString}`);
    if (!capabilities.length) throw new ValidationError('capabilities пусты');
    this.combatAssets.set(assetId, { assetId, connectionString, capabilities });
  }

  listCombatAssets(): CombatAssetUnit[] {
    return [...this.combatAssets.values()];
  }

  assignCombatAssetToTarget(assetId: string, targetId: string): void {
    if (!this.combatAssets.has(assetId)) throw new ValidationError(`Боевой аппарат ${assetId} не зарегистрирован`);
    this.assignments.set(targetId, assetId);
  }

  /** Автоназначение целей: greedy по расстоянию (аналог hungarian для малых n). */
  autoAssignTargets(targets: Array<{ id: string; lat: number; lon: number }>, combatAssets: Array<{ assetId: string; lat: number; lon: number }>): Array<{ targetId: string; assetId: string; costM: number }> {
    if (!targets.length || !combatAssets.length) return [];
    targets.forEach((t) => validateGeoPoint(t.lat, t.lon));
    const free = new Set(combatAssets.map((d) => d.assetId));
    const pairs: Array<{ targetId: string; assetId: string; costM: number }> = [];
    const sorted = [...targets].sort((a, b) => a.id.localeCompare(b.id));
    for (const t of sorted) {
      let best: { assetId: string; costM: number } | null = null;
      for (const d of combatAssets) {
        if (!free.has(d.assetId)) continue;
        const c = haversineM(t, d);
        if (!best || c < best.costM) best = { assetId: d.assetId, costM: c };
      }
      if (!best) break; // боевые аппараты кончились
      free.delete(best.assetId);
      pairs.push({ targetId: t.id, ...best });
      this.assignments.set(t.id, best.assetId);
    }
    return pairs;
  }

  /** Построение роя (sync_fleet_formations): координаты членов формации вокруг центра. */
  syncFleetFormation(count: number, formation: FormationType, spacingM: number, center: { lat: number; lon: number }): Array<{ index: number; lat: number; lon: number }> {
    if (count < 1 || count > 20) throw new ValidationError(`count вне [1..20]: ${count}`);
    if (!['line', 'v_shape', 'grid'].includes(formation)) throw new ValidationError(`Формация недопустима: ${String(formation)}`);
    if (!Number.isFinite(spacingM) || spacingM <= 0 || spacingM > 1000) throw new ValidationError(`spacing вне (0..1000] м: ${spacingM}`);
    validateGeoPoint(center.lat, center.lon);
    const degPerM = 1 / 111000;
    const out: Array<{ index: number; lat: number; lon: number }> = [];
    for (let i = 0; i < count; i++) {
      let dx = 0;
      let dy = 0;
      if (formation === 'line') dx = i * spacingM;
      else if (formation === 'v_shape') {
        dx = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * spacingM;
        dy = Math.ceil(i / 2) * spacingM;
      } else {
        const side = Math.ceil(Math.sqrt(count));
        dx = (i % side) * spacingM;
        dy = Math.floor(i / side) * spacingM;
      }
      out.push({ index: i, lat: center.lat + dy * degPerM, lon: center.lon + dx * degPerM });
    }
    return out;
  }

  /** Передача цели между боевого аппаратами (handoff_target). */
  handoffTarget(fromAsset: string, toAsset: string, targetId: string): void {
    if (this.assignments.get(targetId) !== fromAsset) throw new ValidationError(`Цель ${targetId} не назначена боевому аппарату ${fromAsset}`);
    if (!this.combatAssets.has(toAsset)) throw new ValidationError(`Боевой аппарат ${toAsset} не зарегистрирован`);
    this.assignments.set(targetId, toAsset);
  }

  assignmentFor(targetId: string): string | undefined {
    return this.assignments.get(targetId);
  }
}
