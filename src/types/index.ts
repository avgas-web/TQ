// Типы для TotalQuadro Coordinate Marker

export interface Point {
  x: number;
  y: number;
}

export interface Marker {
  id: string;
  name: string;
  x: number;
  y: number;
  lat: number | null;
  lon: number | null;
  type: string;
  color: string;
  comment: string;
  layer: string;
  createdAt: string;
}

export interface Restriction {
  id: string;
  type: 'rectangle' | 'polygon' | 'circle';
  points: Point[]; // For polygon/rectangle: vertices; for circle: [center, edge]
  radius?: number; // For circle
  color: string;
  name: string;
  active: boolean;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
}

export interface CalibrationPoint {
  pixelX: number;
  pixelY: number;
  lat: number;
  lon: number;
}

export interface MapBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface MapData {
  name: string;
  width: number;
  height: number;
  dataUrl: string;
  bounds?: MapBounds; // Географические границы карты
  source?: 'local' | 'google'; // Источник карты
}

export interface Project {
  version: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  map: MapData | null;
  calibration: {
    enabled: boolean;
    points: CalibrationPoint[];
  };
  restrictions: Restriction[];
  markers: Marker[];
  layers: Layer[];
  settings: {
    showGrid: boolean;
    gridSize: number;
    showCoordinates: boolean;
    theme: 'dark' | 'light';
  };
  googleMaps: {
    apiKey: string;
    enabled: boolean;
  };
}

export type Tool = 'pan' | 'select' | 'addMarker' | 'drawRect' | 'drawPolygon' | 'drawCircle' | 'measure';

export interface ViewState {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export interface Measurement {
  points: Point[];
  distance: number; // in pixels
}
