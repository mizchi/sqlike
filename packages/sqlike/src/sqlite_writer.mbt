///|
/// Fixed-schema SQLite page writer. DDL pages and implicit index layout come
/// from a native build-time template; all row/index/overflow bytes are MoonBit.
priv struct PageWriter {
  size : Int32
  pages : Array[FixedArray[Byte]]
}

///|
fn sqlite_word(
  page : FixedArray[Byte],
  offset : Int32,
  value : UInt64,
  width : Int32,
) -> Unit {
  for i in 0..<width {
    page[offset + i] = ((value >> ((width - i - 1) * 8)) & 255UL).to_byte()
  }
}

///|
fn sqlite_bytes_word(
  out : @buffer.Buffer,
  value : UInt64,
  width : Int32,
) -> Unit {
  for i in 0..<width {
    out.write_byte(((value >> ((width - i - 1) * 8)) & 255UL).to_byte())
  }
}

///|
fn sqlite_varint(value : UInt64) -> Bytes {
  let out = @buffer.Buffer(size_hint=9)
  if value >= 0x100000000000000UL {
    for i in 0..<8 {
      out.write_byte((((value >> ((7 - i) * 7 + 8)) & 127UL) | 128UL).to_byte())
    }
    out.write_byte((value & 255UL).to_byte())
  } else {
    let mut width = 1
    let mut rest = value >> 7
    while rest > 0UL {
      width += 1
      rest = rest >> 7
    }
    for i in 0..<width {
      let byte = ((value >> ((width - i - 1) * 7)) & 127UL).to_int()
      out.write_byte((if i + 1 == width { byte } else { byte | 128 }).to_byte())
    }
  }
  out.to_bytes()
}

///|
fn sqlite_record(values : Array[Value]) -> Bytes raise SqlError {
  let header = @buffer.Buffer()
  let body = @buffer.Buffer()
  for value in values {
    let serial = match value {
      Null => 0UL
      Integer(0L) => 8UL
      Integer(1L) => 9UL
      Integer(value) => {
        let width = if value >= -128L && value <= 127L {
          1
        } else if value >= -32768L && value <= 32767L {
          2
        } else if value >= -8388608L && value <= 8388607L {
          3
        } else if value >= -2147483648L && value <= 2147483647L {
          4
        } else if value >= -140737488355328L && value <= 140737488355327L {
          6
        } else {
          8
        }
        sqlite_bytes_word(body, value.reinterpret_as_uint64(), width)
        if width == 8 {
          6UL
        } else if width == 6 {
          5UL
        } else {
          width.to_uint64()
        }
      }
      Real(value) => {
        guard !value.is_nan() else { fail("SQLite writer rejects NaN REAL") }
        sqlite_bytes_word(body, value.reinterpret_as_uint64(), 8)
        7UL
      }
      Text(value) => {
        let bytes = @utf8.encode(value)
        body.write_bytes(bytes[:])
        13UL + bytes.length().to_uint64() * 2UL
      }
      Blob(bytes) => {
        body.write_bytes(bytes[:])
        12UL + bytes.length().to_uint64() * 2UL
      }
    }
    header.write_bytes(sqlite_varint(serial)[:])
    guard body.length() <= 67108864 else {
      fail("SQLite record resource limit")
    }
  }
  let mut size = header.length() + 1
  while true {
    let next = header.length() + sqlite_varint(size.to_uint64()).length()
    if next == size {
      break
    }
    size = next
  }
  let out = @buffer.Buffer(size_hint=size + body.length())
  out.write_bytes(sqlite_varint(size.to_uint64())[:])
  out.write_bytes(header.to_bytes()[:])
  out.write_bytes(body.to_bytes()[:])
  out.to_bytes()
}

///|
fn PageWriter::allocate(writer : PageWriter) -> Int32 raise SqlError {
  guard writer.pages.length() < 67108864 / writer.size else {
    fail("SQLite output exceeds 64 MiB limit")
  }
  writer.pages.push(FixedArray::make(writer.size, b'\x00'))
  writer.pages.length()
}

