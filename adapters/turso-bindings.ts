import type { Value } from "../src/contract.ts";
/** This SDK guesses INTEGER for integral JS numbers and exposes no typed REAL
 * binder. Refuse that domain before execution instead of changing storage class. */
export function validateTursoBindings(params: Value[]): void {
  if (
    params.some(
      (v) =>
        typeof v === "number" && (!Number.isFinite(v) || Number.isInteger(v)),
    )
  )
    throw Error(
      "unsupported Turso REAL binding: use bigint for INTEGER or a SQL literal/CAST for integral REAL",
    );
}
