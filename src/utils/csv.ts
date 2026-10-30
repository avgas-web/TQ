// Безопасный CSV-модуль (ФАЗА 2, п.3)
// - Сериализатор с полным кавычованием по RFC 4180 и защитой от Formula Injection
//   (поля, начинающиеся с =, +, -, @, Tab, CR, получают префикс ').
// - Парсер на конечном автомате (FSM): поддерживает CRLF/LF, BOM, многострочные
//   поля в кавычках, удвоенные кавычки внутри значений, любой односимвольный разделитель.

/** Опасные префиксы ячеек: табличные процессоры (Excel/Sheets) интерпретируют их как формулы. */
const FORMULA_INJECTION_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export interface CsvSerializeOptions {
  /** Разделитель полей. По умолчанию ';' (исторический формат TotalQuadro). */
  delimiter?: string;
  /** Экранирование опасных префиксов ('=SUM(...)' -> "'=SUM(...)"). По умолчанию true. */
  escapeFormulaInjection?: boolean;
}

export interface CsvParseOptions {
  /** Разделитель полей. По умолчанию ';'. */
  delimiter?: string;
}

function needsQuoting(field: string, delimiter: string): boolean {
  return (
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes('\n') ||
    field.includes('\r')
  );
}

function quoteField(field: string, delimiter: string): string {
  // RFC 4180: кавычки внутри значения удваиваются, поле оборачивается в кавычки.
  return '"' + field.replace(/"/g, '""') + '"';
}

/**
 * Защита от CSV Formula Injection: если значение начинается с опасного символа,
 * принудительно кавычуем и добавляем префикс `'`, чтобы Excel/Sheets не вычисляли формулу.
 */
function sanitizeCell(value: string, delimiter: string, escapeInjection: boolean): string {
  const dangerous =
    escapeInjection && FORMULA_INJECTION_PREFIXES.some((p) => value.startsWith(p));
  if (dangerous || needsQuoting(value, delimiter)) {
    const quoted = quoteField(value, delimiter);
    return dangerous ? "'" + quoted : quoted;
  }
  return value;
}

/**
 * Сериализация строк таблицы в CSV-текст (RFC 4180 + защита от инъекций).
 * undefined/null значения превращаются в пустую строку.
 */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>, options: CsvSerializeOptions = {}): string {
  const delimiter = options.delimiter ?? ';';
  const escapeInjection = options.escapeFormulaInjection ?? true;
  return rows
    .map((row) =>
      row.map((cell) => sanitizeCell(cell == null ? '' : String(cell), delimiter, escapeInjection)).join(delimiter)
    )
    .join('\r\n');
}

const enum ParseState {
  StartOfField,
  InUnquoted,
  InQuoted,
  QuoteInQuoted,

}

/**
 * Парсинг CSV-текста конечным автоматом по RFC 4180.
 * Поддержка: BOM (\uFEFF), CRLF/LF/CR переводы строк, кавычки, "" внутри значений,
 * многострочные поля. Пустые строки-разделители пропускаются только если они
 * реально пустые (не содержат полей из одного пустого значения при заданном delimiter).
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): string[][] {
  const delimiter = options.delimiter ?? ';';
  if (delimiter.length !== 1) {
    throw new Error('CsvParseOptions.delimiter must be a single character');
  }

  // Убираем UTF-8 BOM
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: ParseState = ParseState.StartOfField;
  let rowHasContent = false; // различать "пустая строка" и 'строка из одной пустой ячейки'

  const pushField = () => {
    row.push(field);
    field = '';
    rowHasContent = true;
  };

  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    rowHasContent = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    switch (state) {
      case ParseState.StartOfField:
        if (ch === '"') {
          state = ParseState.InQuoted;
          rowHasContent = true;
        } else if (ch === delimiter) {
          pushField();
        } else if (ch === '\r') {
          if (src[i + 1] === '\n') i++;
          if (rowHasContent || field !== '') pushRow();
        } else if (ch === '\n') {
          if (rowHasContent || field !== '') pushRow();
        } else {
          field += ch;
          state = ParseState.InUnquoted;
        }
        break;

      case ParseState.InUnquoted:
        if (ch === delimiter) {
          pushField();
          state = ParseState.StartOfField;
        } else if (ch === '\r') {
          if (src[i + 1] === '\n') i++;
          pushRow();
          state = ParseState.StartOfField;
        } else if (ch === '\n') {
          pushRow();
          state = ParseState.StartOfField;
        } else {
          field += ch;
        }
        break;

      case ParseState.InQuoted:
        if (ch === '"') {
          state = ParseState.QuoteInQuoted;
        } else {
          field += ch; // включая \n/\r — многострочные поля допустимы RFC 4180
        }
        break;

      case ParseState.QuoteInQuoted:
        if (ch === '"') {
          field += '"'; // "" -> литеральная кавычка
          state = ParseState.InQuoted;
        } else if (ch === delimiter) {
          pushField();
          state = ParseState.StartOfField;
        } else if (ch === '\r') {
          if (src[i + 1] === '\n') i++;
          pushRow();
          state = ParseState.StartOfField;
        } else if (ch === '\n') {
          pushRow();
          state = ParseState.StartOfField;
        } else {
          // Некорректная кавычка (данные после закрытия) — толерантно добавляем как есть.
          field += ch;
          state = ParseState.InUnquoted;
        }
        break;


    }
  }

  // Финальное поле/строка
  if (state !== ParseState.StartOfField || field !== '' || rowHasContent) {
    pushRow();
  }

  return rows;
}