///|
fn PageWriter::cell(
  writer : PageWriter,
  payload : Bytes,
  key : Int64?,
  index : Bool,
) -> Bytes raise SqlError {
  let maximum = if index {
    (writer.size - 12) * 64 / 255 - 23
  } else {
    writer.size - 35
  }
  let minimum = (writer.size - 12) * 32 / 255 - 23
  let proposed = minimum + (payload.length() - minimum) % (writer.size - 4)
  let local_size = if payload.length() <= maximum {
    payload.length()
  } else if proposed <= maximum {
    proposed
  } else {
    minimum
  }
  let out = @buffer.Buffer()
  out.write_bytes(sqlite_varint(payload.length().to_uint64())[:])
  if key is Some(key) {
    out.write_bytes(sqlite_varint(key.reinterpret_as_uint64())[:])
  }
  out.write_bytes(payload[0:local_size])
  if local_size < payload.length() {
    let mut page = writer.allocate()
    sqlite_bytes_word(out, page.to_uint64(), 4)
    let mut position = local_size
    while position < payload.length() {
      let count = (payload.length() - position).min(writer.size - 4)
      let next = if position + count < payload.length() {
        writer.allocate()
      } else {
        0
      }
      sqlite_word(writer.pages[page - 1], 0, next.to_uint64(), 4)
      writer.pages[page - 1].blit_from_bytes(4, payload, position, count)
      position += count
      page = next
    }
  }
  out.to_bytes()
}

///|
fn PageWriter::fits(
  writer : PageWriter,
  cells : Array[Bytes],
  interior : Bool,
) -> Bool {
  let header = if interior { 12 } else { 8 }
  header +
  cells.fold(init=0, (total, cell) => {
    total + 2 + cell.length() + (if interior { 4 } else { 0 })
  }) <=
  writer.size
}

///|
fn PageWriter::page(
  writer : PageWriter,
  pgno : Int32,
  flag : Int32,
  cells : Array[Bytes],
  right : Int32,
) -> Unit raise SqlError {
  let interior = flag == 2 || flag == 5
  let header = if interior { 12 } else { 8 }
  let page = FixedArray::make(writer.size, b'\x00')
  page[0] = flag.to_byte()
  sqlite_word(page, 3, cells.length().to_uint64(), 2)
  if interior {
    sqlite_word(page, 8, right.to_uint64(), 4)
  }
  let mut position = writer.size
  for i, cell in cells {
    position -= cell.length()
    guard position >= header + cells.length() * 2 else {
      fail("SQLite B-tree page overflow")
    }
    sqlite_word(page, header + i * 2, position.to_uint64(), 2)
    page.blit_from_bytes(position, cell, 0, cell.length())
  }
  sqlite_word(page, 5, (position & 65535).to_uint64(), 2)
  writer.pages[pgno - 1] = page
}

///|
fn PageWriter::leaf_groups(
  writer : PageWriter,
  cells : Array[Bytes],
) -> Array[(Int32, Int32)] raise SqlError {
  let groups : Array[(Int32, Int32)] = []
  let mut start = 0
  let mut size = 8
  for i, cell in cells {
    guard cell.length() + 10 <= writer.size else {
      fail("SQLite cell cannot fit a leaf page")
    }
    if size + cell.length() + 2 > writer.size {
      groups.push((start, i))
      start = i
      size = 8
    }
    size += cell.length() + 2
  }
  groups.push((start, cells.length()))
  groups
}

///|
/// Each separator is owned by its parent for index trees. Group boundaries
/// promote that separator, rather than duplicating an index record in two pages.
fn PageWriter::branch_groups(
  writer : PageWriter,
  count : Int32,
  keys : Array[Bytes],
) -> Array[(Int32, Int32)] raise SqlError {
  let groups : Array[(Int32, Int32)] = []
  let mut start = 0
  while start < count {
    let mut end = start + 1
    let mut size = 12
    while end < count && size + keys[end - 1].length() + 6 <= writer.size {
      size += keys[end - 1].length() + 6
      end += 1
    }
    guard end > start + 1 || end == count else {
      fail("SQLite branch key cannot fit")
    }
    groups.push((start, end))
    start = end
  }
  if groups.length() > 1 {
    let last = groups.length() - 1
    let (a, b) = groups[last]
    if b - a == 1 {
      let (before, boundary) = groups[last - 1]
      guard boundary - before >= 3 else {
        fail("SQLite branch cannot be balanced")
      }
      groups[last - 1] = (before, boundary - 1)
      groups[last] = (a - 1, b)
    }
  }
  groups
}

///|
fn sqlite_branch_cells(
  children : Array[Int32],
  keys : Array[Bytes],
  start : Int32,
  end : Int32,
) -> Array[Bytes] {
  let cells : Array[Bytes] = []
  for i in start..<(end - 1) {
    let out = @buffer.Buffer(size_hint=4 + keys[i].length())
    sqlite_bytes_word(out, children[i].to_uint64(), 4)
    out.write_bytes(keys[i][:])
    cells.push(out.to_bytes())
  }
  cells
}

