declare module "*sqlike/sqlike.js" {
  /** Opaque MoonBit handle; representation is private to the generated module. */
  export interface MoonConnection {
    readonly __moonConnection: unique symbol;
  }
  export function database_is_readonly(sql: string): boolean;
  export function database_autocommit(db: MoonConnection): boolean;
  export function database_set_clock(db: MoonConnection, milliseconds: string): string;
  export function database_changeset(
    db: MoonConnection,
    before: MoonConnection,
  ): string;
  export function database_clone(db: MoonConnection): MoonConnection;
  export function database_serial(db: MoonConnection): number;
  export function database_import_sqlite_base64(
    db: MoonConnection,
    image: string,
  ): string;
  export function database_import_sqlite(
    db: MoonConnection,
    image: Uint8Array,
  ): string;
  export function database_query_values(
    db: MoonConnection,
    sql: string,
    bindings: string,
  ): string;
  export function database_exec_values(db: MoonConnection, sql: string, bindings: string): string;
  export function database_open(): MoonConnection;
  export function database_exec(
    db: MoonConnection,
    sql: string,
    bindings: string,
    readOnly: boolean,
  ): string;
  export function database_dump(db: MoonConnection): string;
  export function database_restore(db: MoonConnection, image: string): string;
  export function database_version(db: MoonConnection): number;
}
