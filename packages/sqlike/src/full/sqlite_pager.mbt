///|
/// Explicit, optional export cursor. Clean pages live in the host's bounded
/// cache; this cursor retains only immutable logical row roots and metadata.
struct SqlitePager {
  mut base : PagerBase?
  mut generation : Int32
}

///|
priv struct PagerBase {
  program : String
  serial : Int32
  epoch : Int64
  cookie : Int32
  size : Int32
  count : Int32
  tables : Array[Table]
}

///|
priv struct PagerUpdate {
  root : Int32
  rowid : Int64
  before : Bytes
  after : Bytes
}

///|
priv enum PagerMode {
  Header
  Tree
  Overflow(Int32, Int32)
  Done
}

///|
priv struct PagerTask {
  owner : SqlitePager
  generation : Int32
  database : Database
  store : Store
  plan : StoragePlan
  program : String
  serial : Int32
  epoch : Int64
  base : PagerBase?
  updates : Array[PagerUpdate]
  dirty : Map[Int32, Bytes]
  visited : Map[Int32, Bool]
  mut image : Bytes?
  mut fallback : String?
  mut size : Int32
  mut count : Int32
  mut position : Int32
  mut request : Int32
  mut mode : PagerMode
  mut blocks : Int32
  mut reads : Int32
}

///|
struct SqlitePageBatch {
  task : PagerTask?
  mut error : String?
}

///|
pub fn sqlite_pager_open() -> SqlitePager {
  { base: None, generation: 0, }
}

///|
fn pager_full(task : PagerTask, reason : String) -> Unit raise {
  let image = sqlite_export(task.store, task.serial, task.plan)
  task.image = Some(image)
  task.size = task.plan.page_size
  task.count = image.length() / task.size
  task.fallback = Some(reason)
  task.dirty.clear()
  task.request = 0
  task.mode = Done
}

///|
fn pager_record(table : Table, row : StoredRow) -> Bytes raise SqlError {
  let ipk = integer_primary(table)
  sqlite_record(
    insert_columns(table).map(i => if i == ipk { Null } else { row.values[i] }),
  )
}

///|
fn pager_index_values(
  store : Store,
  tree : StorageTree,
  table : Table,
  row : StoredRow,
) -> Array[Value]? raise SqlError {
  let context = evaluation(store, [], row_environment(table, row, table.name))
  if tree.predicate is Some(e) && truth(evaluate(e, context)) != 1 {
    return None
  }
  Some(
    tree.fields.map(f => {
      if f.column == -2 {
        guard f.expression is Some(e) else {
          fail("missing pager index expression")
        }
        evaluate(e, context)
      } else if f.column == -1 {
        Integer(row.id)
      } else {
        row.values[f.column]
      }
    }),
  )
}

///|
fn pager_same_index(a : Array[Value]?, b : Array[Value]?) -> Bool {
  match (a, b) {
    (None, None) => true
    (Some(a), Some(b)) =>
      a.length() == b.length() &&
      a.mapi((i, v) => same_stored_value(v, b[i])).all(v => v)
    _ => false
  }
}

