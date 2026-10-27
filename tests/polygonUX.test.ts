/**
 * ПРОБЛЕМА 6: UX рисования полигонов/NFZ.
 * Проверяем DOM-подсказки Toolbar, последовательность "инструмент -> 3 клика -> завершение",
 * store-экшены undo/redo и наличие preview-резина в сторе (cursorPosition).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import Toolbar from '../src/components/Toolbar';
import { useStore } from '../src/store/useStore';

beforeEach(() => {
  cleanup();
  const s = useStore.getState();
  s.clearDrawingPoints();
  s.setTool('pan');
});

describe('Toolbar: инструменты и подсказки', () => {
  it('кнопка NFZ имеет tooltip с инструкцией по завершению', () => {
    render(React.createElement(Toolbar));
    const btn = screen.getByTitle(/NFZ|бесполетная/i) as HTMLElement;
    expect(btn.getAttribute('title')).toMatch(/двойной клик/i);
  });

  it('выбор инструмента "NFZ" переключает currentTool из Toolbar', () => {
    render(React.createElement(Toolbar));
    const btn = screen.getByTitle(/NFZ|бесполетная/i);
    fireEvent.click(btn);
    expect(useStore.getState().currentTool).toBe('drawPolygon');
  });
});

describe('Последовательность: инструмент -> 3 клика -> завершение', () => {
  it('три addDrawingPoint + Enter-путь (addRestriction) создаёт полигон из 3 вершин', () => {
    const st = useStore.getState();
    st.setTool('drawPolygon');
    st.addDrawingPoint({ x: 10, y: 10, lat: 0, lon: 0 } as never);
    st.addDrawingPoint({ x: 50, y: 10, lat: 0, lon: 0 } as never);
    st.addDrawingPoint({ x: 50, y: 60, lat: 0, lon: 0 } as never);
    expect(useStore.getState().drawingPoints.length).toBe(3);

    // Завершение (то же, что делает dblclick/Enter):
    useStore.getState().addRestriction({ type: 'polygon', points: [...useStore.getState().drawingPoints] } as never);
    useStore.getState().clearDrawingPoints();

    const restrictions = useStore.getState().project.restrictions ?? [];
    const poly = restrictions.find((r) => r.type === 'polygon' && (r.points?.length ?? 0) >= 3);
    expect(poly).toBeDefined();
    expect(useStore.getState().drawingPoints.length).toBe(0);
  });

  it('undoDrawingPoint убирает последнюю вершину (Ctrl+Z), redo возвращает', () => {
    const st = useStore.getState();
    st.setTool('drawPolygon');
    st.addDrawingPoint({ x: 1, y: 1, lat: 0, lon: 0 } as never);
    st.addDrawingPoint({ x: 2, y: 2, lat: 0, lon: 0 } as never);
    expect(useStore.getState().drawingPoints.length).toBe(2);
    useStore.getState().undoDrawingPoint();
    expect(useStore.getState().drawingPoints.length).toBe(1);
    useStore.getState().redoDrawingPoint();
    expect(useStore.getState().drawingPoints.length).toBe(2);
  });

  it('Esc-путь: clearDrawingPoints отменяет незавершённый рис', () => {
    const st = useStore.getState();
    st.setTool('drawPolygon');
    st.addDrawingPoint({ x: 3, y: 3, lat: 0, lon: 0 } as never);
    useStore.getState().clearDrawingPoints();
    expect(useStore.getState().drawingPoints.length).toBe(0);
  });

  it('cursorPosition в сторе обновляется для rubber-band превью', () => {
    useStore.getState().setCursorPosition({ x: 42, y: 24, lat: 0, lon: 0 } as never);
    expect(useStore.getState().cursorPosition).toMatchObject({ x: 42, y: 24 });
  });
});
