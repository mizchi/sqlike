///|
test "segmented index rows split, move, merge and release storage" {
  let original = Array::makei(10000, i => {
    ({ id: i.to_int64(), values: [], } : StoredRow)
  })
  let rows = index_pages(original)
  assert_true(rows.blocks.length() > 1)
  for i in 0..<10000 {
    assert_eq(rows[i].id, i.to_int64())
  }
  for _ in 0..<300 {
    let row = rows.remove(0)
    rows.insert(rows.length(), row)
  }
  assert_eq(rows[0].id, 300L)
  assert_eq(rows[rows.length() - 1].id, 299L)
  for _ in 0..<300 {
    let row = rows.remove(rows.length() - 1)
    rows.insert(0, row)
  }
  assert_eq(rows.map(r => r.id), original.map(r => r.id))
  for _ in 0..<9990 {
    ignore(rows.remove(rows.length() / 2))
  }
  assert_true(rows.blocks.length() <= 2)
  while rows.length() > 0 {
    ignore(rows.remove(0))
  }
  assert_eq(rows.capacity(), 0)
  rows.insert(0, { id: 44L, values: [], })
  assert_eq(rows[0].id, 44L)
}

///|
test "small index stays flat until promotion and released blocks retain no rows" {
  let rows = index_pages([])
  for i in 0..<10000 {
    rows.insert(rows.length(), { id: i.to_int64(), values: [], })
  }
  assert_true(rows.blocks.length() > 1)
  assert_eq(rows.slice(127, 130).map(r => r.id), [127L, 128L, 129L])
  rows[128] = { id: -1L, values: [], }
  assert_eq(rows[128].id, -1L)
  assert_true(rows.blocks.all(block => block.length() <= 256))
}

///|
fn IndexRows::capacity(self : IndexRows) -> Int32 {
  self.blocks.fold(init=0, (total, block) => total + block.capacity())
}

///|
fn[T] IndexRows::map(
  self : IndexRows,
  f : (StoredRow) -> T raise?,
) -> Array[T] raise? {
  let result : Array[T] = []
  for block in self.blocks {
    for row in block {
      result.push(f(row))
    }
  }
  result
}

///|
fn IndexRows::slice(
  self : IndexRows,
  start : Int32,
  end : Int32,
) -> Array[StoredRow] {
  Array::makei(end - start, i => self[start + i])
}