///|
fn PageWriter::table(
  writer : PageWriter,
  root : Int32,
  records : Array[(Int64, Bytes)],
) -> Unit raise SqlError {
  let cells = records.map(record => writer.cell(record.1, Some(record.0), false))
  if writer.fits(cells, false) {
    writer.page(root, 13, cells, 0)
    return
  }
  let mut nodes : Array[(Int32, Int64)] = []
  for (start, end) in writer.leaf_groups(cells) {
    let page = writer.allocate()
    writer.page(page, 13, cells[start:end].to_owned(), 0)
    nodes.push((page, records[end - 1].0))
  }
  while true {
    let keys = nodes[0:nodes.length() - 1]
      .to_owned()
      .map(node => sqlite_varint(node.1.reinterpret_as_uint64()))
    let children = nodes.map(node => node.0)
    if writer.fits(keys, true) {
      writer.page(
        root,
        5,
        sqlite_branch_cells(children, keys, 0, nodes.length()),
        children[children.length() - 1],
      )
      break
    }
    let parents : Array[(Int32, Int64)] = []
    for (start, end) in writer.branch_groups(nodes.length(), keys) {
      let page = writer.allocate()
      writer.page(
        page,
        5,
        sqlite_branch_cells(children, keys, start, end),
        children[end - 1],
      )
      parents.push((page, nodes[end - 1].1))
    }
    nodes = parents
  }
}

///|
fn PageWriter::index(
  writer : PageWriter,
  root : Int32,
  records : Array[Bytes],
) -> Unit raise SqlError {
  let cells = records.map(payload => writer.cell(payload, None, true))
  if writer.fits(cells, false) {
    writer.page(root, 10, cells, 0)
    return
  }
  let groups = writer.leaf_groups(cells)
  let mut children : Array[Int32] = []
  let mut keys : Array[Bytes] = []
  for i, (start, end) in groups {
    let stop = if i + 1 < groups.length() { end - 1 } else { end }
    guard stop > start else { fail("SQLite index leaf cannot be balanced") }
    let page = writer.allocate()
    writer.page(page, 10, cells[start:stop].to_owned(), 0)
    children.push(page)
    if stop != end {
      keys.push(cells[stop])
    }
  }
  while true {
    if writer.fits(keys, true) {
      writer.page(
        root,
        2,
        sqlite_branch_cells(children, keys, 0, children.length()),
        children[children.length() - 1],
      )
      break
    }
    let parents : Array[Int32] = []
    let promoted : Array[Bytes] = []
    let groups = writer.branch_groups(children.length(), keys)
    for i, (start, end) in groups {
      let page = writer.allocate()
      writer.page(
        page,
        2,
        sqlite_branch_cells(children, keys, start, end),
        children[end - 1],
      )
      parents.push(page)
      if i + 1 < groups.length() {
        promoted.push(keys[end - 1])
      }
    }
    children = parents
    keys = promoted
  }
}

///|
fn sqlite_storage_rows(
  store : Store,
  tree : StorageTree,
) -> Array[StoredRow] raise SqlError {
  if tree.kind == "sequence" {
    let tables = store.tables.filter(t => {
      t.autoincrement &&
      t.sequence_present.unwrap_or(t.sequence > 0L || !t.rows.is_empty())
    })
    return tables.mapi((i, table) => {
      id: (i + 1).to_int64(),
      values: [Text(table.name), Integer(table.sequence)],
    })
  }
  get_table(store, tree.table).rows.copy()
}

