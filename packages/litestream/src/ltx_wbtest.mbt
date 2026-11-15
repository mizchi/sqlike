///|
test "CRC64 ISO matches Go hash/crc64" {
  let crc = Crc64::{ value: 0xffffffffffffffffUL, }
  crc.write(b"123456789")
  assert_eq(crc.sum(), 0xb90956c775a41001UL)
}

///|
test "LZ4 overlap copies and malformed offsets" {
  assert_eq(lz4_block(b"\x32abc\x03\x00", 9), b"abcabcabc")
  let rejected = try {
    let _ = lz4_block(b"\x00\x00\x00", 4)
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
}
