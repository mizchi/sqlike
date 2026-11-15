///|
// Wire v1: SQLK, version:u8, kind:u8, reserved:u16, features:u32le,
// payloadLength:u32le, string-pool + typed payload, SHA256(header + payload).
// Format ownership is independent of JSON derives and generated JS internals.
priv struct BinaryWriter {
  out : @buffer.Buffer
  strings : Array[String]
  ids : Map[String, UInt32]
  mut features : UInt32
}

///|
priv struct BinaryReader {
  bytes : BytesView
  mut position : Int32
  strings : Array[String]
  mut depth : Int32
  declared : UInt32
  mut features : UInt32
}

///|
priv trait Binary {
  fn write(Self, BinaryWriter) -> Unit raise SqlError
  fn read(BinaryReader) -> Self raise SqlError
}

///|
fn binary_writer() -> BinaryWriter {
  { out: @buffer.Buffer(), strings: [], ids: Map([]), features: 0U, }
}

///|
fn BinaryWriter::require_feature(w : BinaryWriter, flag : UInt32) -> Unit {
  w.features = w.features | flag
}

///|
fn BinaryReader::require_feature(r : BinaryReader, flag : UInt32) -> Unit {
  r.features = r.features | flag
}

///|
fn BinaryWriter::uint(w : BinaryWriter, value : UInt32) -> Unit {
  let mut n = value
  while n >= 128U {
    w.out.write_byte(((n & 127U) | 128U).to_byte())
    n = n >> 7
  }
  w.out.write_byte(n.to_byte())
}

///|
fn BinaryReader::byte(r : BinaryReader) -> Byte raise SqlError {
  guard r.position < r.bytes.length() else {
    fail("truncated binary definition")
  }
  let value = r.bytes[r.position]
  r.position += 1
  value
}

///|
fn BinaryReader::uint(r : BinaryReader) -> UInt32 raise SqlError {
  let mut value = 0U
  for i in 0..<5 {
    let b = r.byte().to_uint()
    guard i < 4 || b < 16U else { fail("binary integer overflow") }
    value = value | ((b & 127U) << (i * 7))
    if b < 128U {
      guard i == 0 || b != 0U else { fail("noncanonical binary integer") }
      return value
    }
  }
  fail("binary integer overflow")
}

///|
fn BinaryReader::length(r : BinaryReader) -> Int32 raise SqlError {
  let n = r.uint()
  guard n <= 67108864U &&
    n <= (r.bytes.length() - r.position).reinterpret_as_uint() else {
    fail("binary length resource limit")
  }
  n.reinterpret_as_int()
}

///|
fn BinaryReader::blob(r : BinaryReader) -> Bytes raise SqlError {
  let n = r.length()
  let value = r.bytes[r.position:r.position + n].to_owned()
  r.position += n
  value
}

///|
fn BinaryReader::enter(r : BinaryReader) -> Unit raise SqlError {
  guard r.depth < 256 else { fail("binary nesting resource limit") }
  r.depth += 1
}

///|
fn BinaryReader::leave(r : BinaryReader) -> Unit {
  r.depth -= 1
}

///|
fn BinaryReader::finish(r : BinaryReader) -> Unit raise SqlError {
  guard r.position == r.bytes.length() && r.features == r.declared else {
    fail("binary trailing bytes or feature mismatch")
  }
}

///|
fn binary_hex(bytes : BytesView) -> String {
  let out = StringBuilder()
  let digits = "0123456789abcdef"
  for byte in bytes {
    out.write_char(digits[byte.to_int() >> 4].to_int().unsafe_to_char())
    out.write_char(digits[byte.to_int() & 15].to_int().unsafe_to_char())
  }
  out.to_string()
}

///|
fn binary_id(bytes : Bytes) -> String {
  binary_hex(bytes[bytes.length() - 32:])
}

