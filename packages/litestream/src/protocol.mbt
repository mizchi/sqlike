///|
priv suberror Invalid {
  Invalid(String)
}

///|
/// BLS1 frames and SQLite changesets share this bounded, checked reader.
priv struct Reader {
  data : Bytes
  mut pos : Int32
}

///|
fn Reader::take(self : Reader, n : Int32) -> Bytes raise {
  guard n >= 0 && n <= self.data.length() - self.pos else {
    raise Invalid("truncated input")
  }
  let bytes = self.data[self.pos:self.pos + n].to_owned()
  self.pos += n
  bytes
}

///|
fn Reader::byte(self : Reader) -> Int32 raise {
  self.take(1)[0].to_int()
}

///|
fn Reader::u32(self : Reader) -> Int32 raise {
  let mut n = 0L
  for _ in 0..<4 {
    n = (n << 8) | self.byte().to_int64()
  }
  guard n <= 2147483647L else {
    raise Invalid("integer exceeds protocol range")
  }
  n.to_int()
}

///|
fn Reader::varint(self : Reader) -> Int32 raise {
  let mut n = 0L
  for _ in 0..<8 {
    let b = self.byte()
    n = (n << 7) | (b & 127).to_int64()
    guard n <= 1048576L else { raise Invalid("oversized SQLite varint") }
    if b < 128 {
      return n.to_int()
    }
  }
  raise Invalid("oversized SQLite varint")
}

///|
fn encode_frame_checked(
  kind : Int32,
  base : Int32,
  op_id : String,
  payload : Bytes,
) -> Bytes raise {
  let id = @utf8.encode(op_id)
  guard (kind == 1 || kind == 2) &&
    base >= 0 &&
    id.length() > 0 &&
    id.length() <= 256 &&
    payload.length() <= 1048576 else {
    raise Invalid("invalid frame fields")
  }
  let out = @buffer.Buffer()
  out.write_bytes(b"BLS1")
  out.write_byte(kind.to_byte())
  out.write_int_be(base)
  out.write_uint16_be(id.length().to_uint16())
  out.write_int_be(payload.length())
  out.write_bytes(id)
  out.write_bytes(payload)
  out.to_bytes()
}

///|
/// JSON is only the FFI boundary. Payload bytes remain binary on the wire.
fn decode_frame_checked(data : Bytes) -> String raise {
  let r = Reader::{ data, pos: 0, }
  guard r.take(4) == b"BLS1" else { raise Invalid("unknown protocol version") }
  let kind = r.byte()
  guard kind == 1 || kind == 2 else { raise Invalid("unknown operation kind") }
  let base = r.u32()
  let id_len = (r.byte() << 8) | r.byte()
  let size = r.u32()
  guard id_len > 0 && id_len <= 256 && size <= 1048576 else {
    raise Invalid("oversized frame")
  }
  let id = @utf8.decode(r.take(id_len))
  let payload = r.take(size).to_array().map(b => b.to_int())
  guard r.pos == data.length() else { raise Invalid("trailing frame data") }
  let result : Json = {
    "kind": kind,
    "base": base,
    "opId": id,
    "payload": payload,
  }
  result.stringify()
}

///|
/// Idempotency must be checked before rejecting an old revision.
pub fn revision_decision(
  head : Int32,
  base : Int32,
  kind : Int32,
  duplicate : Bool,
) -> String {
  if duplicate {
    "duplicate"
  } else if base < 0 || base > head {
    "future"
  } else if kind == 1 && base != head {
    "stale"
  } else {
    "apply"
  }
}

///|
/// Preserve int64 and blobs across JSON adapters without precision loss.
fn Reader::cell(self : Reader) -> Json raise {
  match self.byte() {
    0 => { "t": "undefined" }
    5 => { "t": "null" }
    1 | 2 as tag => {
      let mut bits = 0UL
      for b in self.take(8) {
        bits = (bits << 8) | b.to_uint64()
      }
      if tag == 1 {
        { "t": "integer", "v": bits.reinterpret_as_int64().to_string() }
      } else {
        let value = bits.reinterpret_as_double()
        guard value.is_finite() else { raise Invalid("non-finite real") }
        { "t": "real", "v": value }
      }
    }
    3 | 4 as tag => {
      let bytes = self.take(self.varint())
      if tag == 3 {
        { "t": "text", "v": @utf8.decode(bytes) }
      } else {
        { "t": "blob", "v": bytes.to_array().map(b => b.to_int()) }
      }
    }
    _ => raise Invalid("unknown SQLite value tag")
  }
}

///|
/// Decode the native SQLite Session changeset format (not a patchset or LTX).
fn decode_changeset_checked(data : Bytes) -> String raise {
  guard data.length() <= 1048576 else { raise Invalid("oversized changeset") }
  let r = Reader::{ data, pos: 0, }
  let changes : Array[Json] = []
  let mut table = ""
  let mut pk : Array[Int32] = []
  let mut columns = 0
  while r.pos < data.length() {
    let op = r.byte()
    if op == 84 {
      columns = r.varint()
      guard columns > 0 && columns <= 2000 else {
        raise Invalid("invalid column count")
      }
      pk = r.take(columns).to_array().map(b => b.to_int())
      guard pk.any(x => x > 0) else {
        raise Invalid("changeset requires a primary key")
      }
      let start = r.pos
      while r.byte() != 0 {
        ()
      }
      table = @utf8.decode(data[start:r.pos - 1])
      guard table != "" &&
        !table.to_lower().has_prefix("_bls_") &&
        !table.to_lower().has_prefix("_litestream_") &&
        !table.to_lower().has_prefix("__turso_") &&
        !table.to_lower().has_prefix("sqlite_") else {
        raise Invalid("reserved table name")
      }
    } else {
      guard columns > 0 && (op == 18 || op == 23 || op == 9) else {
        raise Invalid("invalid changeset operation")
      }
      let indirect = r.byte()
      guard indirect <= 1 else { raise Invalid("invalid indirect flag") }
      let old : Array[Json] = []
      let new : Array[Json] = []
      if op != 18 {
        for _ in 0..<columns {
          old.push(r.cell())
        }
      }
      if op != 9 {
        for _ in 0..<columns {
          new.push(r.cell())
        }
      }
      changes.push({
        "table": table,
        "pk": pk,
        "op": op,
        "old": old,
        "new": new,
      })
    }
  }
  @json.to_json(changes).stringify()
}

///|
/// Stable JS ABI: no dependency on the compiler's Result representation.
/// Invalid input returns empty bytes; the host encoder converts that sentinel to an error.
pub fn encode_frame(
  kind : Int32,
  base : Int32,
  op_id : String,
  payload : Bytes,
) -> Bytes {
  encode_frame_checked(kind, base, op_id, payload) catch {
    _ => b""
  }
}

///|
pub fn decode_frame(data : Bytes) -> String {
  decode_frame_checked(data) catch {
    _ => "{\"error\":\"invalid BLS1 frame\"}"
  }
}

///|
pub fn decode_changeset(data : Bytes) -> String {
  decode_changeset_checked(data) catch {
    _ => "{\"error\":\"invalid SQLite changeset\"}"
  }
}
