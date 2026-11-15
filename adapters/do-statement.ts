/** Structural classification only. SQLite still parses every expression and
 * statement. Quoted tokens/comments never become statement keywords. */
export interface DoToken {
  text: string;
  identifier: boolean;
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
}
export interface DoStatement {
  kind: string;
  pragma?: { name: string };
  mainIndex: number;
}
export function doIdentifier(token: DoToken | undefined): string {
  if (!token?.identifier) throw Error("unsupported DO SQL structure");
  const text = token.text,
    first = text[0];
  if (first === "[" && text.endsWith("]")) return text.slice(1, -1);
  if ((first === '"' || first === "'" || first === "`") && text.endsWith(first))
    return text.slice(1, -1).replaceAll(first + first, first);
  return text;
}
export function doStatement(tokens: DoToken[]): DoStatement {
  let i = 0;
  const word = () => tokens[i]?.text.toLowerCase();
  const expect = (text: string) => {
    if (word() !== text) throw Error("unsupported DO WITH structure");
    i++;
  };
  const group = () => {
    expect("(");
    let depth = 1;
    while (i < tokens.length && depth) {
      const token = tokens[i++]!.text;
      if (token === "(") depth++;
      if (token === ")") depth--;
    }
    if (depth) throw Error("unsupported DO WITH structure");
  };
  const kind = word() ?? "";
  if (kind === "pragma") {
    i++;
    let name = doIdentifier(tokens[i++]);
    if (word() === ".") {
      i++;
      name = doIdentifier(tokens[i++]);
    }
    return {
      kind,
      mainIndex: 0,
      pragma: { name: name.toLowerCase() },
    };
  }
  if (kind !== "with") return { kind, mainIndex: 0 };
  i++;
  if (word() === "recursive") i++;
  while (true) {
    doIdentifier(tokens[i++]);
    if (word() === "(") group(); // Optional CTE column names.
    expect("as");
    if (word() === "not") {
      i++;
      expect("materialized");
    } else if (word() === "materialized") i++;
    group();
    if (word() !== ",") break;
    i++;
  }
  const main = word();
  if (
    !main ||
    !["select", "values", "insert", "replace", "update", "delete"].includes(
      main,
    )
  )
    throw Error("unsupported DO WITH statement kind");
  return { kind: main, mainIndex: i };
}

export function supportedDoPragma(
  pragma: NonNullable<DoStatement["pragma"]>,
): boolean {
  // Existing connection controls and metadata with an optional table argument.
  if (
    [
      "schema_version",
      "table_info",
      "table_xinfo",
      "foreign_key_list",
      "foreign_key_check",
      "foreign_keys",
      "defer_foreign_keys",
      "quick_check",
      "integrity_check",
      "index_list",
      "index_info",
      "index_xinfo",
      "table_list",
    ].includes(pragma.name)
  )
    return true;
  // Other metadata, including database_list/encoding/user_version, is denied
  // by workerd itself. Do not pretend the host provides those capabilities.
  return false;
}
