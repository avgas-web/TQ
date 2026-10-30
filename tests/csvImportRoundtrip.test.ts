// Регрессионные тесты ФАЗА 2 (п.3): импорт CSV через FSM-парсер (RFC 4180).
// Старый line-based парсер (split('\n') + ручной разбор кавычек) терял данные:
// многострочное поле разрезалось на два «маркера», CRLF оставлял \r в значениях,
// BOM попадал в имя первого маркера, а нечисловые координаты становились NaN.
import { describe, it, expect } from "vitest";
import { importFromCSV, exportToCSV } from "../src/utils/export";
import type { Marker } from "../src/types";

const marker = (over: Partial<Marker>): Marker => ({
  id: "m1",
  name: "Точка",
  x: 10,
  y: 20,
  lat: null,
  lon: null,
  type: "default",
  color: "#00ff00",
  comment: "",
  layer: "l1",
  createdAt: "2026-01-01",
  ...over,
});

describe("importFromCSV: FSM-парсер вместо line-based (регрессии)", () => {
  it("многострочный комментарий НЕ создаёт фантомный второй маркер", () => {
    const csv =
      'name;x;y;lat;lon;type;comment\r\n"КП Восток";5;6;55.75;37.62;target;"строка1\r\nстрока2"\r\n';
    const markers = importFromCSV(csv);
    expect(markers.length).toBe(1); // старый парсер давал бы 2
    expect(markers[0].name).toBe("КП Восток");
    expect(markers[0].comment).toBe("строка1\r\nстрока2");
  });

  it("CRLF не оставляет символ \\r в полях", () => {
    const csv = "name;x;y\r\nAlpha;1;2\r\nBeta;3;4\r\n";
    const markers = importFromCSV(csv);
    expect(markers.map((m) => m.name)).toEqual(["Alpha", "Beta"]);
    expect(markers[1].name).not.toContain("\r");
  });

  it("UTF-8 BOM не попадает в заголовок/данные", () => {
    const csv = "\uFEFFname;x;y\r\nGamma;7;8\r\n";
    const markers = importFromCSV(csv);
    expect(markers.length).toBe(1);
    expect(markers[0].name).toBe("Gamma");
  });

  it("нечисловые координаты -> null, а не NaN (тихая порча данных)", () => {
    const csv = "name;x;y;lat;lon\r\nPoint;abc;def;xx;yy\r\n";
    const markers = importFromCSV(csv);
    expect(markers[0].x).toBe(0);
    expect(Number.isNaN(markers[0].x as number)).toBe(false);
    expect(markers[0].lat).toBeNull();
    expect(markers[0].lon).toBeNull();
  });

  it("снимает защитный префикс formula injection при импорте собственного экспорта", () => {
    const markers = [
      marker({
        id: "1",
        name: "=SUM(A1:A9)",
        comment: "-1+1+cmd|'C:\\evil'!A0",
      }),
    ];
    const restored = importFromCSV(exportToCSV(markers));
    expect(restored.length).toBe(1);
    expect(restored[0].name).toBe("=SUM(A1:A9)");
    expect(restored[0].comment).toBe(`-1+1+cmd|'C:\\evil'!A0`);
  });

  it("полный round-trip: экспорт -> импорт сохраняет все поля", () => {
    const src = [
      marker({
        id: "1",
        name: 'А; "Б"',
        comment: "x\ny;z",
        lat: 59.9386,
        lon: 30.3141,
      }),
      marker({ id: "2", name: "Plain", x: 1, y: 2, lat: null, lon: null }),
    ];
    const restored = importFromCSV(exportToCSV(src));
    expect(restored.length).toBe(2);
    expect(restored[0].name).toBe('А; "Б"');
    expect(restored[0].comment).toBe("x\ny;z");
    expect(restored[0].lat).toBeCloseTo(59.9386);
    expect(restored[0].lon).toBeCloseTo(30.3141);
    expect(restored[1].lat).toBeNull();
  });
});
