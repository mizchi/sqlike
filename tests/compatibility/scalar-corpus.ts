/** Original generated inputs. Native SQLite is the oracle; none are skipped. */
export function scalarCorpus(): string[] {
  const queries: string[] = [];
  const texts = [
    "NULL",
    "''",
    "'abcabc'",
    "'😀a界é'",
    "'  a\t  '",
    "'xy日本xy'",
    "42",
    "-1.25",
    "x'616263616263'",
    "x'f09f988061e7958c'",
    "x'610062'",
    "concat(x'610062')",
  ];
  const starts = [
    "-10",
    "-3",
    "-1",
    "0",
    "1",
    "2",
    "4",
    "10",
    "9223372036854775807",
    "-9223372036854775808",
    "'2e1'",
    "'+3x'",
  ];
  const lengths = [
    undefined,
    "-10",
    "-2",
    "-1",
    "0",
    "1",
    "3",
    "10",
    "9223372036854775807",
    "-9223372036854775808",
    "'2e1'",
    "NULL",
  ];
  for (const text of texts) {
    for (const name of ["substr", "substring"])
      for (const start of starts)
        for (const length of lengths)
          queries.push(
            `SELECT ${name}(${text},${start}${length === undefined ? "" : "," + length})`,
          );
    for (const name of ["trim", "ltrim", "rtrim"])
      for (const chars of [undefined, "''", "'xy'", "'😀界'", "NULL"])
        queries.push(
          `SELECT ${name}(${text}${chars === undefined ? "" : "," + chars})`,
        );
    for (const needle of [
      "''",
      "'a'",
      "'界'",
      "'abc'",
      "NULL",
      "x'0062'",
      "concat(x'00')",
    ])
      queries.push(
        `SELECT instr(${text},${needle}),replace(${text},${needle},'X')`,
      );
    queries.push(
      `SELECT octet_length(${text}),concat(${text}),concat(${text},NULL,'!'),concat_ws(':',${text},NULL,'!')`,
    );
  }
  for (const a of [
    "NULL",
    "1",
    "1.0",
    "'1'",
    "'a' COLLATE NOCASE",
    "'a' COLLATE BINARY",
    "x'31'",
  ])
    for (const b of ["NULL", "1", "1.0", "'1'", "'A'", "'A' COLLATE NOCASE"])
      queries.push(`SELECT nullif(${a},${b})`);
  queries.push(
    "SELECT 'image.png' GLOB '*.[a-z][a-z][a-z]',glob('[^a-z]','A'),'A' NOT GLOB '[a-z]'",
    "SELECT glob('[]]-%',']-%'),glob('[z-a]','z'),glob('[a-b-c]','-'),glob('[abc','a')",
    "SELECT glob('é?','é😀'),glob('*',char(0,65)),NULL GLOB '*',glob(x'2a',x'6162')",
    "SELECT char(),char(NULL),char(65,0,233,128512),hex(char(-1,1114112,1114111))",
    "SELECT unicode(char(65534)),unicode(char(65535)),unicode(char(131071))",
    "SELECT glob(char(65535),char(65533)),char(65534) LIKE char(65533),hex(char(65535))",
    "SELECT 0xF_F,0xFFFFFFFFFFFFFFFF,0x8000000000000000,1_000,-9_223_372_036_854_775_808",
    "SELECT .1_2,1_2.3_4e+1_0,typeof(0xF_F),typeof(1_0e1),CAST('0xFF' AS INTEGER),CAST('1_000' AS INTEGER)",
    "SELECT concat(NULL,NULL),concat_ws(NULL,'a'),concat_ws(':',NULL,NULL)",
    "SELECT iif(0,'bad',1,'yes','otherwise'),if(0,'bad'),iif(NULL,'bad','default')",
    "SELECT iif(1,'ok',abs(-9223372036854775808)),iif(0,abs(-9223372036854775808),'ok')",
    "SELECT iif(1,7,abs(-9223372036854775808),'bad'),iif(0,1,0,2,3)",
  );
  for (const text of texts)
    for (const old of ["''", "'a'", "NULL", "concat(x'00')"])
      for (const replacement of ["NULL", "''", "42", "concat(x'610062')"])
        queries.push(`SELECT replace(${text},${old},${replacement})`);
  return queries;
}
