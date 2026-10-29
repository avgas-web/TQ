// ─── MiniMapPanel: отдельное окно карты (старт / весь маршрут / цель) ────────
// Полностью автономная панель со строгой Web-Mercator привязкой:
//   worldPx = canvasHeight·2^zoom, screen = geoFrac·worldPx + centerOffset.
// ПРИНЦИП ОТОБРАЖЕНИЯ КАРТЫ — КАК В РЕЖИМЕ ПЛАНИРОВАНИЯ (MapCanvas): подложка
// рисуется НЕ на canvas, а DOM-слоем настоящих <img>-тайлов с одним CSS
// transform (utils/tileDomLayer — прямой перенос positionTileLayer/syncTileDom
// большой карты). Canvas поверх слоя — только оверлеи (маршруты, зоны, точки),
// позиционированные по ТОЙ ЖЕ формуле привязки ⇒ объекты «приклеены» к подложке.
// Это устраняет дефекты прежней canvas-сетки drawImage: субпиксельные швы,
// размытие при дробном зуме и «кривую загрузку» в режиме мастера.
// Зум колесом/кнопками, панорама перетаскиванием — в любых пределах z3..z19+.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeTileServer } from '../utils/openStreetMap';
import type { TileServerId } from '../utils/openStreetMap';
import { createTileDomLayer, type TileDomLayer } from '../utils/tileDomLayer';
import {
  PanelView, PanelViewBox, viewBox, geoToScreenPx, screenPxToGeo, zoomPanelAt, panPanelBy,
  metersPerPixel, fitView, panelViewOf, GROUND_MPP_1CM_2KM,
} from '../utils/pannelli';

export interface MiniOverlayPoint { lat: number; lng: number; label?: string; color?: string; id?: string }
export interface MiniOverlayLine { pts: { lat: number; lng: number }[]; color?: string; width?: number; dashed?: boolean }

interface MiniMapPanelProps {
  title: string;
  icon: string;
  /** Центр вида по умолчанию (гео) */
  center: { lat: number; lng: number };
  /** Стартовый зум; если задан fitPoints — он перекрывает center+zoom */
  zoom?: number;
  /** Точки для авто-вписывания вида (например весь маршрут) */
  fitPoints?: { lat: number; lng: number }[];
  minZoom?: number;
  maxZoom?: number;
  points?: MiniOverlayPoint[];
  lines?: MiniOverlayLine[];
  height?: number | string;
  onReady?: () => void;
  /** Режим «фокус»: панель активна для редактирования (принимает клики) */
  focused?: boolean;
  /** Вызывается при фокусировке панели (клик по неактивной панели) */
  onFocus?: () => void;
  /** Клик по карте панели → гео-координаты (для добавления точек маршрута и т.п.) */
  onMapClick?: (geo: { lat: number; lng: number; panelIdx?: number }) => void;
  /** Индекс панели (0 старт / 1 маршрут / 2 цель) — для маршрутизации кликов */
  panelIdx?: number;
  /** Ограничения/зоны, привязанные к этой панели (рисуются поверх тайлов).
   *  radiusM — радиус круга в метрах; pts — полигон по гео-точкам. */
  zones?: MiniZone[];
  /** Клик ПО точечному оверлею (удаление точки/объекта): id + тип + гео-позиция */
  onPointClick?: (id: string) => void;
  /** Разрешено ли удаление точек кликом по ✛ (в режиме ограничений — false) */
  pointDeleteEnabled?: boolean;
  /** Перетащили точку оверлея → новое гео-положение (редактирование маршрута) */
  onPointMove?: (id: string, lat: number, lng: number) => void;
  /** Drag точки ВЕРТИКАЛЬНО = регулировка высоты этапа этой точки (AGL, м).
   *  Вызывается при перетаскивании с зажатым Shift. */
  onPointAltitudeDrag?: (id: string, dyPx: number) => void;
  /** Клик по ✛-метке зоны (удаление объекта ограничения) */
  onZoneClick?: (id: string) => void;
  /** Двойной клик по свободной карте панели (замыкание полигона NFZ-черновика) */
  onPanelDoubleClick?: () => void;
  /** Стиль подложки — рабочий тайловый провайдер из стора (Esri по умолчанию).
   *  Панели мастера обязаны использовать ТОТ ЖЕ стиль, что и большая карта
   *  (аудит audit/index.fixed.html: tile.openstreetmap.org удалён — 403 по Referer). */
  tileServer?: TileServerId | 'osm' | 'carto';
}

