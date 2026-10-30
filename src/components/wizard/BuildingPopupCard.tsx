// BuildingPopupCard — React-рендер попапа «высота здания» (Overpass/OSM).
// ФАЗА 2 (Безопасность/XSS): заменил dangerouslySetInnerHTML + buildingPopupHtml().
// Данные из внешнего API (теги OSM: building, height, building:levels) могут
// содержать произвольные строки (`<img src=x onerror=...>`); React экранирует
// текстовые узлы автоматически, поэтому инъекция markup/скриптов невозможна.
import React from 'react';
import type { BuildingInfo } from '../../utils/buildingLookup';

export interface BuildingPopupCardProps {
  building: BuildingInfo;
}

/** Чистый React-аналог разметки эталонного Leaflet-кода (класс .building-popup). */
const BuildingPopupCard: React.FC<BuildingPopupCardProps> = ({ building }) => (
  <div className="building-popup" data-testid="building-popup-card">
    <div>
      <b>Высота:</b> {building.heightStr}
    </div>
    <div>
      <b>Этажей:</b> {building.levelsStr}
    </div>
    <div>
      <b>Тип:</b> {building.typeStr}
    </div>
  </div>
);

export default BuildingPopupCard;