///|
fn sqlite_export(
  store : Store,
  serial : Int32,
  plan : StoragePlan,
) -> Bytes raise {
  guard plan.format == "sqlite-template@1" && store.encoding.unwrap_or(1) == 1 else {
    fail("unsupported SQLite storage plan")
  }
  let template = @base64.decode(plan.image)
  let header = sqlite_header(template)
  guard header.page_size == plan.page_size &&
    header.usable == header.page_size &&
    header.encoding == 1 &&
    disk_cursor(template, 32, 40).word() == 0L &&
    disk_cursor(template, 36, 40).word() == 0L &&
    disk_cursor(template, 52, 56).word() == 0L else {
    fail(
      "SQLite template must be UTF-8 with no freelist, reserve or auto-vacuum",
    )
  }
  let writer : PageWriter = {
    size: header.page_size,
    pages: Array::makei(header.pages, page => {
      FixedArray::makei(header.page_size, i => {
        template[page * header.page_size + i]
      })
    }),
  }
  let roots : Map[Int32, Bool] = Map([])
  for tree in plan.trees {
    guard tree.root > 1 &&
      tree.root <= header.pages &&
      !roots.contains(tree.root) else {
      fail("invalid SQLite template root")
    }
    roots[tree.root] = true
    let rows = sqlite_storage_rows(store, tree)
    let rows = if tree.predicate is Some(predicate) {
      let table = get_table(store, tree.table)
      rows.filter(row => {
        truth(
          evaluate(
            predicate,
            evaluation(store, [], row_environment(table, row, table.name)),
          ),
        ) ==
        1
      })
    } else {
      rows
    }
    if tree.kind == "table" || tree.kind == "sequence" {
      rows.sort_by((a, b) => a.id.compare(b.id))
      let ipk = if tree.kind == "sequence" {
        -1
      } else {
        integer_primary(get_table(store, tree.table))
      }
      let records = rows.map(row => {
        let values = row.values.copy()
        if ipk >= 0 {
          values[ipk] = Null
        }
        (row.id, sqlite_record(values))
      })
      writer.table(tree.root, records)
    } else if tree.kind == "index" || tree.kind == "without-rowid" {
      let table = get_table(store, tree.table)
      guard !tree.fields.is_empty() &&
        tree.fields.all(f => {
          f.column >= -2 &&
          f.column < table.columns.length() &&
          (f.column != -2 || f.expression is Some(_)) &&
          ["binary", "nocase", "rtrim"].contains(f.collation)
        }) else {
        fail("invalid SQLite index layout")
      }
      let values = rows.map(row => {
        tree.fields.map(field => {
          if field.column == -2 {
            guard field.expression is Some(e) else {
              fail("missing SQLite index expression")
            }
            evaluate(
              e,
              evaluation(store, [], row_environment(table, row, table.name)),
            )
          } else if field.column < 0 {
            Integer(row.id)
          } else {
            row.values[field.column]
          }
        })
      })
      values.sort_by((a, b) => {
        for i, field in tree.fields {
          let compare = compare_stored(store, a[i], b[i], field.collation)
          if compare != 0 {
            return if field.descending { -compare } else { compare }
          }
        }
        0
      })
      writer.index(tree.root, values.map(sqlite_record))
    } else {
      fail("unsupported SQLite storage tree")
    }
  }
  let first = writer.pages[0]
  let change = disk_cursor(template, 24, 28).word().reinterpret_as_uint64() +
    serial.to_uint64()
  sqlite_word(first, 24, change & 0xffffffffUL, 4)
  sqlite_word(first, 28, writer.pages.length().to_uint64(), 4)
  sqlite_word(first, 92, change & 0xffffffffUL, 4)
  // A non-native writer does not claim a SQLite library version identity.
  sqlite_word(first, 96, 0UL, 4)
  let output = @buffer.Buffer(size_hint=writer.pages.length() * writer.size)
  for page in writer.pages {
    output.write_bytes(Bytes::from_array(page[:])[:])
  }
  output.to_bytes()
}

///|
struct SqliteResult {
  data : Bytes
  info : String
}

///|
pub fn Connection::export_sqlite(
  connection : Connection,
) -> Bytes raise SqliteError {
  connection.healthy()
  guard connection.program is Some(program) && program.storage is Some(storage) else {
    raise sqlite_misuse("program has no prebuilt SQLite storage template")
  }
  sqlite_export(connection.database.store, connection.database.serial, storage) catch {
    error => raise interface_error(public_error(error))
  }
}

///|
pub fn aot_export_sqlite(db : AotDatabase) -> SqliteResult {
  try {
    let (connection, _) = db.ready()
    let bytes = connection.export_sqlite()
    {
      data: bytes,
      info: (
        { "bytes": bytes.length(), "serial": connection.database.serial } : Json).stringify(),
    }
  } catch {
    error =>
      {
        data: b"",
        info: ({ "error": public_error(error) } : Json).stringify(),
      }
  }
}

///|
pub fn sqlite_data(result : SqliteResult) -> Bytes {
  result.data
}

///|
pub fn sqlite_info(result : SqliteResult) -> String {
  result.info
}

///|
pub fn sqlite_data_base64(result : SqliteResult) -> String {
  @base64.encode(result.data)
}