/** Зоны для отрисовки: с опциональным id (для удаления кликом) */
export interface MiniZone { pts: { lat: number; lng: number }[]; color?: string; radiusM?: number; centerGeo?: { lat: number; lng: number }; id?: string }

/** Обратное преобразование экран→гео для панели (нужно для кликов редактирования).
 *  Реализация — screenPxToGeo из pannelli.ts (единый источник математики вида:
 *  центр канваса как точка отсчёта, vb.hpx для оси Y); раньше здесь лежала
 *  копия функции — потенциальное расхождение прямой/обратной привязок. */
export const screenPxToGeoPanel = (vb: PanelViewBox, sx: number, sy: number, canvasW: number, canvasH: number) =>
  screenPxToGeo(sx, sy, vb, canvasW, canvasH);

const MiniMapPanel: React.FC<MiniMapPanelProps> = ({
  title, icon, center, zoom = 11, fitPoints, minZoom = 3, maxZoom = 20,
  points = [], lines = [], height = 260, onReady,
  focused = false, onFocus, onMapClick, panelIdx = -1, zones = [], onPointClick, pointDeleteEnabled = true, onPointMove, onPointAltitudeDrag, onZoneClick,
  onPanelDoubleClick,
  tileServer = 'esri',
}) => {
  // Рабочий провайдер (legacy 'osm'/'carto' нормализуются) — смена стиля должна
  // сбрасывать слой; нативный максимум провайдера учитывает сам tileDomLayer.
  const serverId: TileServerId = normalizeTileServer(tileServer);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tileHostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // DOM-слой тайлов (создаётся один раз на монтирование; живёт внутри tileHostRef)
  const layerRef = useRef<TileDomLayer | null>(null);
  const serverRef = useRef<TileServerId | 'osm' | 'carto'>(tileServer);
  useEffect(() => { serverRef.current = tileServer; }, [tileServer]);
  const [size, setSize] = useState({ w: 320, h: typeof height === 'number' ? height : 260 });
  const sizeRef = useRef(size);
  useEffect(() => { sizeRef.current = size; }, [size]);

  // Вид панели — локальный ref (не трогает глобальный viewState основного канваса).
  const viewRef = useRef<PanelView>({ zoom, fx: (center.lng + 180) / 360, fy: 0.5 - Math.log((1 + Math.sin(center.lat * Math.PI / 180)) / (1 - Math.sin(center.lat * Math.PI / 180))) / (4 * Math.PI) });
  const [, forceTick] = useState(0);
  const tickRef = useRef(0);
  const bump = useCallback(() => { tickRef.current++; forceTick(tickRef.current); }, []);

  // ─── ФИКС «карта не отображается / отображается криво» (режим мастера) ──────
  // ПРЕДЫДУЩАя версия (d64604d) добавляла «однократную корректировку стартового
  // зума» под аспект окна (z += log2(refSide/maxSide)) — она расходилась с
  // реальным аспектом канваса после ResizeObserver'а, и гео-область вида
  // оказывалась вырезанной/смещённой («загрузка есть, а отображения нет»).
  // Теперь база привязки ЕДИНАЯ для обоих режимов и НЕ зависит от ширины окна
  // (viewBox: worldPx = canvasHeight·2^zoom), поэтому стартовый зум prop
  // применяется как есть — никаких пересчётов и перехватов пользовательского
  // жеста не требуется.
  const startZoomForCurrentSize = useCallback((): number => {
    return Math.max(minZoom, Math.min(maxZoom, zoom));
  }, [minZoom, maxZoom, zoom]);

  // ─── Авто-фокус на введённых данных ─────────────────────────────────────────
  // Панель загружается сразу (центр/зум по умолчанию), а при вводе пользователем
  // данных плавно перемещается к ним: точка старта/цели или весь маршрут.
  // Пользовательская панорама/зум НЕ перехватывается — авто-центрирование срабатывает
  // только когда меняются сами данные (или после смены фокуса панели).
  const animRef = useRef<number | null>(null);
  const animateTo = useCallback((target: PanelView) => {
    if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    const start = { ...viewRef.current };
    const t0 = performance.now();
    const DUR = 450;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / DUR);
      const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
      viewRef.current = {
        zoom: start.zoom + (target.zoom - start.zoom) * e,
        fx: start.fx + (target.fx - start.fx) * e,
        fy: start.fy + (target.fy - start.fy) * e,
      };
      bump();
      if (k < 1) animRef.current = requestAnimationFrame(step);
      else animRef.current = null;
    };
    animRef.current = requestAnimationFrame(step);
  }, [bump]);
  useEffect(() => () => { if (animRef.current !== null) cancelAnimationFrame(animRef.current); }, []);

  // Ключ внешних данных для отслеживания изменений.
  // ВАЖНО (баг «фокусировка сбивается при постановке ограничения»): зоны и
  // линии НЕ входят в ключ — их добавление/удаление не должно перетягивать
  // камеру. Авто-наведение срабатывает только при изменении самих точек
  // (center / fitPoints / точки оверлеев).
  const dataKey = [
    center.lat.toFixed(5), center.lng.toFixed(5), zoom.toFixed(2),
    fitPoints ? `${fitPoints.length}:${fitPoints.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|')}` : '0',
    points.map((p) => `${p.id || ''}@${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|'),
  ].join('#');
  const lastDataKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const first = lastDataKeyRef.current === null;
    if (lastDataKeyRef.current === dataKey) return;
    lastDataKeyRef.current = dataKey;
    // Стартовый вид при первом эффекте — база привязки единая для любого
    // аспекта окна (viewBox: worldPx = canvasHeight·2^zoom), пересчёт зума
    // под аспект больше не нужен.
    if (fitPoints && fitPoints.length > 0) {
      const aspect = sizeRef.current.w > 0 && sizeRef.current.h > 0 ? sizeRef.current.w / sizeRef.current.h : 1.5;
      const v = fitView(fitPoints, aspect, minZoom, maxZoom);
      if (v) { if (first) { viewRef.current = v; bump(); } else { animateTo(v); } }
    } else {
      const v = panelViewOf(center.lat, center.lng, startZoomForCurrentSize());
      if (first) { viewRef.current = v; bump(); } else { animateTo(v); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey]);

  // При взятии панели в фокус — автоматически навести вид на её данные
  const focusedForAnimRef = useRef(focused);
  useEffect(() => {
    if (focused && !focusedForAnimRef.current) {
      if (fitPoints && fitPoints.length > 0) {
        const aspect = sizeRef.current.w > 0 && sizeRef.current.h > 0 ? sizeRef.current.w / sizeRef.current.h : 1.5;
        const v = fitView(fitPoints, aspect, minZoom, maxZoom);
        if (v) animateTo(v);
      } else {
        animateTo(panelViewOf(center.lat, center.lng, startZoomForCurrentSize()));
      }
    }
    focusedForAnimRef.current = focused;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  // Размер контейнера
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(120, Math.round(r.width)), h: Math.max(120, Math.round(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Перерисовка кадров: canvas — ТОЛЬКО оверлеи (подложка — DOM-слой <img>).
  const drawAll = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = sizeRef.current;
    const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Канвас прозрачен: подложку показывает DOM-слой тайлов ПОД ним (принцип
    // режима планирования). fillRect здесь закрасил бы карту.
    ctx.clearRect(0, 0, w, h);

    const v = viewRef.current;
    // Подложка — синхронизация DOM-слоя (позиция + набор <img>), как syncTileDom
    // большой карты. Вызывается из этого же effect'а (не из rAF-колбэков), поэтому
    // безопасен прямой setState-путём bump() через onload слоя (очередь внутри).
    layerRef.current?.sync(v);
    const vb = viewBox(v, w, h);

    // Линии (маршруты)
    for (const ln of lines) {
      if (ln.pts.length < 2) continue;
      ctx.save();
      ctx.strokeStyle = ln.color || '#22d3ee';
      ctx.lineWidth = ln.width || 2.5;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (ln.dashed) ctx.setLineDash([7, 5]);
      // Crisp-линии: полупиксельный сдвиг ВНУТРИ save/restore — только для
      // штриха линии; hit-позиции оверлеев (рисуются отдельно) не смещаются.
      ctx.translate(0.5, 0.5);
      ctx.beginPath();
      ln.pts.forEach((p, i) => {
        const s = geoToScreenPx(p.lat, p.lng, vb, w, h);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
      ctx.restore();
    }

    // Зоны ограничений (для панели в режиме редактирования).
    // radiusM — радиус в МЕТРАХ (передаётся вызывающим кодом), рисуется точно
    // через масштаб панели (м/пиксель с учётом широты).
    const zoneHits: { id?: string; x: number; y: number; r: number }[] = [];
    for (const zn of zones) {
      ctx.save();
      ctx.strokeStyle = zn.color || 'rgba(248,113,113,0.9)';
      ctx.fillStyle = 'rgba(248,113,113,0.13)';
      ctx.lineWidth = 1.5;
      if (zn.radiusM && zn.centerGeo) {
        const c = geoToScreenPx(zn.centerGeo.lat, zn.centerGeo.lng, vb, w, h);
        const mppPanel = metersPerPixel(v.zoom, mercLatOf(v));
        const rScreen = zn.radiusM / Math.max(mppPanel, 1e-9);
        ctx.translate(0.5, 0.5); // crisp stroke (внутри save/restore, hit-позиции не смещаются)
        ctx.beginPath(); ctx.arc(c.x, c.y, Math.min(rScreen, 4000), 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        zoneHits.push({ id: zn.id, x: c.x, y: c.y, r: Math.min(rScreen, 4000) });
      } else if (zn.pts.length >= 2) {
        let cxSum = 0, cySum = 0;
        ctx.translate(0.5, 0.5); // crisp stroke (внутри save/restore, hit-позиции не смещаются)
        ctx.beginPath();
        zn.pts.forEach((p, i) => {
          const s = geoToScreenPx(p.lat, p.lng, vb, w, h);
          cxSum += s.x; cySum += s.y;
          if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath(); ctx.fill(); ctx.stroke();
        zoneHits.push({ id: zn.id, x: cxSum / zn.pts.length, y: cySum / zn.pts.length, r: 16 });
      }
      ctx.restore();
    }

    // Точки (старт/цели дронов/узлы боевого курса). Позиции сохраняются для hit-теста
    // клика удаления (наведи и кликни по точке на активной карте — удалим).
    const pointHits: { id?: string; x: number; y: number }[] = [];
    for (const pt of points) {
      const s = geoToScreenPx(pt.lat, pt.lng, vb, w, h);
      pointHits.push({ id: pt.id, x: s.x, y: s.y });
      ctx.save();
      ctx.beginPath(); ctx.arc(s.x, s.y, focused ? 7 : 6, 0, Math.PI * 2);
      ctx.fillStyle = pt.color || '#facc15'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#0f1729'; ctx.stroke();
      if (focused && pt.id) {
        // крестик удаления поверх точки активной карты (подсказка «клик = удалить»)
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(s.x - 3, s.y - 3); ctx.lineTo(s.x + 3, s.y + 3);
        ctx.moveTo(s.x + 3, s.y - 3); ctx.lineTo(s.x - 3, s.y + 3);
        ctx.stroke();
      }
      if (pt.label) {
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const tw = ctx.measureText(pt.label).width;
        ctx.fillStyle = 'rgba(15,23,41,0.85)';
        ctx.fillRect(s.x + 9, s.y - 8, tw + 8, 16);
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(pt.label, s.x + 13, s.y);
      }
      ctx.restore();
    }

    // Сохраняем позиции оверлеев для hit-теста клика удаления (см. onUp)
    hitsRef.current = { pointHits, zoneHits };

    // Плашка масштаба (фактический текущий)
    const mpp = metersPerPixel(v.zoom, mercLatOf(v));
    // м на 1 см ЭКРАНА: 1 см = 96/2.54 css-px ⇒ m1cm = mpp·37.795
    const m1cm = mpp * (96 / 2.54);
    const txt = m1cm >= 1000 ? `1 см ≈ ${(m1cm / 1000).toFixed(1)} км` : m1cm >= 1 ? `1 см ≈ ${m1cm.toFixed(m1cm < 10 ? 1 : 0)} м` : `1 см ≈ ${Math.round(m1cm * 100)} см`;
    ctx.save();
    ctx.font = '10px sans-serif';
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(15,23,41,0.8)';
    ctx.fillRect(6, h - 22, tw + 12, 16);
    ctx.fillStyle = '#7dd3fc';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, 12, h - 14);
    // масштабная линейка: отрезок ровно 1 см экрана (37.795 css-px) — подпись слева
    // показывает, сколько метров на местности в него помещается (при 1см=2км это ~100px при mpp≈52.9)
    // длина линейки ~1 см эталонного масштаба в текущих px: при mpp==GROUND_MPP_1CM_2KM это ровно 1 см экрана
    const barPx = Math.max(20, Math.min(140, (GROUND_MPP_1CM_2KM / Math.max(mpp, 1e-9)) * (96 / 2.54)));
    ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(w - barPx - 10, h - 14); ctx.lineTo(w - 10, h - 14); ctx.stroke();
    ctx.restore();
  }, [lines, points, zones, bump, focused]);

  // ─── DOM-слой тайлов (ПРИНЦИП РЕЖИМА ПЛАНИРОВАНИЯ) ──────────────────────────
  // Создаётся один раз на монтирование панели; синхронизируется в drawAll.
  // getView/getSize/getServer — живые ref'ы, поэтому слой всегда видит актуальный
  // вид/размер/провайдер без пересоздания (как замыкания tileLayer в MapCanvas).
  useEffect(() => {
    const host = tileHostRef.current;
    if (!host) return;
    const layer = createTileDomLayer(
      host,
      () => viewRef.current,
      () => sizeRef.current,
      () => serverRef.current,
    );
    layerRef.current = layer;
    layer.sync(viewRef.current);
    return () => {
      // unmount-safe: довести число ЖИВЫХ загрузок до нуля (тест wizardFreeze),
      // удалить DOM-элементы слоя и обнулить ссылку (drawAll после cleanup — no-op)
      layer.abortAll();
      layer.reset();
      host.querySelectorAll('div[aria-hidden="true"]').forEach((n) => n.remove());
      if (layerRef.current === layer) layerRef.current = null;
    };
  }, []);

  // Смена стиля подложки — полный сброс слоя + перерисовка кадра оверлеев
  // (сам слой инвалидирует набор <img> внутри sync по смене getServer()).
  useEffect(() => {
    layerRef.current?.reset();
    bump();
  }, [serverId, bump]);

  function mercLatOf(v: PanelView): number {
    const nn = Math.PI - 2 * Math.PI * v.fy;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(nn) - Math.exp(-nn)));
  }

  // Перерисовка на каждый тик/ресайз
  useEffect(() => { drawAll(); }, [drawAll, size, tickRef.current]);

  // Управление: wheel (не-passive!), touch, кнопки зума + клики редактирования
  const focusedRef = useRef(focused);
  useEffect(() => { focusedRef.current = focused; }, [focused]);
  const onMapClickRef = useRef(onMapClick);
  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);
  const panelIdxRef = useRef(panelIdx);
  useEffect(() => { panelIdxRef.current = panelIdx; }, [panelIdx]);
  const onFocusRef = useRef(onFocus);
  useEffect(() => { onFocusRef.current = onFocus; }, [onFocus]);
  const onPointClickRef = useRef(onPointClick);
  useEffect(() => { onPointClickRef.current = onPointClick; }, [onPointClick]);
  const pointDeleteEnabledRef = useRef(pointDeleteEnabled);
  useEffect(() => { pointDeleteEnabledRef.current = pointDeleteEnabled; }, [pointDeleteEnabled]);
  const onPointMoveRef = useRef(onPointMove);
  useEffect(() => { onPointMoveRef.current = onPointMove; }, [onPointMove]);
  const onPointAltitudeDragRef = useRef(onPointAltitudeDrag);
  useEffect(() => { onPointAltitudeDragRef.current = onPointAltitudeDrag; }, [onPointAltitudeDrag]);
  const onZoneClickRef = useRef(onZoneClick);
  useEffect(() => { onZoneClickRef.current = onZoneClick; }, [onZoneClick]);
  const onPanelDoubleClickRef = useRef(onPanelDoubleClick);
  useEffect(() => { onPanelDoubleClickRef.current = onPanelDoubleClick; }, [onPanelDoubleClick]);
  // Позиции оверлеев с последнего кадра — для hit-теста клика удаления
  const hitsRef = useRef<{ pointHits: { id?: string; x: number; y: number }[]; zoneHits: { id?: string; x: number; y: number; r: number }[] }>({ pointHits: [], zoneHits: [] });
  // Идентификатор точки, которую перетаскиваем (редактирование маршрута drag-ом)
  const draggingPtRef = useRef<string | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rectOf = () => canvas.getBoundingClientRect();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = rectOf();
      viewRef.current = zoomPanelAt(viewRef.current, e.deltaY < 0 ? 1.25 : 1 / 1.25, e.clientX - r.left, e.clientY - r.top, sizeRef.current.w, sizeRef.current.h, minZoom, maxZoom);
      bump();
    };
    let drag: { x: number; y: number; moved: boolean } | null = null;
    // Alt-drag точки = регулировка высоты этапа: накапливаем смещение по Y
    // и каждые ~12 px вызываем onPointAltitudeDrag(id, dy).
    let altAccumPx = 0;
    const toScreen = (clientX: number, clientY: number) => {
      const r = rectOf();
      const { w, h } = sizeRef.current;
      return { sx: (clientX - r.left) * (w / Math.max(1, r.width)), sy: (clientY - r.top) * (h / Math.max(1, r.height)) };
    };
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, moved: false };
      canvas.setPointerCapture?.(e.pointerId);
      // Хит-тест по точкам: клик/начало drag ТОЧНО по точке НЕ должно pan-ить карту
      const { sx, sy } = toScreen(e.clientX, e.clientY);
      const hit = [...hitsRef.current.pointHits].reverse().find((p) => p.id && (p.x - sx) ** 2 + (p.y - sy) ** 2 <= 144);
      draggingPtRef.current = hit?.id ?? null;
      altAccumPx = 0;
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      drag = { x: e.clientX, y: e.clientY, moved: drag.moved };
      // Alt-drag по точке оверлея — регулировка ВЫСОТЫ этапа этой точки
      // (вверх = выше AGL, вниз = ниже). Карта при этом не панорамится.
      if (draggingPtRef.current && e.altKey && onPointAltitudeDragRef.current) {
        altAccumPx -= dy; // экранная Y вниз → уменьшаем высоту
        while (altAccumPx >= 12) { altAccumPx -= 12; onPointAltitudeDragRef.current(draggingPtRef.current, +12); }
        while (altAccumPx <= -12) { altAccumPx += 12; onPointAltitudeDragRef.current(draggingPtRef.current, -12); }
        return;
      }
      // Drag точки маршрута/цели: карта стоит, точка «прилипает» к курсору
      if (draggingPtRef.current && drag.moved && onPointMoveRef.current) {
        const { w, h } = sizeRef.current;
        const vb = viewBox(viewRef.current, w, h);
        const { sx, sy } = toScreen(e.clientX, e.clientY);
        const geo = screenPxToGeoPanel(vb, sx, sy, w, h);
        onPointMoveRef.current(draggingPtRef.current, geo.lat, geo.lng);
        return;
      }
      if (draggingPtRef.current) return;
      viewRef.current = panPanelBy(viewRef.current, dx, dy, sizeRef.current.w, sizeRef.current.h);
      bump();
    };
    const onUp = (e: PointerEvent) => {
      const wasDrag = drag?.moved;
      const downX = drag ? drag.x : e.clientX;
      const downY = drag ? drag.y : e.clientY;
      drag = null;
      const draggedId = draggingPtRef.current;
      draggingPtRef.current = null;
      // Перетащили точку → она уже обновляется в onMove; клик не генерируем
      if (wasDrag) { if (draggedId) bump(); return; }
      // Клик (без перетаскивания): любой панели разрешено редактирование —
      // фокус + удаление/добавление объектов работают во ВСЕХ окнах сразу.
      const r = rectOf();
      const { w, h } = sizeRef.current;
      const sc = toScreen(e.clientX, e.clientY);
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (sx < 0 || sy < 0 || sx > r.width || sy > r.height) return;
      const vb = viewBox(viewRef.current, w, h);
      // Приоритет: клик ТОЧНО по точке/объекту или зоне на карте = УДАЛИТЬ её.
      // ВАЖНО: проверка хитов выполняется ДО onFocus — иначе клик по ✛ точки
      // сначала поднимает панель вкладкой наверх, канвас пересоздаётся и
      // указатель «теряется» (удаление не срабатывает, фокус сбивается).
      if (sc.sx >= 0 && sc.sy >= 0 && sc.sx <= w && sc.sy <= h) {
        const hitPt = [...hitsRef.current.pointHits].reverse().find((p) => p.id && (p.x - sc.sx) ** 2 + (p.y - sc.sy) ** 2 <= 144);
        if (hitPt?.id) {
          // В режиме «Установка ограничений» клик по точке НЕ удаляет её —
          // удаление доступно в режиме «Редактирование маршрута»
          if (pointDeleteEnabledRef.current) onPointClickRef.current?.(hitPt.id);
          return;
        }
        const hitZn = [...hitsRef.current.zoneHits].reverse().find((z) => z.id && ((z.x - sc.sx) ** 2 + (z.y - sc.sy) ** 2 <= Math.min(z.r, 60) ** 2));
        if (hitZn?.id) { onZoneClickRef.current?.(hitZn.id); return; }
      }
      // Простой клик по свободному месту этой же карты (панорама не двигалась) —
      // добавляем объект без смены вкладки/фокуса: это сохраняет текущую
      // фокусировку всех окон (клик по нижней панели сначала активирует её).
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) <= 3 && !focusedRef.current) {
        onFocusRef.current?.();
        return;
      }
      if (onMapClickRef.current) {
        const geo = screenPxToGeoPanel(vb, sc.sx, sc.sy, w, h);
        const idx = panelIdxRef.current;
        onMapClickRef.current(idx >= 0 ? ({ ...geo, panelIdx: idx } as typeof geo) : geo);
      }
    };
    const onDblClick = (e: MouseEvent) => {
      // Двойной клик по свободной карте панели — замыкание полигона NFZ.
      // Нативный dblclick идёт ПОСЛЕ двух pointerup (дважды сработал onMapClick),
      // поэтому здесь только закрываем черновик зоны, без добавления точки.
      e.preventDefault();
      onPanelDoubleClickRef.current?.();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('dblclick', onDblClick);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('dblclick', onDblClick);
    };
  }, [bump, minZoom, maxZoom]);

  const zoomBy = (f: number) => {
    viewRef.current = zoomPanelAt(viewRef.current, f, size.w / 2, size.h / 2, size.w, size.h, minZoom, maxZoom);
    bump();
  };
  const recenter = () => {
    if (fitPoints && fitPoints.length > 0) {
      const aspect = size.w / Math.max(1, size.h);
      const v = fitView(fitPoints, aspect, minZoom, maxZoom);
      if (v) { animateTo(v); return; }
    }
    animateTo(panelViewOf(center.lat, center.lng, startZoomForCurrentSize()));
  };

  useEffect(() => { onReady?.(); /* панель готова к экспорту PNG */ }, [onReady, size]);

  const btn = 'w-7 h-7 flex items-center justify-center rounded bg-gray-800/90 hover:bg-gray-700 text-gray-100 border border-gray-600 text-sm select-none';
  return (
    <div
      className={`rounded-lg overflow-hidden ${focused ? 'border-2 border-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.35)]' : 'border border-gray-700'}`}
      style={{ height }}
    >
      <div className="flex items-center gap-2 px-2 py-1 border-b border-gray-700 bg-gray-800/60">
        <span className="text-xs font-bold text-cyan-300">{icon} {title}</span>
        {focused && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-800/80 text-emerald-100 border border-emerald-500 animate-pulse">✏️ клик по карте — добавить · клик по ✛ точки/зоны — удалить</span>}
        <div className="flex-1" />
        <button className={btn} title="Приблизить" onClick={() => zoomBy(1.5)}>＋</button>
        <button className={btn} title="Отдалить" onClick={() => zoomBy(1 / 1.5)}>－</button>
        <button className={btn} title="Вписать объект / сбросить вид" onClick={recenter}>⌂</button>
      </div>
      <div ref={wrapRef} className="relative w-full" style={{ height: `calc(100% - 30px)` }}>
        {/* Подложка карты — DOM-слой <img>-тайлов (принцип режима планирования,
            utils/tileDomLayer). Хост ниже канваса в стопке; pointer-events отключены
            на слое — все события принимает прозрачный canvas оверлеев поверх. */}
        <div ref={tileHostRef} className="absolute inset-0 overflow-hidden bg-[#0f1729]" aria-hidden="true" />
        <canvas ref={canvasRef} style={{ position: 'relative', zIndex: 1, width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor: focused && onMapClick ? 'crosshair' : 'grab' }} aria-label={`Карта: ${title}`} />
      </div>
    </div>
  );
};

export default MiniMapPanel;