///|
fn pager_changes(task : PagerTask, base : PagerBase) -> String? raise SqlError {
  if task.store.tables.length() != base.tables.length() {
    return Some("schema")
  }
  for ti, table in task.store.tables {
    let before = base.tables[ti]
    if before.name != table.name ||
      before.sql != table.sql ||
      before.rows.count != table.rows.count ||
      before.rows.used != table.rows.used ||
      before.sequence != table.sequence ||
      before.sequence_present != table.sequence_present {
      return Some("row-layout-or-sequence")
    }
    if physical_equal(before.rows.pages, table.rows.pages) {
      continue
    }
    let trees = task.plan.trees.filter(t => t.table == table.name)
    let root = trees.iter().find_first(t => t.kind == "table")
    guard root is Some(root) && !table.without_rowid else {
      return Some("without-rowid")
    }
    for pi in 0..<table.rows.pages.length() {
      let page = table.rows.pages[pi]
      task.blocks += 1
      let old = before.rows.pages[pi]
      if physical_equal(page, old) {
        continue
      }
      if old.rows.length() != page.rows.length() {
        return Some("row-layout")
      }
      for ri, row in page.rows {
        match (old.rows[ri], row) {
          (None, None) => ()
          (Some(old), Some(row)) => {
            if physical_equal(old, row) {
              continue
            }
            if old.id != row.id {
              return Some("rowid-change")
            }
            let a = pager_record(table, old)
            let b = pager_record(table, row)
            if a == b {
              continue
            }
            for tree in trees {
              if tree.kind == "index" &&
                (
                  tree.predicate is Some(_) ||
                  tree.fields.any(f => {
                    f.expression is Some(_) ||
                    (f.column >= 0 && generated_column(table.columns[f.column]))
                  })
                ) {
                return Some("complex-index")
              }
              if tree.kind == "index" &&
                !pager_same_index(
                  pager_index_values(task.store, tree, table, old),
                  pager_index_values(task.store, tree, table, row),
                ) {
                return Some("index-key-change")
              }
            }
            if task.updates.length() >= 128 {
              return Some("changed-row-budget")
            }
            task.updates.push({
              root: root.root,
              rowid: row.id,
              before: a,
              after: b,
            })
          }
          _ => return Some("insert-or-delete")
        }
      }
    }
  }
  None
}

///|
fn pager_prepare(
  connection : Connection,
  program : Program,
  pager : SqlitePager,
  storage~ : StoragePlan? = None,
) -> PagerTask raise {
  connection.healthy()
  let database = connection.database
  guard database.store.transactions.frames.is_empty() else {
    fail("cannot page an active SQL transaction")
  }
  let chosen = if storage is Some(_) { storage } else { program.storage }
  guard chosen is Some(plan) else {
    fail("program has no prebuilt SQLite storage template")
  }
  let task : PagerTask = {
    owner: pager,
    generation: pager.generation,
    database,
    store: copy_store(database.store),
    plan,
    program: program.id,
    serial: database.serial,
    epoch: database.schema_epoch,
    base: pager.base,
    updates: [],
    dirty: Map([]),
    visited: Map([]),
    image: None,
    fallback: None,
    size: plan.page_size,
    count: 0,
    position: 0,
    request: 0,
    mode: Done,
    blocks: 0,
    reads: 0,
  }
  match pager.base {
    None => pager_full(task, "initial")
    Some(base) => {
      task.count = base.count
      if base.program != program.id ||
        base.epoch != database.schema_epoch ||
        base.cookie != database.store.cookie ||
        base.size != plan.page_size ||
        base.serial > database.serial {
        pager_full(task, "source-reset")
      } else if pager_changes(task, base) is Some(reason) {
        pager_full(task, reason)
      } else if database.serial != base.serial || !task.updates.is_empty() {
        task.mode = Header
        task.request = 1
      }
    }
  }
  task
}

///|
pub fn aot_pager_prepare(
  db : AotDatabase,
  pager : SqlitePager,
) -> SqlitePageBatch {
  try {
    let (connection, program) = db.ready()
    { task: Some(pager_prepare(connection, program, pager)), error: None, }
  } catch {
    e => { task: None, error: Some(public_error(e)), }
  }
}

///|
pub fn defined_pager_prepare(
  db : DefinedDatabase,
  layout : Bytes,
  pager : SqlitePager,
) -> SqlitePageBatch {
  try {
    let (connection, program) = db.core.ready()
    {
      task: Some(
        pager_prepare(
          connection,
          program,
          pager,
          storage=Some(defined_sqlite_plan(db, layout)),
        ),
      ),
      error: None,
    }
  } catch {
    e => { task: None, error: Some(public_error(e)), }
  }
}

