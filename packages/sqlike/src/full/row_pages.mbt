///|
/// An epoch is an identity-bearing mutable cell. Freezing a root also freezes
/// pages owned by that epoch; the next writer takes a fresh one.
priv struct RowEpoch {
  mut shared : Bool
}

///|
priv struct RowPage {
  epoch : RowEpoch
  rows : Array[StoredRow?]
}

///|
/// Stable physical slots, ordered iteration and bounded page copy-on-write.
/// Only roots/epochs are forked. All persistent metadata stays out of images.
priv struct RowPages {
  mut pages : @rowvector.Vector[RowPage]
  mut epoch : RowEpoch
  mut count : Int32
  mut used : Int32
}

///|
fn row_pages(rows : Array[StoredRow]) -> RowPages {
  let epoch = { shared: false, }
  let pages : Array[RowPage] = []
  let mut start = 0
  while start < rows.length() {
    let offset = start
    pages.push({
      epoch,
      rows: Array::makei((rows.length() - start).min(64), i => {
        Some(rows[offset + i])
      }),
    })
    start += 64
  }
  {
    pages: @rowvector.Vector(pages[:]),
    epoch,
    count: rows.length(),
    used: rows.length(),
  }
}

///|
fn RowPages::fork(self : RowPages) -> RowPages {
  self.epoch.shared = true
  { ..self, epoch: { shared: false, }, }
}

///|
fn RowPages::length(self : RowPages) -> Int32 {
  self.count
}

///|
fn RowPages::is_empty(self : RowPages) -> Bool {
  self.count == 0
}

///|
fn RowPages::get_slot(self : RowPages, slot : Int32) -> StoredRow? {
  if slot < 0 || slot >= self.used {
    None
  } else {
    self.pages[slot / 64].rows[slot % 64]
  }
}

///|
/// Logical indexing is needed only at compatibility/DDL boundaries. Point
/// lookup and mutation use stable slots, never dense ordinal positions.
#alias("_[_]")
fn RowPages::at(self : RowPages, index : Int32) -> StoredRow {
  guard index >= 0 && index < self.count else {
    abort("row index out of bounds")
  }
  if self.count == self.used {
    return self.get_slot(index).unwrap()
  }
  let mut logical = 0
  for page in self.pages {
    for row in page.rows {
      if row is Some(row) {
        if logical == index {
          return row
        }
        logical += 1
      }
    }
  }
  abort("row count mismatch")
}

///|
fn RowPages::own_page(self : RowPages, index : Int32) -> RowPage {
  if self.epoch.shared {
    self.epoch = { shared: false, }
  }
  let previous = self.pages[index]
  if physical_equal(previous.epoch, self.epoch) {
    return previous
  }
  let page = { epoch: self.epoch, rows: previous.rows.copy(), }
  self.pages = self.pages.set(index, page)
  page
}

///|
fn RowPages::push(self : RowPages, row : StoredRow) -> Unit {
  if self.epoch.shared {
    self.epoch = { shared: false, }
  }
  if self.used % 64 == 0 {
    self.pages = self.pages.push({ epoch: self.epoch, rows: [Some(row)], })
  } else {
    self.own_page(self.used / 64).rows.push(Some(row))
  }
  self.count += 1
  self.used += 1
}

///|
fn RowPages::set_slot(self : RowPages, slot : Int32, row : StoredRow) -> Unit {
  guard self.get_slot(slot) is Some(_) else { abort("missing row slot") }
  self.own_page(slot / 64).rows[slot % 64] = Some(row)
}

///|
/// Deletion leaves other physical slots unchanged. Occasionally repack after
/// at least half the slots are empty; this bounds tombstones, amortizing O(N).
fn RowPages::remove_slot(self : RowPages, slot : Int32) -> Bool {
  guard self.get_slot(slot) is Some(_) else { abort("missing row slot") }
  self.own_page(slot / 64).rows[slot % 64] = None
  self.count -= 1
  if self.count == 0 || (self.used > 128 && self.used > self.count * 2) {
    let packed = row_pages(self.copy())
    self.pages = packed.pages
    self.epoch = packed.epoch
    self.used = packed.used
    return true
  }
  false
}

///|
/// Iterators retain the old page root, even when a callback mutates this table.
fn RowPages::cursor(self : RowPages) -> RowCursor {
  self.epoch.shared = true
  { pages: self.pages, page: 0, offset: 0, }
}

///|
priv struct RowCursor {
  pages : @rowvector.Vector[RowPage]
  mut page : Int32
  mut offset : Int32
}

///|
fn RowCursor::next(self : RowCursor) -> StoredRow? {
  while self.page < self.pages.length() {
    let page = self.pages[self.page]
    if self.offset >= page.rows.length() {
      self.page += 1
      self.offset = 0
      continue
    }
    let row = page.rows[self.offset]
    self.offset += 1
    if row is Some(row) {
      return Some(row)
    }
  }
  None
}

///|
fn RowPages::slot_entries(self : RowPages) -> Iter[(Int32, StoredRow)] {
  let cursor = self.cursor()
  Iter::new(fn() {
    cursor.next().map(row => (cursor.page * 64 + cursor.offset - 1, row))
  })
}

///|
fn RowPages::iter(self : RowPages) -> Iter[StoredRow] {
  let cursor = self.cursor()
  Iter::new(fn() { cursor.next() })
}

///|
fn RowPages::copy(self : RowPages) -> Array[StoredRow] {
  self.iter().collect()
}

///|
fn[T] RowPages::map(
  self : RowPages,
  f : (StoredRow) -> T raise?,
) -> Array[T] raise? {
  let result : Array[T] = []
  for row in self.iter() {
    result.push(f(row))
  }
  result
}

///|
fn RowPages::filter(
  self : RowPages,
  f : (StoredRow) -> Bool raise?,
) -> Array[StoredRow] raise? {
  let result : Array[StoredRow] = []
  for row in self.iter() {
    if f(row) {
      result.push(row)
    }
  }
  result
}

///|
fn RowPages::any(
  self : RowPages,
  f : (StoredRow) -> Bool raise?,
) -> Bool raise? {
  for row in self.iter() {
    if f(row) {
      return true
    }
  }
  false
}

///|
impl @json.ToJson for RowPages with fn to_json(self) {
  Json::array(self.map(row => @json.to_json(row)))
}

///|
impl @json.FromJson for RowPages with fn from_json(json, path) {
  row_pages(@json.from_json(json, path~))
}
