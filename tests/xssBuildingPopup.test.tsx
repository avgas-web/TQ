// Регрессионный тест ФАЗА 2 (XSS): попап здания из Overpass/OSM обязан
// рендериться чистыми React-компонентами без dangerouslySetInnerHTML.
// Вредоносные строки в тегах OSM (building, height, building:levels) не должны
// создавать DOM-элементы (img/script) — только экранированный текст.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import BuildingPopupCard from '../src/components/wizard/BuildingPopupCard';
import type { BuildingInfo } from '../src/utils/buildingLookup';

const MALICIOUS: BuildingInfo = {
  heightStr: '<img src=x onerror=alert(1)> м',
  levelsStr: '</div><script>alert(document.cookie)</script>',
  typeStr: '" onload="fetch(\'//evil\')',
};

describe('BuildingPopupCard: XSS-безопасность (ФАЗА 2)', () => {
  it('вредоносные теги OSM рендерятся как текст, DOM-инъекция невозможна', () => {
    const { container } = render(<BuildingPopupCard building={MALICIOUS} />);

    // Попап на месте (стабильный testid сохранён при рефакторинге)
    expect(screen.getByTestId('building-popup-card')).toBeTruthy();

    // Ни одного внедрённого элемента: никаких img/script-узлов в DOM.
    // (innerHTML содержит «onerror» только как ЭКРАНИРОВАННЫЙ текст
    // &lt;img src=x onerror=...&gt; — это и есть доказательство безопасности.)
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelectorAll('[onerror]').length).toBe(0);
    expect(container.innerHTML).not.toContain('<img');
    expect(container.innerHTML).not.toContain('<script');
    expect(container.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');

    // Злонамеренная строка видна пользователю как обычный текст (экранирована)
    const card = screen.getByTestId('building-popup-card');
    expect(card.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(card.textContent).toContain('</div><script>alert(document.cookie)</script>');
    expect(card.textContent).toContain(`" onload="fetch('//evil')`);
  });

  it('в src больше нет генератора HTML-попапа buildingPopupHtml', async () => {
    const mod = await import('../src/utils/buildingLookup');
    expect((mod as Record<string, unknown>).buildingPopupHtml).toBeUndefined();
  });
});
