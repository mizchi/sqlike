///|
/// SQLite file format 3 reader. All offsets, lengths and page ownership are
/// checked before use; no native SQLite or host SQL/parser is involved.
priv struct DiskCursor {
  data : Bytes
  mut position : Int32
  end : Int32
}

///|
priv struct DiskRow {
  key : Int64
  values : Array[Value]
}

///|
priv struct SQLiteFile {
  data : Bytes
  page_size : Int32
  usable : Int32
  pages : Int32
  encoding : Int32
  format : Int32
  owners : Array[Int32]
  parents : Array[Int32]
}

///|
fn DiskCursor::take(c : DiskCursor, n : Int32) -> BytesView raise SqlError {
  guard n >= 0 && n <= c.end - c.position else {
    fail("corrupt SQLite: truncated field")
  }
  let bytes = c.data[c.position:c.position + n]
  c.position += n
  bytes
}

///|
fn DiskCursor::byte(c : DiskCursor) -> Int32 raise SqlError {
  c.take(1)[0].to_int()
}

///|
fn DiskCursor::u16(c : DiskCursor) -> Int32 raise SqlError {
  (c.byte() << 8) | c.byte()
}

///|
fn DiskCursor::word(c : DiskCursor) -> Int64 raise SqlError {
  let mut result = 0L
  for _ in 0..<4 {
    result = (result << 8) | c.byte().to_int64()
  }
  result
}

///|
/// The ninth byte contributes all eight bits (including negative rowids).
fn DiskCursor::varint(c : DiskCursor) -> UInt64 raise SqlError {
  let mut result = 0UL
  for _ in 0..<8 {
    let b = c.byte()
    result = (result << 7) | (b & 127).to_uint64()
    if b < 128 {
      return result
    }
  }
  (result << 8) | c.byte().to_uint64()
}

///|
fn disk_int(value : UInt64, limit : Int32) -> Int32 raise SqlError {
  guard value <= limit.to_uint64() else {
    fail("corrupt SQLite: length/resource limit")
  }
  value.to_int()
}

///|
fn disk_cursor(
  data : Bytes,
  offset : Int32,
  end : Int32,
) -> DiskCursor raise SqlError {
  guard offset >= 0 && end >= offset && end <= data.length() else {
    fail("corrupt SQLite: invalid offset")
  }
  { data, position: offset, end, }
}

///|
fn SQLiteFile::page_number(
  file : SQLiteFile,
  n : Int64,
) -> Int32 raise SqlError {
  guard n >= 1L && n <= file.pages.to_int64() else {
    fail("corrupt SQLite: invalid page number")
  }
  n.to_int()
}

///|
/// Roles match SQLite pointer-map types. 6 is the pointer-map page itself.
fn SQLiteFile::claim(
  file : SQLiteFile,
  page : Int32,
  role : Int32,
  parent : Int32,
) -> Unit raise SqlError {
  guard page >= 1 && page <= file.pages && file.owners[page] == 0 else {
    fail("corrupt SQLite: cyclic/shared page ownership")
  }
  file.owners[page] = role
  file.parents[page] = parent
}

///|
fn SQLiteFile::at(
  file : SQLiteFile,
  page : Int32,
  offset : Int32,
) -> DiskCursor raise SqlError {
  guard page >= 1 && page <= file.pages && offset >= 0 && offset <= file.usable else {
    fail("corrupt SQLite: page offset")
  }
  disk_cursor(
    file.data,
    (page - 1) * file.page_size + offset,
    (page - 1) * file.page_size + file.usable,
  )
}

