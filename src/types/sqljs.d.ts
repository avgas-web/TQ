// Минимальные декларации для sql.js (WASM SQLite): библиотека не поставляет
// полноценные типы в dist, импортируется динамически через any-мосты.
declare module 'sql.js' {
  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }
  export interface Database {
    exec(sql: string): QueryExecResult[];
    run(sql: string, params?: unknown[]): void;
    prepare(sql: string): Statement;
    close(): void;
    free?(): void;
  }
  export interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  }
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | null) => Database;
  }
  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
    wasmBinary?: ArrayBuffer | Uint8Array;
  }
  const initSqlJs: (config?: SqlJsConfig) => Promise<SqlJsStatic>;
  export default initSqlJs;
}
