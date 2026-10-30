// Регрессионные тесты ФАЗА 2 (п.3): CSV Formula Injection protection
// Опасные значения (=CMD, +..., -..., @...) при открытии экспорта в Excel/Sheets
// раньше исполнялись как формулы. Теперь: принудительное кавычование + префикс '.
import { describe, it, expect } from 'vitest';
import { toCsv } from '../src/utils/csv';
import { exportToCSV } from '../src/utils/export';
import type { Marker } from '../src/types';

const marker = (over: Partial<Marker>): Marker => ({
  id: 'm1', name: 'Точка', x: 10, y: 20, lat: null, lon: null,
  type: 'default', color: '#00ff00', comment: '', layer: 'l1', createdAt: '2026-01-01', ...over,
});

describe('CSV Formula Injection (экспорт)', () => {
  it.each(['=', '+', '-', '@'])('значение с префиксом "%s" экранируется префиксом \' и кавычками', (prefix) => {
    const payload = `${prefix}HYPERLINK("http://evil","click")`;
    const out = toCsv([['name'], [payload]]);
    const cell = out.split('\r\n')[1];
    expect(cell.startsWith(`'"`)).toBe(true); // ' + quoted
    expect(cell).toContain(payload.replace(/"/g, '""'));
  });

  it('безобидные значения остаются без изменений (нет лишних кавычек)', () => {
    expect(toCsv([['hello', 'world']])).toBe('hello;world');
  });

  it('маркер с вредоносным именем/комментарием не попадает в CSV как формула', () => {
    const csv = exportToCSV([marker({ name: '=SUM(A1:A9)', comment: `-1+1+cmd|'C:\\evil'!A0` })]);
    const dataLine = csv.split('\r\n')[1];
    // Опасные значения получают префикс ' ПЕРЕД кавычками: `'"=SUM(A1:A9)"`
    expect(dataLine).toContain(`'"=SUM(A1:A9)"`);
    expect(dataLine).toContain(`'"-1+1+cmd|'C:\\evil'!A0"`);
    // Прямая проверка: после разделителя никогда не стоит «голый» опасный префикс
    const fields = dataLine.match(/(?:^|;)(?:"[^"]*"|[^;]*)/g) ?? [];
    for (const f of fields) {
      const value = f.startsWith(';') ? f.slice(1) : f;
      if (!value.startsWith('"')) {
        expect(/^[=+\-@\t\r]/.test(value)).toBe(false);
      }
    }
  });

  it('табуляция в начале поля тоже считается опасной (DDE-вектор)', () => {
    const out = toCsv([['\t=1+1']]);
    // Формат защиты: префикс ' ставится ПЕРЕД кавычованным полем (OWASP CSV): `"\t=1+1"` -> `'"\t=1+1"`
    expect(out.startsWith("'\"")).toBe(true);
    expect(out).toBe("'\"\t=1+1\"");
  });
});