///|
fn sqlite_header(data : Bytes) -> SQLiteFile raise SqlError {
  guard data.length() >= 100 &&
    data.length() <= 67108864 &&
    data[0:16] == b"SQLite format 3\x00" else {
    fail("invalid SQLite image header/size")
  }
  let c = disk_cursor(data, 16, 100)
  let size = c.u16()
  let page_size = if size == 1 { 65536 } else { size }
  guard page_size >= 512 &&
    page_size <= 65536 &&
    (page_size & (page_size - 1)) == 0 &&
    data.length() % page_size == 0 else {
    fail("corrupt SQLite: page size/truncated image")
  }
  let write_version = c.byte()
  let read_version = c.byte()
  guard (write_version == 1 || write_version == 2) &&
    (read_version == 1 || read_version == 2) else {
    fail("unsupported SQLite file version")
  }
  let usable = page_size - c.byte()
  guard usable >= 480 && c.byte() == 64 && c.byte() == 32 && c.byte() == 32 else {
    fail("corrupt SQLite: page reserve/payload fractions")
  }
  let pages = data.length() / page_size
  let change = c.word()
  let declared = c.word()
  let valid = disk_cursor(data, 92, 100).word()
  guard declared == 0L || change != valid || declared == pages.to_int64() else {
    fail("corrupt SQLite: declared page count")
  }
  let format = disk_cursor(data, 44, 48).word()
  let encoding = disk_cursor(data, 56, 60).word()
  guard format >= 1L && format <= 4L && encoding >= 1L && encoding <= 3L else {
    fail("unsupported SQLite schema format/text encoding")
  }
  guard data[72:92].to_array().all(b => b == b'\x00') else {
    fail("unsupported SQLite header extension")
  }
  {
    data,
    page_size,
    usable,
    pages,
    encoding: encoding.to_int(),
    format: format.to_int(),
    owners: Array::make(pages + 1, 0),
    parents: Array::make(pages + 1, 0),
  }
}

///|
fn SQLiteFile::text(
  file : SQLiteFile,
  bytes : BytesView,
) -> String raise SqlError {
  try {
    if file.encoding == 1 {
      @utf8.decode(bytes, ignore_bom=false)
    } else {
      @utf16.decode(
        bytes,
        ignore_bom=false,
        endianness=if file.encoding == 2 { Little } else { Big },
      )
    }
  } catch {
    _ => fail("corrupt SQLite: malformed text encoding")
  }
}

///|
fn SQLiteFile::record(
  file : SQLiteFile,
  bytes : Bytes,
) -> Array[Value] raise SqlError {
  let header = disk_cursor(bytes, 0, bytes.length())
  let header_size = disk_int(header.varint(), bytes.length())
  guard header_size >= header.position else {
    fail("corrupt SQLite: record header size")
  }
  let header = { ..header, end: header_size, }
  let body = disk_cursor(bytes, header_size, bytes.length())
  let values : Array[Value] = []
  while header.position < header.end {
    guard values.length() < 2000 else {
      fail("SQLite record column resource limit")
    }
    let serial = disk_int(header.varint(), 134217741)
    let value : Value = if serial == 0 {
      Null
    } else if serial == 8 || serial == 9 {
      guard file.format >= 4 else {
        fail("corrupt SQLite: serial type in legacy format")
      }
      Integer((serial - 8).to_int64())
    } else if serial >= 1 && serial <= 7 {
      let width = match serial {
        1 => 1
        2 => 2
        3 => 3
        4 => 4
        5 => 6
        _ => 8
      }
      let mut bits = 0UL
      for b in body.take(width) {
        bits = (bits << 8) | b.to_uint64()
      }
      if serial == 7 {
        let real = bits.reinterpret_as_double()
        guard !real.is_nan() else { fail("unsupported SQLite non-finite REAL") }
        Real(real)
      } else {
        let shift = 64 - width * 8
        Integer(bits.reinterpret_as_int64() << shift >> shift)
      }
    } else if serial >= 12 {
      let bytes = body.take((serial - 12) / 2)
      if serial % 2 == 0 {
        Blob(bytes.to_owned())
      } else {
        Text(file.text(bytes))
      }
    } else {
      fail("corrupt SQLite: reserved serial type")
    }
    values.push(value)
  }
  guard body.position == body.end else {
    fail("corrupt SQLite: trailing record bytes")
  }
  values
}