///|
fn pager_page_number(task : PagerTask, page : Int64) -> Int32 raise SqlError {
  guard page > 0L && page <= task.count.to_int64() else {
    fail("corrupt pager page number")
  }
  page.to_int()
}

///|
fn pager_put(
  task : PagerTask,
  page : Int32,
  before : Bytes,
  after : Bytes,
) -> Unit raise {
  if before != after {
    task.dirty[page] = after
  }
  if task.dirty.length() > 4194304 / task.size {
    pager_full(task, "dirty-page-budget")
  }
}

///|
fn pager_next(task : PagerTask) -> Unit {
  task.position += 1
  task.visited.clear()
  if task.position < task.updates.length() {
    task.request = task.updates[task.position].root
    task.mode = Tree
  } else {
    task.request = 0
    task.mode = Done
  }
}

///|
fn pager_accept(task : PagerTask, page : Int32, data : Bytes) -> Unit raise {
  guard page == task.request && data.length() == task.size else {
    fail("unexpected pager page/size")
  }
  guard !task.visited.contains(page) else { fail("corrupt pager page cycle") }
  task.visited[page] = true
  match task.mode {
    Header => {
      let base = task.base.unwrap()
      let template = @base64.decode(task.plan.image)
      let initial = disk_cursor(template, 24, 28).word()
      guard data[0:16] == b"SQLite format 3\x00" &&
        disk_cursor(data, 16, 18).u16() ==
        (if task.size == 65536 { 1 } else { task.size }) &&
        disk_cursor(data, 28, 32).word() == task.count.to_int64() &&
        disk_cursor(data, 24, 28).word() ==
        ((initial + base.serial.to_int64()) & 0xffffffffL) &&
        disk_cursor(data, 40, 44).word() == disk_cursor(template, 40, 44).word() else {
        fail("pager base header mismatch")
      }
      let first = FixedArray::makei(task.size, i => data[i])
      let change = (initial + task.serial.to_int64()).reinterpret_as_uint64() &
        0xffffffffUL
      sqlite_word(first, 24, change, 4)
      sqlite_word(first, 92, change, 4)
      sqlite_word(first, 96, 0UL, 4)
      pager_put(task, 1, data, Bytes::from_array(first[:]))
      task.position = -1
      pager_next(task)
    }
    Tree => {
      let op = task.updates[task.position]
      let c = disk_cursor(data, 0, task.size)
      let flag = c.byte()
      ignore(c.u16())
      let count = c.u16()
      let header = if flag == 5 { 12 } else { 8 }
      guard (flag == 5 || flag == 13) && count <= (task.size - header) / 2 else {
        fail("corrupt pager B-tree header")
      }
      if flag == 5 {
        let mut child = disk_cursor(data, 8, 12).word()
        let mut previous : Int64? = None
        for i in 0..<count {
          let offset = disk_cursor(data, header + i * 2, header + i * 2 + 2).u16()
          guard offset >= header + count * 2 else {
            fail("corrupt pager cell offset")
          }
          let key = disk_cursor(data, offset, task.size)
          let next = key.word()
          let rowid = key.varint().reinterpret_as_int64()
          guard previous.map(p => p < rowid).unwrap_or(true) else {
            fail("corrupt pager key order")
          }
          previous = Some(rowid)
          if op.rowid <= rowid {
            child = next
            break
          }
        }
        task.request = pager_page_number(task, child)
      } else {
        let cells : Array[Bytes] = []
        let mut found = -1
        let mut local_offset = 0
        let mut overflow = 0
        let mut local_size = 0
        let mut previous : Int64? = None
        let ranges : Array[(Int32, Int32)] = []
        for i in 0..<count {
          let offset = disk_cursor(data, header + i * 2, header + i * 2 + 2).u16()
          guard offset >= header + count * 2 else {
            fail("corrupt pager cell offset")
          }
          let cell = disk_cursor(data, offset, task.size)
          let size = disk_int(cell.varint(), 67108864)
          let rowid = cell.varint().reinterpret_as_int64()
          guard previous.map(p => p < rowid).unwrap_or(true) else {
            fail("corrupt pager key order")
          }
          previous = Some(rowid)
          let maximum = task.size - 35
          let minimum = (task.size - 12) * 32 / 255 - 23
          let proposed = minimum + (size - minimum) % (task.size - 4)
          let n = if size <= maximum {
            size
          } else if proposed <= maximum {
            proposed
          } else {
            minimum
          }
          let start = cell.position
          ignore(cell.take(n))
          let next = if n < size {
            pager_page_number(task, cell.word())
          } else {
            0
          }
          guard ranges.all(r => cell.position <= r.0 || offset >= r.1) else {
            fail("corrupt pager overlapping cells")
          }
          ranges.push((offset, cell.position))
          cells.push(data[offset:cell.position].to_owned())
          if rowid == op.rowid {
            guard size == op.before.length() &&
              data[start:start + n] == op.before[0:n] else {
              fail("pager base row mismatch")
            }
            found = i
            local_offset = start
            local_size = n
            overflow = next
          }
        }
        guard found >= 0 else { fail("pager base row missing") }
        if overflow != 0 {
          if op.before.length() != op.after.length() {
            pager_full(task, "overflow-size-change")
            return
          }
          let bytes = FixedArray::makei(task.size, i => data[i])
          bytes.blit_from_bytes(local_offset, op.after, 0, local_size)
          pager_put(task, page, data, Bytes::from_array(bytes[:]))
          if task.image is Some(_) {
            return
          }
          task.request = overflow
          task.mode = Overflow(local_size, op.after.length())
        } else {
          if op.after.length() > task.size - 35 {
            pager_full(task, "overflow-growth")
            return
          }
          let out = @buffer.Buffer()
          out.write_bytes(sqlite_varint(op.after.length().to_uint64())[:])
          out.write_bytes(sqlite_varint(op.rowid.reinterpret_as_uint64())[:])
          out.write_bytes(op.after[:])
          cells[found] = out.to_bytes()
          let writer : PageWriter = {
            size: task.size,
            pages: [FixedArray::make(task.size, b'\x00')],
          }
          if !writer.fits(cells, false) {
            pager_full(task, "leaf-full")
            return
          }
          writer.page(1, 13, cells, 0)
          pager_put(task, page, data, Bytes::from_array(writer.pages[0][:]))
          if task.image is Some(_) {
            return
          }
          pager_next(task)
        }
      }
    }
    Overflow(position, total) => {
      let op = task.updates[task.position]
      let count = (total - position).min(task.size - 4)
      guard data[4:4 + count] == op.before[position:position + count] else {
        fail("pager overflow base mismatch")
      }
      let next = disk_cursor(data, 0, 4).word()
      guard (position + count == total) == (next == 0L) else {
        fail("corrupt pager overflow length")
      }
      let bytes = FixedArray::makei(task.size, i => data[i])
      bytes.blit_from_bytes(4, op.after, position, count)
      pager_put(task, page, data, Bytes::from_array(bytes[:]))
      if task.image is Some(_) {
        return
      }
      if next == 0L {
        pager_next(task)
      } else {
        task.request = pager_page_number(task, next)
        task.mode = Overflow(position + count, total)
      }
    }
    Done => fail("pager batch is already ready")
  }
}

