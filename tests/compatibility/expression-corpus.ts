/** Fixed corpus: selection is independent of candidate results. Every generated
 * SQL statement must execute on native SQLite; no failed case is filtered out. */
export function expressionCorpus(): string[] {
  const values = [
    "NULL",
    "0",
    "1",
    "-1",
    "2",
    "-7",
    "0.0",
    "1.0",
    "1.25",
    "-2.5",
    "''",
    "'1'",
    "'1.0'",
    "'12tail'",
    "'text'",
    "x'31'",
    "9007199254740993",
    "9223372036854775807",
    "-9223372036854775808",
  ];
  const queries: string[] = [];
  const add = (expr: string) =>
    queries.push(`SELECT ${expr} AS value,typeof(${expr}) AS storage`);
  for (const left of values)
    for (const right of values)
      for (const op of [
        "+",
        "-",
        "*",
        "/",
        "%",
        "||",
        "=",
        "<>",
        "<",
        "<=",
        ">",
        ">=",
        "IS",
        "IS NOT",
        "AND",
        "OR",
      ])
        add(`(${left}) ${op} (${right})`);
  for (const value of values) {
    for (const op of ["NOT", "-", "+"]) add(`${op} (${value})`);
    for (const truth of ["TRUE", "FALSE"])
      for (const op of ["IS", "IS NOT"]) add(`(${value}) ${op} ${truth}`);
    for (const low of ["NULL", "0", "'1'", "-7"])
      for (const high of ["NULL", "2", "'9'", "7"])
        for (const op of ["BETWEEN", "NOT BETWEEN"])
          add(`(${value}) ${op} (${low}) AND (${high})`);
    for (const list of ["", "NULL", "0,1", "'1','2'", "1,NULL,3"])
      for (const op of ["IN", "NOT IN"]) add(`(${value}) ${op} (${list})`);
    add(
      `CASE (${value}) WHEN NULL THEN 'null' WHEN 0 THEN 'zero' WHEN '1' THEN 'text' WHEN 1 THEN 'one' ELSE 'other' END`,
    );
    add(
      `CASE WHEN (${value}) THEN 'true' WHEN (${value}) IS NULL THEN 'null' ELSE 'false' END`,
    );
  }
  // Deterministically compose precedence, affinity and null semantics.
  for (let seed = 0; seed < 16; seed++) {
    let state = seed + 1;
    const random = () =>
      (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const expression = (depth: number): string => {
      if (!depth) return values[random() % values.length]!;
      const ops = ["+", "-", "*", "/", "%", "=", "<", "IS", "AND", "OR", "||"];
      const op = ops[random() % ops.length]!;
      return `(${expression(depth - 1)}) ${op} (${expression(depth - 1)})`;
    };
    for (let i = 0; i < 64; i++) add(expression(2));
  }
  queries.push(
    "SELECT CASE WHEN 1 THEN 7 ELSE abs(-9223372036854775808) END",
    "SELECT CASE 1 WHEN 1 THEN 7 WHEN abs(-9223372036854775808) THEN 8 END",
    "SELECT EXISTS(SELECT abs(-9223372036854775808))",
    "SELECT (SELECT 42 WHERE 0)",
    "SELECT (SELECT 1 LIMIT 0)",
    "SELECT EXISTS(SELECT count(*) WHERE 0)",
    "SELECT EXISTS(SELECT 1 LIMIT 0)",
  );
  return queries;
}

export function floatTextCorpus(): string[] {
  const values = [
    0,
    -0,
    0.1,
    49.47,
    Math.PI,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    1e-4,
    1e-5,
    1e15,
    1e16,
    1e17,
    2 ** 63,
    2 ** 64,
    0.9999999999999999,
    1.0000000000000002,
  ];
  let bits = 0x123456789abcdefn;
  const view = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 512; i++) {
    bits = BigInt.asUintN(
      64,
      bits * 6364136223846793005n + 1442695040888963407n,
    );
    const mantissa = bits & 0xfffffffffffffn,
      exponent = BigInt(1 + ((i * 73) % 2045));
    view.setBigUint64(
      0,
      (bits & 0x8000000000000000n) | (exponent << 52n) | mantissa,
    );
    values.push(view.getFloat64(0));
  }
  return values.map((value) => {
    let literal = Object.is(value, -0) ? "-0.0" : String(value);
    if (!/[.e]/i.test(literal)) literal += ".0";
    return `SELECT (${literal})||''`;
  });
}
