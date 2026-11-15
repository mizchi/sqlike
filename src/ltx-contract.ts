import type { LtxFile } from "./ltx.ts";
import type { ReplicaState } from "./contract.ts";

export interface LtxCatalogFile extends LtxFile { sha256: string }
export interface LtxCatalog {
  format: 3;
  epoch: string;
  minRevision: number;
  targetTXID: string;
  files: LtxCatalogFile[];
}
export interface LtxCursor extends ReplicaState { epoch: string; endpoint: string; image: string; sha256: string }
