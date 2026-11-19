import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoon } from "../scripts/generate-sqlike-packages.ts";

test(
  "MoonBit generation formats large source inputs with EOF and preserves formatter idempotence",
  { timeout: 35_000 },
  () => {
    const source = Array.from(
      { length: 12_000 },
      (_, i) => `///|\nfn generated_${i}(a : Int) -> Int { a + ${i} }\n`,
    ).join("\n");
    assert.ok(Buffer.byteLength(source) > 600_000);
    const formatted = formatMoon(source);
    assert.equal((formatted.match(/fn generated_/g) ?? []).length, 12_000);
    assert.match(formatted, /fn generated_11999\(/);
    assert.equal(formatMoon(formatted), formatted);
  },
);
