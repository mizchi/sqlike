///|
/// Mutable derived cache, never serialized or shared across store checkpoints.
/// Small/rowid indexes keep one flat array; large secondary indexes use leaves.
priv struct IndexRows {
  blocks : Array[Array[StoredRow]]
  ends : Array[Int32]
  mut count : Int32
  allow_pages : Bool
}

///|
fn index_pages(rows : Array[StoredRow], pages~ : Bool = true) -> IndexRows {
  let result = {
    blocks: [],
    ends: [],
    count: rows.length(),
    allow_pages: pages,
  }
  if pages && rows.length() > 8192 {
    let mut start = 0
    while start < rows.length() {
      let end = (start + 128).min(rows.length())
      result.blocks.push(rows[start:end].to_owned())
      result.ends.push(end)
      start = end
    }
  } else if !rows.is_empty() {
    result.blocks.push(rows)
    result.ends.push(rows.length())
  }
  result
}

///|
fn IndexRows::length(self : IndexRows) -> Int32 {
  self.count
}

///|
fn IndexRows::bound(self : IndexRows, before : (StoredRow) -> Bool) -> Int32 {
  if self.count == 0 {
    return 0
  }
  let mut low = 0
  let mut high = self.blocks.length()
  while low < high {
    let mid = low + (high - low) / 2
    let block = self.blocks[mid]
    if before(block[block.length() - 1]) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  if low == self.blocks.length() {
    return self.count
  }
  let page = low
  let block = self.blocks[page]
  low = 0
  high = block.length()
  while low < high {
    let mid = low + (high - low) / 2
    if before(block[mid]) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  (if page == 0 { 0 } else { self.ends[page - 1] }) + low
}

///|
fn IndexRows::block_at(self : IndexRows, position : Int32) -> Int32 {
  if self.blocks.length() == 1 {
    return 0
  }
  let mut low = 0
  let mut high = self.ends.length()
  while low < high {
    let mid = low + (high - low) / 2
    if self.ends[mid] <= position {
      low = mid + 1
    } else {
      high = mid
    }
  }
  low.min(self.blocks.length() - 1)
}

///|
#alias("_[_]")
fn IndexRows::at(self : IndexRows, position : Int32) -> StoredRow {
  let block = self.block_at(position)
  self.blocks[block][position -
  (if block == 0 { 0 } else { self.ends[block - 1] })]
}

///|
#alias("_[_]=_")
fn IndexRows::set(self : IndexRows, position : Int32, row : StoredRow) -> Unit {
  let block = self.block_at(position)
  self.blocks[block][position -
  (if block == 0 { 0 } else { self.ends[block - 1] })] = row
}

///|
fn IndexRows::insert(
  self : IndexRows,
  position : Int32,
  row : StoredRow,
) -> Unit {
  if self.blocks.is_empty() {
    self.blocks.push([row])
    self.ends.push(1)
    self.count = 1
    return
  }
  let block = self.block_at(position)
  self.blocks[block].insert(
    position - (if block == 0 { 0 } else { self.ends[block - 1] }),
    row,
  )
  self.count += 1
  for i in block..<self.ends.length() {
    self.ends[i] += 1
  }
  if !self.allow_pages {
    return
  }
  if self.blocks.length() == 1 {
    if self.count > 8192 {
      let promoted = index_pages(self.blocks[0])
      self.blocks.clear()
      self.ends.clear()
      for i, page in promoted.blocks {
        self.blocks.push(page)
        self.ends.push(promoted.ends[i])
      }
    }
  } else if self.blocks[block].length() > 256 {
    let old = self.blocks[block]
    let end = self.ends[block]
    self.blocks[block] = old[:128].to_owned()
    self.blocks.insert(block + 1, old[128:].to_owned())
    self.ends[block] = end - (old.length() - 128)
    self.ends.insert(block + 1, end)
  }
}

///|
fn IndexRows::remove(self : IndexRows, position : Int32) -> StoredRow {
  let block = self.block_at(position)
  let page = self.blocks[block]
  let row = page.remove(
    position - (if block == 0 { 0 } else { self.ends[block - 1] }),
  )
  self.count -= 1
  for i in block..<self.ends.length() {
    self.ends[i] -= 1
  }
  if self.count == 0 {
    self.blocks.clear()
    self.ends.clear()
    self.blocks.shrink_to_fit()
    self.ends.shrink_to_fit()
  } else if page.is_empty() {
    ignore(self.blocks.remove(block))
    ignore(self.ends.remove(block))
    self.blocks.shrink_to_fit()
  } else if self.blocks.length() > 1 && page.length() < 64 {
    let left = if block + 1 < self.blocks.length() { block } else { block - 1 }
    if self.blocks[left].length() + self.blocks[left + 1].length() <= 256 {
      self.blocks[left] = self.blocks[left] + self.blocks[left + 1]
      self.ends[left] = self.ends[left + 1]
      ignore(self.blocks.remove(left + 1))
      ignore(self.ends.remove(left + 1))
      // Release removed leaf references on Wasm as well as JS.
      self.blocks.shrink_to_fit()
    }
  } else if page.length() * 4 < page.capacity() {
    page.shrink_to_fit()
  }
  row
}
