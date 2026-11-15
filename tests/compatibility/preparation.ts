import assert from "node:assert/strict";
import type { LogicDriver } from "./sqllogictest.ts";
import {
  preparationSetup,
  preparationState,
  preparationCases,
} from "./preparation-cases.ts";

export function verifyPreparationErrors(
  oracle: LogicDriver,
  candidate: LogicDriver,
): number {
  for (const driver of [oracle, candidate])
    for (const sql of preparationSetup) driver.execute(sql);
  const before = oracle.query(preparationState);
  for (const { sql, error } of preparationCases) {
    for (const driver of [oracle, candidate]) {
      assert.throws(() => driver.execute(sql), new RegExp(error), sql);
      assert.deepEqual(
        driver.query(preparationState),
        before,
        `state after ${sql}`,
      );
    }
  }
  return preparationCases.length;
}
