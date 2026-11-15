/** Compare stored DDL across engines that pretty-print sqlite_schema.sql.
 * Tokens preserve boundaries, quoted contents, Unicode case and compound
 * operators. This deliberately does not try to prove semantic equivalence.
 */
export function schemaSQL(sql: string): string[] {
  const tokens =
    sql.match(
      /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|[\x00-\x20]+|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_0-9$\u0080-\uffff]+|->>|->|<=|>=|!=|<>|==|\|\||./gu,
    ) ?? [];
  return tokens
    .filter((token) => !/^[\x00-\x20]|^--|^\/\*/.test(token))
    .map((token) =>
      /^["'`\[]/.test(token)
        ? token
        : token.replace(/[A-Z]/g, (c) => c.toLowerCase()),
    );
}