///|
fn SQLiteFile::payload(
  file : SQLiteFile,
  page : Int32,
  cursor : DiskCursor,
  size : Int32,
  index : Bool,
) -> Bytes raise SqlError {
  guard size >= 1 && size <= 67108864 else {
    fail("corrupt SQLite: payload size")
  }
  let maximum = if index {
    (file.usable - 12) * 64 / 255 - 23
  } else {
    file.usable - 35
  }
  let minimum = (file.usable - 12) * 32 / 255 - 23
  let proposed = minimum + (size - minimum) % (file.usable - 4)
  let local_size = if size <= maximum {
    size
  } else if proposed <= maximum {
    proposed
  } else {
    minimum
  }
  let buffer = @buffer.Buffer()
  buffer.write_bytes(cursor.take(local_size).to_owned())
  let mut remaining = size - local_size
  if remaining > 0 {
    let mut next = file.page_number(cursor.word())
    let mut previous = page
    let mut first = true
    while remaining > 0 {
      file.claim(next, if first { 3 } else { 4 }, previous)
      let overflow = file.at(next, 0)
      let following = overflow.word()
      let count = remaining.min(file.usable - 4)
      buffer.write_bytes(overflow.take(count).to_owned())
      remaining -= count
      previous = next
      first = false
      if remaining > 0 {
        next = file.page_number(following)
      } else {
        guard following == 0L else {
          fail("corrupt SQLite: excess overflow chain")
        }
      }
    }
  }
  buffer.to_bytes()
}

///|
/// In-order traversal includes records on index interior pages (WITHOUT ROWID).
fn SQLiteFile::walk(
  file : SQLiteFile,
  page : Int32,
  index : Bool,
  parent : Int32,
  depth : Int32,
  output : Array[DiskRow],
) -> Int32 raise SqlError {
  guard depth <= 32 else { fail("SQLite B-tree depth resource limit") }
  file.claim(page, if parent == 0 { 1 } else { 5 }, parent)
  let offset = if page == 1 { 100 } else { 0 }
  let header = file.at(page, offset)
  let kind = header.byte()
  guard (if index { kind == 2 || kind == 10 } else { kind == 5 || kind == 13 }) else {
    fail("corrupt SQLite: B-tree page type")
  }
  let interior = kind == 2 || kind == 5
  let mut free = header.u16()
  let count = header.u16()
  let content = header.u16()
  let content = if content == 0 && file.page_size == 65536 {
    65536
  } else {
    content
  }
  let fragments = header.byte()
  let right = if interior { file.page_number(header.word()) } else { 0 }
  let pointers_end = header.position - (page - 1) * file.page_size + count * 2
  guard pointers_end <= content && content <= file.usable && fragments <= 60 else {
    fail("corrupt SQLite: B-tree header/cell array")
  }
  let spans : Array[(Int32, Int32)] = []
  let mut height = -1
  let mut previous_separator : Int64? = None
  for _ in 0..<count {
    let pointer = header.u16()
    guard pointer >= content && pointer < file.usable else {
      fail("corrupt SQLite: cell pointer")
    }
    let cell = file.at(page, pointer)
    let child = if interior { file.page_number(cell.word()) } else { 0 }
    if interior {
      let start = output.length()
      let h = file.walk(child, index, page, depth + 1, output)
      guard height < 0 || height == h else {
        fail("corrupt SQLite: unbalanced B-tree")
      }
      height = h
      if !index {
        guard output.length() > start else {
          fail("corrupt SQLite: empty table subtree")
        }
        if previous_separator is Some(key) {
          guard output[start].key > key else {
            fail("corrupt SQLite: table separator range")
          }
        }
      }
    }
    if kind == 5 {
      let key = cell.varint().reinterpret_as_int64()
      guard previous_separator is None ||
        (previous_separator is Some(previous) && previous < key) else {
        fail("corrupt SQLite: unordered table separators")
      }
      guard !output.is_empty() && output[output.length() - 1].key <= key else {
        fail("corrupt SQLite: table separator")
      }
      previous_separator = Some(key)
    } else {
      let size = disk_int(cell.varint(), 67108864)
      let key = if index { 0L } else { cell.varint().reinterpret_as_int64() }
      if !index && !output.is_empty() {
        guard output[output.length() - 1].key < key else {
          fail("corrupt SQLite: unordered/duplicate rowid")
        }
      }
      let payload = file.payload(page, cell, size, index)
      output.push({ key, values: file.record(payload), })
      guard output.length() <= 100000 else {
        fail("SQLite B-tree row resource limit")
      }
    }
    spans.push((pointer, cell.position - (page - 1) * file.page_size))
  }
  if interior {
    let start = output.length()
    let h = file.walk(right, index, page, depth + 1, output)
    guard height < 0 || height == h else {
      fail("corrupt SQLite: unbalanced right subtree")
    }
    height = h
    if !index && previous_separator is Some(key) {
      guard output.length() > start && output[start].key > key else {
        fail("corrupt SQLite: right separator range")
      }
    }
  }
  // Validate both cell extents and freeblock chains, including overlaps.
  while free != 0 {
    guard free >= content && free + 4 <= file.usable else {
      fail("corrupt SQLite: freeblock pointer")
    }
    let block = file.at(page, free)
    let next = block.u16()
    let size = block.u16()
    guard size >= 4 &&
      size <= file.usable - free &&
      (next == 0 || next >= free + size) else {
      fail("corrupt SQLite: freeblock chain")
    }
    spans.push((free, free + size))
    free = next
  }
  spans.sort_by((a, b) => a.0.compare(b.0))
  let mut end = content
  let mut actual_fragments = 0
  for span in spans {
    guard span.0 >= end && span.1 > span.0 && span.1 <= file.usable else {
      fail("corrupt SQLite: overlapping cells/freeblocks")
    }
    let gap = span.0 - end
    guard gap <= 3 else { fail("corrupt SQLite: unlisted free space") }
    actual_fragments += gap
    end = span.1
  }
  let gap = file.usable - end
  guard gap <= 3 && actual_fragments + gap == fragments else {
    fail("corrupt SQLite: fragmented space count")
  }
  if interior {
    height + 1
  } else {
    0
  }
}

