import { createHash } from "node:crypto";
import { isDeepStrictEqual, inspect } from "node:util";
import type { Value } from "../../src/contract.ts";
export type LogicRecord =
  | { kind: "statement"; line: number; sql: string; error: boolean }
  | {
      kind: "query";
      line: number;
      sql: string;
      types: string;
      sort: "nosort" | "rowsort" | "valuesort";
      expected: string[];
      hash?: { count: number; md5: string };
    };
export interface LogicDriver {
  execute(sql: string): void;
  query(sql: string): Value[][];
}
/** Parse the original format strictly: unknown directives fail, never skip SQL
 * because a candidate happens not to implement it. */
export function parseLogicTest(source: string): LogicRecord[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const records: LogicRecord[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.trim() || lines[i]!.startsWith("#")) {
      i++;
      continue;
    }
    const line = i + 1,
      header = lines[i++]!.trim().split(/\s+/);
    const sql: string[] = [];
    if (header[0] === "statement") {
      if (header.length !== 2 || !["ok", "error"].includes(header[1]!))
        throw Error(`invalid statement at ${line}`);
      while (i < lines.length && lines[i]!.trim()) {
        if (!lines[i]!.startsWith("#")) sql.push(lines[i]!);
        i++;
      }
      records.push({
        kind: "statement",
        line,
        sql: sql.join("\n"),
        error: header[1] === "error",
      });
    } else if (header[0] === "query") {
      if (
        !/^[IRT]+$/.test(header[1] ?? "") ||
        header.length !== 3 ||
        !["nosort", "rowsort", "valuesort"].includes(header[2]!)
      )
        throw Error(`invalid query directive at ${line}`);
      while (i < lines.length && lines[i] !== "----") {
        if (!lines[i]!.trim())
          throw Error(`missing result separator at ${line}`);
        if (!lines[i]!.startsWith("#")) sql.push(lines[i]!);
        i++;
      }
      if (i === lines.length) throw Error(`missing query results at ${line}`);
      i++;
      const expected: string[] = [];
      while (i < lines.length && lines[i]!.trim()) {
        if (!lines[i]!.startsWith("#")) expected.push(lines[i]!);
        i++;
      }
      const hash =
        expected.length === 1
          ? /^(\d+) values hashing to ([0-9a-f]{32})$/.exec(expected[0]!)
          : null;
      records.push({
        kind: "query",
        line,
        sql: sql.join("\n"),
        types: header[1]!,
        sort: header[2] as "nosort" | "rowsort" | "valuesort",
        expected,
        ...(hash ? { hash: { count: Number(hash[1]), md5: hash[2]! } } : {}),
      });
    } else
      throw Error(`unsupported sqllogictest directive ${header[0]} at ${line}`);
  }
  return records;
}
export function logicValues(
  record: Extract<LogicRecord, { kind: "query" }>,
  rows: Value[][],
): string[] {
  const result = rows.map((row) => {
    if (row.length !== record.types.length)
      throw Error(
        `line ${record.line}: expected ${record.types.length} columns, received ${row.length}`,
      );
    return row.map((value, i) => {
      if (value === null) return "NULL";
      switch (record.types[i]) {
        case "I": {
          const n =
            typeof value === "bigint"
              ? value
              : BigInt(Math.trunc(Number(value)));
          return BigInt.asIntN(32, n).toString();
        }
        case "R":
          return Number(value).toFixed(3);
        case "T": {
          const s = String(value);
          return s.length
            ? Array.from(new TextEncoder().encode(s.split("\0")[0]!))
                .map((b) => (b < 32 || b > 126 ? "@" : String.fromCharCode(b)))
                .join("")
            : "(empty)";
        }
        default:
          throw Error("invalid result type");
      }
    });
  });
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  if (record.sort === "rowsort")
    result.sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        const c = compare(a[i]!, b[i]!);
        if (c) return c;
      }
      return 0;
    });
  const values = result.flat();
  if (record.sort === "valuesort") values.sort(compare);
  return values;
}
export function verifyLogicResult(
  record: Extract<LogicRecord, { kind: "query" }>,
  rows: Value[][],
): void {
  const values = logicValues(record, rows);
  if (record.hash) {
    const md5 = createHash("md5")
      .update(values.map((v) => v + "\n").join(""))
      .digest("hex");
    if (values.length !== record.hash.count || md5 !== record.hash.md5)
      throw Error(
        `sqllogictest line ${record.line}: expected ${record.hash.count} values / ${record.hash.md5}; received ${values.length} / ${md5}\n${record.sql}`,
      );
  } else if (JSON.stringify(values) !== JSON.stringify(record.expected))
    throw Error(
      `sqllogictest line ${record.line}: expected ${JSON.stringify(record.expected)}, received ${JSON.stringify(values)}\n${record.sql}`,
    );
}
export function runLogicTest(
  records: LogicRecord[],
  driver: LogicDriver,
): { statements: number; queries: number } {
  let statements = 0,
    queries = 0;
  for (const record of records) {
    try {
      if (record.kind === "statement") {
        let error: unknown;
        try {
          driver.execute(record.sql);
        } catch (e) {
          error = e;
        }
        if (record.error ? !error : error)
          throw error ?? Error("expected an error");
        statements++;
      } else {
        verifyLogicResult(record, driver.query(record.sql));
        queries++;
      }
    } catch (error) {
      throw Error(
        `sqllogictest line ${record.line}: ${error instanceof Error ? error.message : String(error)}\n${record.sql}`,
        { cause: error },
      );
    }
  }
  return { statements, queries };
}

/** The upstream output format normalizes values; also compare raw storage
 * classes/column positions against native SQLite so that normalization cannot
 * hide INTEGER/REAL or duplicate-column differences. */
export function differentialLogicTest(
  records: LogicRecord[],
  oracle: LogicDriver,
  candidate: LogicDriver,
): { statements: number; queries: number } {
  let statements = 0,
    queries = 0;
  for (const record of records) {
    try {
      if (record.kind === "statement") {
        for (const driver of [oracle, candidate]) {
          let error: unknown;
          try {
            driver.execute(record.sql);
          } catch (e) {
            error = e;
          }
          if (record.error ? !error : error)
            throw error ?? Error("expected an error");
        }
        statements++;
      } else {
        const expected = oracle.query(record.sql);
        verifyLogicResult(record, expected);
        const actual = candidate.query(record.sql);
        verifyLogicResult(record, actual);
        if (!isDeepStrictEqual(actual, expected))
          throw Error(
            `typed/positional mismatch: expected ${inspect(expected, { depth: 2, maxArrayLength: 3, maxStringLength: 80 })}, received ${inspect(actual, { depth: 2, maxArrayLength: 3, maxStringLength: 80 })}`,
          );
        queries++;
      }
    } catch (error) {
      throw Error(
        `sqllogictest line ${record.line}: ${error instanceof Error ? error.message : String(error)}\n${record.sql}`,
        { cause: error },
      );
    }
  }
  return { statements, queries };
}