///|
fn binary_finish(w : BinaryWriter, kind : Int32) -> Bytes raise SqlError {
  let payload = @buffer.Buffer()
  let pool = binary_writer()
  pool.uint(w.strings.length().reinterpret_as_uint())
  payload.write_bytes(pool.out.to_bytes()[:])
  for text in w.strings {
    let bytes = @utf8.encode(text)
    guard (@utf8.decode(bytes[:]) catch { _ => "" }) == text else {
      fail("binary text must be valid UTF8")
    }
    let prefix = binary_writer()
    prefix.uint(bytes.length().reinterpret_as_uint())
    payload.write_bytes(prefix.out.to_bytes()[:])
    payload.write_bytes(bytes[:])
  }
  payload.write_bytes(w.out.to_bytes()[:])
  guard payload.length() <= 67108816 && w.strings.length() <= 100000 else {
    fail("binary output resource limit")
  }
  let out = @buffer.Buffer()
  out.write_bytes(b"SQLK"[:])
  out.write_byte(b'\x01')
  out.write_byte(kind.to_byte())
  out.write_byte(b'\x00')
  out.write_byte(b'\x00')
  out.write_uint_le(w.features)
  out.write_uint_le(payload.length().reinterpret_as_uint())
  out.write_bytes(payload.to_bytes()[:])
  out.write_iter(@crypto.sha256(out.to_bytes()).iter())
  out.to_bytes()
}

///|
fn binary_reader(
  bytes : Bytes,
  kind : Int32,
  limit : Int32,
) -> BinaryReader raise SqlError {
  guard bytes.length() >= 48 &&
    bytes.length() <= limit &&
    bytes[0:4] == b"SQLK"[:] &&
    bytes[4] == b'\x01' &&
    bytes[5].to_int() == kind &&
    bytes[6] == b'\x00' &&
    bytes[7] == b'\x00' else {
    fail("unsupported binary definition header")
  }
  let word = fn(start : Int32) {
    let mut n = 0U
    for i in 0..<4 {
      n = n | (bytes[start + i].to_uint() << (i * 8))
    }
    n
  }
  let declared = word(8)
  let allowed = (if FEATURE_SQL_JSON { 16U } else { 0U }) |
    (if FEATURE_DATETIME { 32U } else { 0U }) |
    (if FEATURE_WINDOWS { 64U } else { 0U }) |
    (if FEATURE_FOREIGN_KEYS { 1U } else { 0U }) |
    (if FEATURE_TRIGGERS { 2U } else { 0U }) |
    (if FEATURE_STRICT { 4U } else { 0U }) |
    (if FEATURE_OUTER_JOIN { 8U } else { 0U })
  guard (declared & allowed) == declared &&
    word(12) == (bytes.length() - 48).reinterpret_as_uint() else {
    fail("binary length or required feature mismatch")
  }
  let digest = @crypto.sha256(bytes[0:bytes.length() - 32])
  for i in 0..<32 {
    guard digest[i] == bytes[bytes.length() - 32 + i] else {
      fail("binary checksum mismatch")
    }
  }
  let r = {
    bytes: bytes[16:bytes.length() - 32],
    position: 0,
    strings: [],
    depth: 0,
    declared,
    features: 0U,
  }
  let count = r.length()
  guard count <= 100000 else { fail("binary string pool limit") }
  let unique : Map[String, Bool] = Map([])
  for _ in 0..<count {
    let text = @utf8.decode(r.blob()[:]) catch {
      _ => fail("invalid binary UTF8")
    }
    guard !unique.contains(text) else {
      fail("duplicate binary string pool entry")
    }
    unique[text] = true
    r.strings.push(text)
  }
  r
}

///|
impl Binary for Int32 with fn write(value, w) {
  w.uint(
    (value.reinterpret_as_uint() << 1) ^ (value >> 31).reinterpret_as_uint(),
  )
}

///|
impl Binary for Int32 with fn read(r) {
  let n = r.uint()
  let v = (n >> 1).reinterpret_as_int()
  if (n & 1U) == 1U {
    -v - 1
  } else {
    v
  }
}

