/** Lexical migration boundaries only; each backend still parses the SQL.
 * A trigger's BEGIN/END and nested CASE retain their inner semicolons. */
export function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0,
    i = 0,
    significant = false,
    trigger = false,
    body = false,
    cases = 0;
  let prefix: string[] = [];
  const token = (word: string) => {
    significant = true;
    if (prefix.length < 3) prefix.push(word);
    trigger =
      trigger ||
      (prefix[0] === "create" &&
        (prefix[1] === "trigger" ||
          (["temp", "temporary"].includes(prefix[1] ?? "") &&
            prefix[2] === "trigger")));
    if (!trigger) return;
    if (!body && word === "begin") body = true;
    else if (body && word === "case") cases++;
    else if (body && word === "end") {
      if (cases) cases--;
      else body = false;
    }
  };
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw Error("unterminated migration SQL comment");
      i = end + 2;
      continue;
    }
    if (["'", '"', "`", "["].includes(c)) {
      const quote = c === "[" ? "]" : c;
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i++] === quote) {
          if (quote !== "]" && sql[i] === quote) i++;
          else {
            closed = true;
            break;
          }
        }
      }
      if (!closed) throw Error("unterminated migration SQL quote");
      token("");
      continue;
    }
    if (c === ";" && !body) {
      if (significant) statements.push(sql.slice(start, i + 1));
      start = ++i;
      significant = false;
      trigger = false;
      cases = 0;
      prefix = [];
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const from = i++;
      while (i < sql.length && /[a-zA-Z0-9_$]/.test(sql[i]!)) i++;
      token(sql.slice(from, i).toLowerCase());
      continue;
    }
    token("");
    i++;
  }
  if (body || cases) throw Error("unterminated migration trigger body");
  if (significant) statements.push(sql.slice(start));
  return statements;
}
