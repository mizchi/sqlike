///|
#derive(ToJson, FromJson)
priv enum WindowBound {
  UnboundedPreceding
  Preceding(Expr)
  Current
  Following(Expr)
  UnboundedFollowing
}

///|
#derive(ToJson, FromJson)
priv struct WindowFrame {
  kind : String
  start : WindowBound
  end : WindowBound
}

///|
fn Parser::window_bound(p : Parser) -> WindowBound raise SqlError {
  if p.take("unbounded") {
    if p.take("preceding") {
      UnboundedPreceding
    } else {
      p.expect("following")
      UnboundedFollowing
    }
  } else if p.take("current") {
    p.expect("row")
    Current
  } else {
    let e = p.expression(1)
    if p.take("preceding") {
      Preceding(e)
    } else {
      p.expect("following")
      Following(e)
    }
  }
}

///|
fn Parser::window_frame(p : Parser) -> WindowFrame raise SqlError {
  let kind = p.peek()
  if !["rows", "range", "groups"].contains(kind) {
    return { kind: "range", start: UnboundedPreceding, end: Current, }
  }
  p.position += 1
  if p.take("between") {
    let start = p.window_bound()
    p.expect("and")
    { kind, start, end: p.window_bound(), }
  } else {
    { kind, start: p.window_bound(), end: Current, }
  }
}

///|
fn aggregate_name(name : String) -> Bool {
  ["count", "sum", "total", "avg", "min", "max", "group_concat", "string_agg"].contains(
    name,
  )
}

///|
fn window_arity(name : String, n : Int32) -> Bool {
  match name {
    "lag" | "lead" => n >= 1 && n <= 3
    "row_number" | "rank" | "dense_rank" | "percent_rank" | "cume_dist" =>
      n == 0
    "ntile" | "first_value" | "last_value" => n == 1
    "nth_value" => n == 2
    "group_concat" => n == 1 || n == 2
    "string_agg" => n == 2
    _ => aggregate_name(name) && n == 1
  }
}

///|
fn group_concat(args : Array[Expr], ctx : Evaluation) -> Value raise SqlError {
  let distinct = args[0] is Call("$distinct", _)
  let arg = match args[0] {
    Call("$distinct", [e]) => e
    _ => args[0]
  }
  let seen : Array[Value] = []
  let out = @buffer.Buffer()
  for row in ctx.group.unwrap_or([ctx.row]) {
    let here = { ..ctx, row, group: None, }
    let value = evaluate(arg, here)
    if value is Null ||
      (
        distinct &&
        seen.any(v => {
          compare_stored(ctx.store, v, value, expression_collation(arg, ctx)) ==
          0
        })
      ) {
      continue
    }
    if !seen.is_empty() {
      out.write_bytes(
        @utf8.encode(
          if args.length() == 2 {
            checked_text_value(evaluate(args[1], here))
          } else {
            ","
          },
        ),
      )
    }
    out.write_bytes(@utf8.encode(checked_text_value(value)))
    seen.push(value)
  }
  if seen.is_empty() {
    Null
  } else {
    Text(@utf8.decode_lossy(out.to_bytes()))
  }
}

///|
fn collect_windows(e : Expr, out : Array[Expr]) -> Unit {
  match e {
    Window(_, _, _, _, _) =>
      if !out.any(previous => @json.to_json(previous) == @json.to_json(e)) {
        out.push(e)
      }
    Unary(_, e) | Cast(e, _) | Collate(e, _) => collect_windows(e, out)
    Binary(_, a, b) => {
      collect_windows(a, out)
      collect_windows(b, out)
    }
    Call(_, args) =>
      for e in args {
        collect_windows(e, out)
      }
    Between(a, b, c) => {
      collect_windows(a, out)
      collect_windows(b, out)
      collect_windows(c, out)
    }
    Case(base, arms, other) => {
      if base is Some(e) {
        collect_windows(e, out)
      }
      for (a, b) in arms {
        collect_windows(a, out)
        collect_windows(b, out)
      }
      collect_windows(other, out)
    }
    _ => ()
  }
}

///|
fn window_offset(e : Expr, ctx : Evaluation) -> Int32 raise SqlError {
  let v = evaluate(e, ctx)
  let n = cast_integer(v)
  guard !(v is Null) &&
    n >= 0L &&
    n <= 1000000000L &&
    compare_stored(ctx.store, numeric(v, false), Integer(n), "binary") == 0 else {
    fail("frame offset must be a non-negative integer")
  }
  n.to_int()
}