///|
pub fn sqlite_pager_supply(
  batch : SqlitePageBatch,
  page : Int32,
  data : Bytes,
) -> String {
  if batch.error is None && batch.task is Some(task) {
    try {
      task.reads += 1
      pager_accept(task, page, data)
      while task.request != 0 {
        guard task.dirty.get(task.request) is Some(data) else { break }
        pager_accept(task, task.request, data)
      }
    } catch {
      e => batch.error = Some(public_error(e))
    }
  }
  sqlite_pager_info(batch)
}

///|
fn pager_numbers(task : PagerTask) -> Array[Int32] {
  if task.image is Some(_) {
    Array::makei(task.count, i => i + 1)
  } else {
    let pages = task.dirty.keys().to_array()
    pages.sort()
    pages
  }
}

///|
pub fn sqlite_pager_info(batch : SqlitePageBatch) -> String {
  if batch.error is Some(error) {
    return ({ "error": error } : Json).stringify()
  }
  guard batch.task is Some(task) else {
    return "{\"error\":\"invalid pager batch\"}"
  }
  let info : Json = {
    "ready": task.request == 0,
    "pageSize": task.size,
    "pageCount": task.count,
    "serial": task.serial,
    "programId": task.program,
    "snapshot": task.image is Some(_),
    "pages": @json.to_json(
      if task.request == 0 {
        pager_numbers(task)
      } else {
        []
      },
    ),
    "changedRows": task.updates.length(),
    "logicalBlocks": task.blocks,
    "reads": task.reads,
  }
  if info is Object(fields) {
    if task.request != 0 {
      fields["need"] = @json.to_json(task.request)
    }
    if task.fallback is Some(reason) {
      fields["fallback"] = @json.to_json(reason)
    }
  }
  info.stringify()
}

