///|
test "JSON table metadata retains feature requirements without scalar JSON" {
  let p = lex("SELECT * FROM json_each('[1,2]') j")
  guard parse_statement(p) is Select(select) else { fail("select") }
  assert_true(json_table_source(select.sources[0]))
  let w = binary_writer()
  Binary::write(select, w)
  assert_eq(w.features, 8192U)
  let budget : JsonTableBudget = { bytes: 0, nodes: 0, paths: 0, }
  let rows = json_table_rows(
    select.sources[0],
    evaluation(database_open().store, [], []),
    budget,
  )
  assert_eq(rows.length(), 2)
  assert_true(rows[0][4].value == Integer(1L))
  assert_true(rows[1][4].value == Integer(3L))
}

///|
test "JSON table headers count UTF8 raw escapes and bounded traversal state" {
  let budget : JsonTableBudget = { bytes: 0, nodes: 0, paths: 0, }
  let node = json_table_node(
    parse_sql_json("{\"a\":[1,{\"b\":true}],\"cc\":null}"),
    budget,
    0,
  )
  assert_eq(node.payload, 13)
  assert_eq(node.size(), 15)
  assert_eq(json_table_header(11), 1)
  assert_eq(json_table_header(12), 2)
  assert_eq(json_table_header(256), 3)
  assert_eq(json_table_header(65536), 5)
  let p = lex("SELECT * FROM json_tree('[1]')")
  guard parse_statement(p) is Select(select) else { fail("select") }
  let exhausted : JsonTableBudget = { bytes: 16777216, nodes: 0, paths: 0, }
  assert_true(
    try {
      ignore(
        json_table_rows(
          select.sources[0],
          evaluation(database_open().store, [], []),
          exhausted,
        ),
      )
      false
    } catch {
      _ => true
    },
  )
}

///|
test "scalar JSON aggregates use a streaming path without expanded environments" {
  let parser = lex("SELECT sum(atom),count(*),count(value) FROM json_tree(?)")
  guard parse_statement(parser) is Select(select) else { fail("select") }
  let context = evaluation(database_open().store, [Text("[1,null,[2,3]]")], [])
  let output = selection_template(select, context)
  let result = json_table_aggregate(select, context, output)
  assert_true(result is Some(_))
  assert_true(
    result.unwrap().rows[0].map(b => b.value) ==
    [Integer(6L), Integer(6L), Integer(5L)],
  )
}
