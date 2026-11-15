///|
test "signed int64 ordering, after-images, tombstones and deterministic binary blocks" {
  let a = lsm_new()
  assert_eq(lsm_put(a, "9223372036854775807", 1, b"max", false), "{}")
  assert_eq(lsm_put(a, "-9223372036854775808", 1, b"min", false), "{}")
  assert_eq(lsm_put(a, "0", 1, b"", false), "{}")
  assert_eq(lsm_key(a, 0), "-9223372036854775808")
  assert_eq(lsm_seek(a, "1"), 2)
  let b = lsm_new()
  assert_eq(lsm_put(b, "0", 2, b"", true), "{}")
  assert_eq(lsm_put(b, "3", 2, b"old", false), "{}")
  assert_eq(lsm_put(b, "3", 2, b"new", false), "{}")
  let merged = lsm_merge(a, b)
  let bytes = lsm_encode(merged)
  let restored = lsm_decode(bytes)
  assert_eq(lsm_info(restored), "{}")
  assert_eq(lsm_count(restored), 4)
  assert_true(lsm_deleted(restored, 1))
  assert_eq(lsm_value(restored, 2), b"new")
  assert_eq(lsm_encode(restored), bytes)
  assert_eq(lsm_size(restored), bytes.length())
  let part = lsm_slice(restored, 1, 2)
  assert_eq(lsm_count(part), 2)
  assert_eq(lsm_key(part, 0), "0")
}

///|
test "corrupt or conflicting blocks are rejected without publishing edits" {
  let a = lsm_new()
  assert_eq(lsm_put(a, "1", 1, b"a", false), "{}")
  let stable = lsm_encode(a)
  assert_true(lsm_put(a, "9223372036854775808", 2, b"b", false) != "{}")
  assert_true(lsm_put(a, "1", 0, b"b", false) != "{}")
  assert_eq(lsm_encode(a), stable)
  let b = lsm_new()
  ignore(lsm_put(b, "1", 1, b"b", false))
  assert_true(lsm_info(lsm_merge(a, b)) != "{}")
  for length in [0, 4, stable.length() - 1] {
    assert_true(lsm_info(lsm_decode(stable[0:length].to_owned())) != "{}")
  }
  let damaged = stable.to_array()
  damaged[12] = b'\xff'
  assert_true(lsm_info(lsm_decode(Bytes::from_array(damaged))) != "{}")
  assert_eq(crc32(b"123456789"), 0xcbf43926U)
}

///|
test "JS and Wasm share an exact binary fixture" {
  let block = lsm_new()
  ignore(lsm_put(block, "-1", 3, b"\x00\xff", false))
  let fixture = b"SLM1\x01\x00\x00\x00\xff\xff\xff\xff\xff\xff\xff\xff\x03\x00\x00\x00\x02\x00\x00\x00\x00\xff\x98\x57\xcb\xf1"
  assert_eq(lsm_encode(block), fixture)
  let restored = lsm_decode(fixture)
  assert_eq(lsm_info(restored), "{}")
  assert_eq(lsm_key(restored, 0), "-1")
  assert_eq(lsm_value(restored, 0), b"\x00\xff")
}

///|
test "valid checksums do not admit unordered keys or invalid sequences" {
  for pair in [(2L, 1L), (1L, 1L)] {
    let block = lsm_new()
    block.entries.push({ key: pair.0, sequence: 1, value: Some(b"a"), })
    block.entries.push({ key: pair.1, sequence: 2, value: Some(b"b"), })
    assert_true(lsm_info(lsm_decode(lsm_encode(block))) != "{}")
  }
  let block = lsm_new()
  block.entries.push({ key: 1L, sequence: 0, value: Some(b"a"), })
  assert_true(lsm_info(lsm_decode(lsm_encode(block))) != "{}")
}