///|
pub fn sqlite_pager_page(batch : SqlitePageBatch, index : Int32) -> Bytes {
  if batch.error is Some(_) {
    return b""
  }
  guard batch.task is Some(task) && task.request == 0 else { return b"" }
  if task.image is Some(image) {
    guard index >= 0 && index < task.count else { return b"" }
    return image[index * task.size:(index + 1) * task.size].to_owned()
  }
  let pages = pager_numbers(task)
  guard index >= 0 && index < pages.length() else { return b"" }
  let page = pages[index]
  match task.image {
    Some(image) => image[(page - 1) * task.size:page * task.size].to_owned()
    None => Bytes::from_array(task.dirty[page].to_array())
  }
}

///|
pub fn sqlite_pager_page_base64(
  batch : SqlitePageBatch,
  index : Int32,
) -> String {
  @base64.encode(sqlite_pager_page(batch, index))
}

///|
pub fn sqlite_pager_supply_base64(
  batch : SqlitePageBatch,
  page : Int32,
  text : String,
) -> String {
  try {
    guard text.length() <= 87384 else { fail("pager page input limit") }
    sqlite_pager_supply(batch, page, @base64.decode(text))
  } catch {
    e => {
      batch.error = Some(public_error(e))
      sqlite_pager_info(batch)
    }
  }
}

///|
pub fn sqlite_pager_ack(pager : SqlitePager, batch : SqlitePageBatch) -> String {
  try {
    guard batch.error is None && batch.task is Some(task) && task.request == 0 else {
      fail("invalid pager acknowledgement")
    }
    guard physical_equal(task.owner, pager) &&
      task.generation == pager.generation &&
      task.serial == task.database.serial &&
      task.database.store.transactions.frames.is_empty() &&
      task.epoch == task.database.schema_epoch &&
      task.store.cookie == task.database.store.cookie &&
      task.store.tables.length() == task.database.store.tables.length() &&
      task.store.tables
      .mapi((i, t) => {
        physical_equal(t.rows.pages, task.database.store.tables[i].rows.pages)
      })
      .all(v => v) else {
      fail("stale pager acknowledgement")
    }
    pager.base = Some({
      program: task.program,
      serial: task.serial,
      epoch: task.epoch,
      cookie: task.store.cookie,
      size: task.size,
      count: task.count,
      tables: task.store.tables,
    })
    pager.generation += 1
    "{}"
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

///|
pub fn defined_pager_prepare_base64(
  db : DefinedDatabase,
  layout : String,
  pager : SqlitePager,
) -> SqlitePageBatch {
  defined_pager_prepare(db, @base64.decode(layout), pager) catch {
    e => { task: None, error: Some(public_error(e)), }
  }
}