///|
impl Binary for Int64 with fn write(value, w) {
  w.out.write_int64_le(value)
}

///|
impl Binary for Int64 with fn read(r) {
  let mut n = 0UL
  for i in 0..<8 {
    n = n | (r.byte().to_uint64() << (i * 8))
  }
  n.reinterpret_as_int64()
}

///|
impl Binary for Double with fn write(value, w) {
  guard !value.is_nan() else { fail("invalid binary REAL") }
  Binary::write(value.reinterpret_as_int64(), w)
}

///|
impl Binary for Double with fn read(r) {
  let bits : Int64 = Binary::read(r)
  let value = bits.reinterpret_as_double()
  guard !value.is_nan() else { fail("invalid binary REAL") }
  value
}

///|
impl Binary for Bool with fn write(value, w) {
  w.uint(if value { 1U } else { 0U })
}

///|
impl Binary for Bool with fn read(r) {
  match r.uint() {
    0U => false
    1U => true
    _ => fail("invalid binary bool")
  }
}

///|
impl Binary for String with fn write(value, w) {
  let id = match w.ids.get(value) {
    Some(id) => id
    None => {
      let id = w.strings.length().reinterpret_as_uint()
      w.ids[value] = id
      w.strings.push(value)
      id
    }
  }
  w.uint(id)
}

///|
impl Binary for String with fn read(r) {
  let n = r.uint()
  guard n < r.strings.length().reinterpret_as_uint() else {
    fail("invalid binary string reference")
  }
  r.strings[n.reinterpret_as_int()]
}

///|
impl Binary for Bytes with fn write(value, w) {
  w.uint(value.length().reinterpret_as_uint())
  w.out.write_bytes(value[:])
}

///|
impl Binary for Bytes with fn read(r) {
  r.blob()
}

///|
impl[A : Binary] Binary for Array[A] with fn write(values, w) {
  guard values.length() <= 100000 else { fail("binary array resource limit") }
  w.uint(values.length().reinterpret_as_uint())
  for value in values {
    Binary::write(value, w)
  }
}

///|
impl[A : Binary] Binary for Array[A] with fn read(r) {
  r.enter()
  defer r.leave()
  let n = r.length()
  guard n <= 100000 else { fail("binary array resource limit") }
  let values = []
  for _ in 0..<n {
    values.push(Binary::read(r))
  }
  values
}

///|
impl[A : Binary] Binary for A? with fn write(value, w) {
  match value {
    None => w.uint(0U)
    Some(value) => {
      w.uint(1U)
      Binary::write(value, w)
    }
  }
}

///|
impl[A : Binary] Binary for A? with fn read(r) {
  match r.uint() {
    0U => None
    1U => Some(Binary::read(r))
    _ => fail("invalid binary option")
  }
}

///|
impl[A : Binary, B : Binary] Binary for (A, B) with fn write(value, w) {
  Binary::write(value.0, w)
  Binary::write(value.1, w)
}

///|
impl[A : Binary, B : Binary] Binary for (A, B) with fn read(r) {
  (Binary::read(r), Binary::read(r))
}

///|
impl Binary for Value with fn write(value, w) {
  match value {
    Null => w.uint(0U)
    Integer(v) => {
      w.uint(1U)
      Binary::write(v, w)
    }
    Real(v) => {
      w.uint(2U)
      Binary::write(v, w)
    }
    Text(v) => {
      w.uint(3U)
      Binary::write(v, w)
    }
    Blob(v) => {
      w.uint(4U)
      Binary::write(v, w)
    }
  }
}

///|
impl Binary for Value with fn read(r) {
  match r.uint() {
    0U => Null
    1U => Integer(Binary::read(r))
    2U => Real(Binary::read(r))
    3U => Text(Binary::read(r))
    4U => Blob(Binary::read(r))
    _ => fail("unknown binary value tag")
  }
}
