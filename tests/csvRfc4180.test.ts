// Регрессионные тесты ФАЗА 2 (п.3): RFC 4180-совместимый CSV (парсер-FSM)
import { describe, it, expect } from 'vitest';
import { parseCsv, toCsv } from '../src/utils/csv';
import { exportToCSV, importFromCSV } from '../src/utils/export';
import type { Marker } from '../src/types';

const marker = (over: Partial<Marker>): Marker => ({
  id: 'm1', name: 'Точка', x: 10, y: 20, lat: null, lon: null,
  type: 'default', color: '#00ff00', comment: '', layer: 'l1', createdAt: '2026-01-01', ...over,
});

describe('parseCsv: конечный автомат по RFC 4180', () => {
  it('многострочное поле в кавычках НЕ разбивает строку (регрессия line-based парсера)', () => {
    const rows = parseCsv('a;b\r\n"x\ny";2\r\n', { delimiter: ';' });
    expect(rows).toEqual([['a', 'b'], ['x\ny', '2']]);
  });

  it('удвоенные кавычки внутри значения -> одна литеральная кавычка', () => {
    expect(parseCsv('"he said ""hi""";b', { delimiter: ';' })).toEqual([['he said "hi"', 'b']]);
  });

  it('разделитель внутри кавычек не режет поле', () => {
    expect(parseCsv('"a;b";c', { delimiter: ';' })).toEqual([['a;b', 'c']]);
  });

  it('UTF-8 BOM в начале файла игнорируется', () => {
    expect(parseCsv('\uFEFFa;b')).toEqual([['a', 'b']]);
  });

  it('поддержка LF, CRLF и одиночного CR как переводов строк', () => {
    expect(parseCsv('a\r\nb\rc\nd')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('пустые поля сохраняют позицию колонок', () => {
    expect(parseCsv('a;;c')).toEqual([['a', '', 'c']]);
  });

  it('trailing newline не создаёт фантомную пустую строку', () => {
    expect(parseCsv('a;b\r\n')).toEqual([['a', 'b']]);
  });
});

describe('toCsv/parseCsv: round-trip', () => {
  it('экспорт->импорт сохраняет маркеры с ;, кавычками и переносами строк', () => {
    const markers = [
      marker({ id: '1', name: 'КП; "Восток"', comment: 'стр1\nстр2; проверено' }),
      marker({ id: '2', name: 'Обычная', lat: 55.75, lon: 37.62 }),
    ];
    const csv = exportToCSV(markers);
    const restored = importFromCSV(csv);
    expect(restored.length).toBe(2);
    expect(restored[0].name).toBe('КП; "Восток"');
    expect(restored[0].comment).toBe('стр1\nстр2; проверено');
    expect(restored[1].lat).toBe(55.75);
    expect(restored[1].lon).toBe(37.62);
  });

  it('round-trip через toCsv с запятой как разделителем', () => {
    const rows = [['a,b', 'c"d'], ['e\nf', 'plain']];
    expect(parseCsv(toCsv(rows, { delimiter: ',' }), { delimiter: ',' })).toEqual(rows);
  });
});
