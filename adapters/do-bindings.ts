import type { Value } from "../src/contract.ts";
import { doStatement, type DoStatement, type DoToken } from "./do-statement.ts";
/** Only positional binding tokens are transformed. Quoted SQL and comments are
 * copied literally; values remain bound strings, never interpolated into SQL. */
export function doBindings(
  sql: string,
  params: Value[],
): {
  sql: string;
  original: string;
  values: (number | string | null | ArrayBuffer)[];
  returning: boolean;
  body: string;
  sourceBody: string;
  statement: DoStatement;
  tokens: DoToken[];
} {
  let out = "",
    i = 0,
    next = 0,
    returning = false,
    ended = false;
  let terminator: number | undefined;
  let sourceTerminator: number | undefined;
  const tokens: DoToken[] = [];
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      out += c;
      i++;
      continue;
    }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      const n = end < 0 ? sql.length : end + 1;
      out += sql.slice(i, n);
      i = n;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      const n = end < 0 ? sql.length : end + 2;
      out += sql.slice(i, n);
      i = n;
      continue;
    }
    if (ended) throw Error("unsupported DO multiple statements");
    if (c === ";") {
      ended = true;
      terminator = out.length;
      sourceTerminator = i;
      out += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const outputStart = out.length;
      const end = c === "[" ? "]" : c,
        start = i++;
      while (i < sql.length) {
        if (sql[i++] === end) {
          if (end !== "]" && sql[i] === end) i++;
          else break;
        }
      }
      out += sql.slice(start, i);
      tokens.push({
        text: sql.slice(start, i),
        identifier: true,
        start: outputStart,
        end: out.length,
        sourceStart: start,
        sourceEnd: i,
      });
      continue;
    }
    if (c === "?") {
      const start = i++;
      while (i < sql.length && /[0-9]/.test(sql[i]!)) i++;
      const token = sql.slice(start, i),
        index = token.length > 1 ? Number(token.slice(1)) - 1 : next;
      if (!Number.isSafeInteger(index) || index < 0 || index >= params.length)
        throw Error("unsupported DO binding index");
      next = Math.max(next, index + 1);
      const outputStart = out.length;
      const value = params[index];
      // RETURNING type/value projections repeat expressions. Number every
      // placeholder once so repetition never consumes additional bindings.
      const numbered = `?${index + 1}`;
      out +=
        typeof value === "bigint"
          ? `(+CAST(${numbered} AS INTEGER))`
          : numbered;
      tokens.push({
        text: token,
        identifier: false,
        start: outputStart,
        end: out.length,
        sourceStart: start,
        sourceEnd: i,
      });
      continue;
    }
    if (/[:@$]/.test(c)) throw Error("unsupported DO named binding syntax");
    if (/[a-zA-Z_]/.test(c)) {
      const start = i++;
      while (i < sql.length && /[a-zA-Z0-9_$]/.test(sql[i]!)) i++;
      const token = sql.slice(start, i);
      const outputStart = out.length;
      if (token.toLowerCase() === "returning") returning = true;
      out += token;
      tokens.push({
        text: token,
        identifier: true,
        start: outputStart,
        end: out.length,
        sourceStart: start,
        sourceEnd: i,
      });
      continue;
    }
    const number =
      /^(?:0x[0-9a-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i.exec(
        sql.slice(i),
      );
    if (number) {
      const text = number[0];
      tokens.push({
        text,
        identifier: false,
        start: out.length,
        end: out.length + text.length,
        sourceStart: i,
        sourceEnd: i + text.length,
      });
      out += text;
      i += text.length;
      continue;
    }
    tokens.push({
      text: c,
      identifier: false,
      start: out.length,
      end: out.length + 1,
      sourceStart: i,
      sourceEnd: i + 1,
    });
    out += c;
    i++;
  }
  const values = params.map((v) => {
    if (typeof v === "bigint") {
      if (v < -(1n << 63n) || v >= 1n << 63n)
        throw Error("unsupported DO int64 binding range");
      return String(v);
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v))
        throw Error("unsupported DO non-finite REAL binding");
      return v;
    }
    return v instanceof Uint8Array ? v.slice().buffer : v;
  });
  return {
    sql: out,
    original: sql,
    values,
    returning,
    body: out.slice(0, terminator).trim(),
    sourceBody: sql.slice(0, sourceTerminator).trim(),
    statement: doStatement(tokens),
    tokens,
  };
}