///|
fn SQLiteFile::tree(
  file : SQLiteFile,
  root : Int32,
  index : Bool,
) -> Array[DiskRow] raise SqlError {
  let rows : Array[DiskRow] = []
  ignore(file.walk(root, index, 0, 0, rows))
  rows
}

///|
fn SQLiteFile::freelist(file : SQLiteFile) -> Unit raise SqlError {
  let header = disk_cursor(file.data, 32, 40)
  let mut next = header.word()
  let expected = header.word()
  guard expected <= file.pages.to_int64() else {
    fail("corrupt SQLite: freelist count")
  }
  let mut total = 0
  while next != 0L {
    let page = file.page_number(next)
    file.claim(page, 2, 0)
    total += 1
    let trunk = file.at(page, 0)
    next = trunk.word()
    let count = trunk.word()
    guard count <= ((file.usable - 8) / 4).to_int64() else {
      fail("corrupt SQLite: freelist trunk size")
    }
    for _ in 0..<count.to_int() {
      file.claim(file.page_number(trunk.word()), 2, 0)
      total += 1
    }
  }
  guard total.to_int64() == expected else {
    fail("corrupt SQLite: freelist size mismatch")
  }
}

///|
fn SQLiteFile::reserve_ptrmap(file : SQLiteFile) -> Unit raise SqlError {
  if disk_cursor(file.data, 52, 56).word() == 0L {
    return
  }
  let interval = file.usable / 5 + 1
  for page = 2; page <= file.pages; page = page + interval {
    file.claim(page, 6, 0)
  }
}

///|
fn SQLiteFile::validate_pages(file : SQLiteFile) -> Unit raise SqlError {
  let mapped = disk_cursor(file.data, 52, 56).word() != 0L
  let interval = file.usable / 5 + 1
  for page in 1..<=file.pages {
    guard file.owners[page] != 0 else {
      fail("corrupt SQLite: unreferenced page")
    }
    if !mapped || page == 1 || file.owners[page] == 6 {
      continue
    }
    let map_page = 2 + (page - 2) / interval * interval
    let entry = file.at(map_page, (page - map_page - 1) * 5)
    guard entry.byte() == file.owners[page] &&
      entry.word() == file.parents[page].to_int64() else {
      fail("corrupt SQLite: pointer-map backlink")
    }
  }
}
