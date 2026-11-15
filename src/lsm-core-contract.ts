/** Narrow typed boundary around generated MoonBit handles (whose emitted d.ts
 * currently uses `any`). Generated representation stays private. */
export interface Block {
  readonly __lsmBlock: unique symbol;
}
export interface LsmCore {
  lsm_new(): Block;
  lsm_put(
    block: Block,
    key: string,
    sequence: number,
    value: Uint8Array,
    deleted: boolean,
  ): string;
  lsm_encode(block: Block): Uint8Array;
  lsm_decode(bytes: Uint8Array): Block;
  lsm_info(block: Block): string;
  lsm_count(block: Block): number;
  lsm_size(block: Block): number;
  lsm_key(block: Block, index: number): string;
  lsm_sequence(block: Block, index: number): number;
  lsm_deleted(block: Block, index: number): boolean;
  lsm_value(block: Block, index: number): Uint8Array;
  lsm_seek(block: Block, key: string): number;
  lsm_merge(a: Block, b: Block): Block;
  lsm_slice(block: Block, start: number, count: number): Block;
}
