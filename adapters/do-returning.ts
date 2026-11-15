import { doIdentifier, type DoToken } from "./do-statement.ts";
import type { doBindings } from "./do-bindings.ts";
export const quoteDoIdentifier = (name: string) =>
  '"' + name.replaceAll('"', '""') + '"';
const fold = (name: string) => name.replace(/[A-Z]/g, (c) => c.toLowerCase());
const unsupported = (): never => {
  throw Error("unsupported DO RETURNING expression or target");
};
const pureFunctions = new Set([
  "typeof",
  "hex",
  "abs",
  "coalesce",
  "ifnull",
  "nullif",
  "upper",
  "lower",
  "length",
  "octet_length",
  "substr",
  "substring",
  "replace",
  "trim",
  "ltrim",
  "rtrim",
  "instr",
  "round",
  "unicode",
  "char",
  "quote",
  "sign",
  "min",
  "max",
]);
const expressionWords = new Set([
  "null",
  "true",
  "false",
  "case",
  "when",
  "then",
  "else",
  "end",
  "is",
  "not",
  "and",
  "or",
  "in",
  "between",
  "like",
  "glob",
  "escape",
  "cast",
  "as",
  "integer",
  "int",
  "real",
  "text",
  "blob",
  "numeric",
  "collate",
  "binary",
  "nocase",
  "rtrim",
]);
function canEndExpression(token: DoToken): boolean {
  const word = token.text.toLowerCase();
  return (
    word === ")" ||
    /^[?0-9']/.test(word) ||
    (token.identifier &&
      (!expressionWords.has(word) ||
        ["null", "true", "false", "end"].includes(word)))
  );
}
export function doTypedFields(expressions: string[]): string {
  return expressions
    .map(
      (expression, i) =>
        `typeof(${expression}) AS ${quoteDoIdentifier(`t${i}`)},CASE typeof(${expression}) WHEN 'integer' THEN CAST(${expression} AS TEXT) WHEN 'text' THEN hex(${expression}) ELSE ${expression} END AS ${quoteDoIdentifier(`v${i}`)}`,
    )
    .join(",");
}

/** Only deterministic built-in scalar/row expressions may be evaluated for
 * both typeof/value. SQLite still parses syntax; unknown functions, clocks,
 * connection counters and subqueries are rejected before executing any DML. */
export function doReturning(
  bound: ReturnType<typeof doBindings>,
  columns: (table: string, schema: string) => string[],
): { sql: string; names: string[] } {
  const tokens = bound.tokens;
  let i = bound.statement.mainIndex + 1;
  const word = () => tokens[i]?.text.toLowerCase();
  if (bound.statement.kind === "insert" || bound.statement.kind === "update") {
    if (word() === "or") i += 2;
  }
  if (["insert", "replace"].includes(bound.statement.kind)) {
    if (word() !== "into") unsupported();
    i++;
  } else if (bound.statement.kind === "delete") {
    if (word() !== "from") unsupported();
    i++;
  } else if (bound.statement.kind !== "update") unsupported();
  let table = doIdentifier(tokens[i++]),
    schema = "main";
  if (word() === ".") {
    schema = table;
    i++;
    table = doIdentifier(tokens[i++]);
  }
  let depth = 0,
    start = -1;
  for (let j = i; j < tokens.length; j++) {
    const text = tokens[j]!.text.toLowerCase();
    if (text === "(") depth++;
    if (text === ")") depth--;
    if (!depth && text === "returning") {
      start = j;
      break;
    }
  }
  if (start < 0) unsupported();
  const fields: DoToken[][] = [[]];
  depth = 0;
  for (const token of tokens.slice(start + 1)) {
    if (token.text === "," && !depth) {
      fields.push([]);
      continue;
    }
    fields.at(-1)!.push(token);
    if (token.text === "(") depth++;
    if (token.text === ")") depth--;
  }
  const available = columns(table, schema),
    names: string[] = [],
    expressions: string[] = [];
  if (!available.length) unsupported();
  const column = (expression: DoToken[]): string => {
    if (expression.length === 3 && expression[1]!.text === ".")
      doIdentifier(expression[0]);
    else if (expression.length !== 1) unsupported();
    const name = doIdentifier(expression.at(-1));
    if (
      [
        "null",
        "true",
        "false",
        "current_time",
        "current_date",
        "current_timestamp",
      ].includes(expression.at(-1)!.text.toLowerCase())
    )
      unsupported();
    return available.find((c) => fold(c) === fold(name)) ?? unsupported();
  };
  const deterministic = (expr: DoToken[]) => {
    if (!expr.length) unsupported();
    for (let j = 0; j < expr.length; j++) {
      const token = expr[j]!,
        word = token.text.toLowerCase(),
        next = expr[j + 1];
      if (word.startsWith("'")) continue; // SQL string literal, never executable SQL.
      if (!token.identifier) {
        if (
          /^(?:\?[0-9]*|0x[0-9a-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.test(
            word,
          ) ||
          /^[()+\-*/%<>=!~&|,.]$/.test(word)
        )
          continue;
        unsupported();
      }
      if (next?.text === "(") {
        if (!pureFunctions.has(word) && !["cast", "in"].includes(word))
          unsupported();
      } else if (next?.text === ".") {
        doIdentifier(token); // SQLite validates target qualification.
      } else if (!expressionWords.has(word)) column([token]);
    }
  };
  for (const field of fields) {
    if (!field.length) unsupported();
    let expr = field,
      alias: string | undefined;
    if (field.at(-2)?.text.toLowerCase() === "as") {
      alias = doIdentifier(field.at(-1));
      expr = field.slice(0, -2);
    } else if (
      field.length > 1 &&
      field.at(-1)!.identifier &&
      !expressionWords.has(field.at(-1)!.text.toLowerCase()) &&
      canEndExpression(field.at(-2)!)
    ) {
      // Implicit alias is accepted only when the preceding expression validates.
      alias = doIdentifier(field.at(-1));
      expr = field.slice(0, -1);
    }
    if (expr.length === 1 && expr[0]!.text === "*") {
      if (alias) unsupported();
      for (const c of available) {
        names.push(c);
        expressions.push(quoteDoIdentifier(c));
      }
      continue;
    }
    deterministic(expr);
    const simple =
      (expr.length === 1 &&
        expr[0]!.identifier &&
        !expr[0]!.text.startsWith("'") &&
        !expressionWords.has(expr[0]!.text.toLowerCase())) ||
      (expr.length === 3 && expr[1]!.text === ".");
    const name = simple
      ? column(expr)
      : bound.original.slice(expr[0]!.sourceStart, expr.at(-1)!.sourceEnd);
    names.push(alias ?? name);
    expressions.push(bound.sql.slice(expr[0]!.start, expr.at(-1)!.end));
  }
  return {
    names,
    sql: `${bound.sql.slice(0, tokens[start]!.start)} RETURNING ${doTypedFields(expressions)}`,
  };
}