///|
fn compute_windows(
  expressions : Array[Expr],
  contexts : Array[Evaluation],
  base : Evaluation,
) -> Unit raise SqlError {
  for expression in expressions {
    guard expression is Window(name, args, partitions, orders, frame) else {
      continue
    }
    let groups : Array[Array[Evaluation]] = []
    let keys : Array[Array[Value]] = []
    for ctx in contexts {
      let key = partitions.map(e => evaluate(e, ctx))
      let mut found = -1
      for i, previous in keys {
        if previous
          .mapi((j, v) => {
            compare_stored(
              base.store,
              v,
              key[j],
              expression_collation(partitions[j], base),
            ) ==
            0
          })
          .all(v => v) {
          found = i
          break
        }
      }
      if found < 0 {
        keys.push(key)
        groups.push([ctx])
      } else {
        groups[found].push(ctx)
      }
    }
    let identity = @json.to_json(expression).stringify()
    for group in groups {
      let ranked = group.map(ctx => {
        output: [],
        context: ctx,
        keys: orders.map(o => evaluate(o.expression, ctx)),
      })
      let collations = orders.map(o => expression_collation(o.expression, base))
      sort_query_rows(ranked, orders, collations)
      fn peer(a : Int32, b : Int32) -> Bool {
        ranked[a].keys
        .mapi((i, v) => {
          compare_stored(base.store, v, ranked[b].keys[i], collations[i]) == 0
        })
        .all(v => v)
      }
      let mut dense = 0
      let mut rank = 0
      for index, row in ranked {
        if index == 0 || !peer(index, index - 1) {
          dense += 1
          rank = index
        }
        let mut peer_end = index + 1
        while peer_end < ranked.length() && peer(index, peer_end) {
          peer_end += 1
        }
        let here = row.context
        let n = ranked.length()
        let value = if name == "row_number" {
          Value::Integer((index + 1).to_int64())
        } else if name == "rank" {
          Integer((rank + 1).to_int64())
        } else if name == "dense_rank" {
          Integer(dense.to_int64())
        } else if name == "percent_rank" {
          Real(
            if n <= 1 {
              0.0
            } else {
              rank.to_double() / (n - 1).to_double()
            },
          )
        } else if name == "cume_dist" {
          Real(peer_end.to_double() / n.to_double())
        } else if name == "ntile" {
          let buckets = window_offset(args[0], here)
          guard buckets > 0 else {
            fail("argument of ntile must be a positive integer")
          }
          let size = n / buckets
          let extra = n % buckets
          Integer(
            (if index < (size + 1) * extra {
              index / (size + 1) + 1
            } else {
              extra + (index - (size + 1) * extra) / size + 1
            }).to_int64(),
          )
        } else if name == "lag" || name == "lead" {
          let offset = if args.length() >= 2 {
            window_offset(args[1], here)
          } else {
            1
          }
          let target = index + (if name == "lag" { -offset } else { offset })
          if target >= 0 && target < n {
            evaluate(args[0], ranked[target].context)
          } else if args.length() == 3 {
            evaluate(args[2], here)
          } else {
            Null
          }
        } else {
          fn boundary(
            bound : WindowBound,
            finish : Bool,
          ) -> Int32 raise SqlError {
            match bound {
              UnboundedPreceding => 0
              UnboundedFollowing => n
              Current =>
                if frame.kind == "rows" {
                  index + (if finish { 1 } else { 0 })
                } else if finish {
                  peer_end
                } else {
                  rank
                }
              Preceding(e) | Following(e) => {
                let amount = window_offset(e, base)
                let sign = if bound is Preceding(_) { -1 } else { 1 }
                if frame.kind == "rows" {
                  (index + sign * amount + (if finish { 1 } else { 0 }))
                  .max(0)
                  .min(n)
                } else if frame.kind == "groups" {
                  let starts : Array[Int32] = [0]
                  for j in 1..<n {
                    if !peer(j, j - 1) {
                      starts.push(j)
                    }
                  }
                  let target = dense -
                    1 +
                    sign * amount +
                    (if finish { 1 } else { 0 })
                  if target < 0 {
                    0
                  } else if target >= starts.length() {
                    n
                  } else {
                    starts[target]
                  }
                } else {
                  guard orders.length() == 1 else {
                    fail("RANGE offset requires one ORDER BY expression")
                  }
                  let key = row.keys[0]
                  if !(key is Integer(_) || key is Real(_)) {
                    return if finish { peer_end } else { rank }
                  }
                  let target = arithmetic(
                    "+",
                    key,
                    Integer(
                      (sign *
                      (if orders[0].descending { -1 } else { 1 }) *
                      amount).to_int64(),
                    ),
                  )
                  let mut position = 0
                  while position < n {
                    let cmp = compare_stored(
                        base.store,
                        ranked[position].keys[0],
                        target,
                        collations[0],
                      ) *
                      (if orders[0].descending { -1 } else { 1 })
                    if cmp > 0 || (cmp == 0 && !finish) {
                      break
                    }
                    position += 1
                  }
                  position
                }
              }
            }
          }
          let start = boundary(frame.start, false)
          let end = if orders.is_empty() &&
            frame.kind == "range" &&
            frame.end is Current {
            n
          } else {
            boundary(frame.end, true)
          }
          let members = if end > start {
            ranked[start:end].to_owned()
          } else {
            []
          }
          if name == "first_value" ||
            name == "last_value" ||
            name == "nth_value" {
            let pos = if name == "first_value" {
              0
            } else if name == "last_value" {
              members.length() - 1
            } else {
              let n = window_offset(args[1], here)
              guard n > 0 else { fail("nth_value requires a positive integer") }
              n - 1
            }
            if pos < 0 || pos >= members.length() {
              Null
            } else {
              evaluate(args[0], members[pos].context)
            }
          } else {
            let values = members.map(entry => {
              args.mapi((i, e) => {
                ..binding(
                  "$window" + i.to_string(),
                  if e is Star(_) {
                    Integer(1L)
                  } else {
                    evaluate(e, entry.context)
                  },
                ),
                collation: if e is Star(_) {
                  "binary"
                } else {
                  expression_collation(e, entry.context)
                },
              })
            })
            evaluate_call(
              name,
              args.mapi((i, _) => Column("", "$window" + i.to_string())),
              {
                ..here,
                row: if values.is_empty() {
                  args.mapi((i, _) => binding("$window" + i.to_string(), Null))
                } else {
                  values[0]
                },
                group: Some(values),
              },
            )
          }
        }
        here.window_values[identity] = value
      }
    }
  }
}
