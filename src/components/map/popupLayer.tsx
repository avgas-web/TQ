/**
 * Popup-слой карты (Фаза 5.C, вынесен из MapCanvas.tsx).
 *
 * Регрессия по аудиту (Фаза 2.1): попап рендерится чистыми React-компонентами,
 * БЕЗ dangerouslySetInnerHTML — любые строки из внешних API (Overpass/OSM)
 * попадают в DOM только как текстовые узлы и не могут исполниться.
 */
import { memo } from "react";

export interface PopupData {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

interface MapObjectPopupProps {
  popup: PopupData | null;
  /** Ширина canvas в CSS-пикселях — для clamp положения у правого края. */
  canvasWidth: number;
  /** Высота canvas в CSS-пикселях — для clamp положения у нижнего края. */
  canvasHeight: number;
  onClose: () => void;
}

/**
 * Позиционирование совпадает с оригиналом из MapCanvas: смещение +12px от
 * точки клика и clamp в пределах canvas (отступы 270/120 — запас под размеры
 * попапа и «клик — закрыть»).
 */
export const MapObjectPopup = memo(function MapObjectPopup({
  popup,
  canvasWidth,
  canvasHeight,
  onClose,
}: MapObjectPopupProps) {
  if (!popup) return null;
  return (
    <div
      className="absolute z-20 max-w-[260px] rounded-lg bg-gray-900/95 border border-cyan-500/50 text-gray-100 text-xs shadow-xl p-2 pointer-events-auto"
      style={{
        left: Math.min(popup.x + 12, canvasWidth - 270),
        top: Math.min(popup.y + 12, canvasHeight - 120),
      }}
      onClick={onClose}
    >
      <div className="font-bold text-cyan-300 mb-1">{popup.title}</div>
      {popup.lines.map((l, i) => (
        <div key={i} className="leading-relaxed">
          {l}
        </div>
      ))}
      <div className="text-gray-400 mt-1">клик — закрыть</div>
    </div>
  );
});
