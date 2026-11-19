declare module "*litestream/litestream.js" {
  export function encode_frame(
    kind: number,
    base: number,
    opId: string,
    payload: Uint8Array,
  ): Uint8Array;
  export function decode_frame(data: Uint8Array): string;
  export function decode_changeset(data: Uint8Array): string;
  export function plan_changes(changes: string, schema: string): string;
  export function revision_decision(
    head: number,
    base: number,
    kind: number,
    duplicate: boolean,
  ): string;
  export function sql_allowed(sql: string): boolean;
  export interface LtxResult {
    readonly __ltxResult: unique symbol;
  }
  export function encode_ltx_pages(
    state: string,
    metadata: string,
    data: Uint8Array,
  ): LtxResult;
  export function encode_ltx_pages_base64(
    state: string,
    metadata: string,
    data: string,
  ): LtxResult;
  export function encode_ltx_pages_binary(
    state: string,
    metadata: string,
    data: Uint8Array,
    previous: Uint8Array,
  ): LtxResult;
  export function encode_ltx_pages_binary_base64(
    state: string,
    metadata: string,
    data: string,
    previous: string,
  ): LtxResult;
  export function encode_ltx(
    base: Uint8Array,
    data: Uint8Array,
    min: string,
    max: string,
    timestamp: string,
  ): LtxResult;
  export function encode_ltx_base64(
    base: string,
    data: string,
    min: string,
    max: string,
    timestamp: string,
  ): LtxResult;
  export function apply_ltx(
    base: Uint8Array,
    txid: string,
    file: Uint8Array,
    version: number,
  ): LtxResult;
  export function apply_ltx_base64(
    base: string,
    txid: string,
    file: string,
    version: number,
  ): LtxResult;
  export function ltx_data(result: LtxResult): Uint8Array<ArrayBuffer>;
  export function ltx_data_base64(result: LtxResult): string;
  export function ltx_info(result: LtxResult): string;
  export function plan_ltx(
    catalog: string,
    current: string,
    target: string,
  ): string;
  export function assess_apply(
    head: number,
    base: number,
    kind: number,
    sameDatabase: boolean,
    sameSchema: boolean,
    matchingAssertions: boolean,
    matchingEffects: boolean,
  ): string;
  export function note_policy(context: string): string;
}
