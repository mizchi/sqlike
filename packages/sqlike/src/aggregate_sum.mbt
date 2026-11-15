///|
/// Shared by general, window and physical-row aggregates. Mirrors SQLite's
/// compensated summation and delayed integer-overflow decision (func.c SumCtx).
priv struct SumState {
  mut integer : Int64
  mut real : Double
  mut error : Double
  mut approximate : Bool
  mut overflow : Bool
  mut count : Int64
}

///|
fn sum_state() -> SumState {
  {
    integer: 0L,
    real: 0.0,
    error: 0.0,
    approximate: false,
    overflow: false,
    count: 0L,
  }
}

///|
fn SumState::add_real(self : SumState, value : Double) -> Unit {
  let before = self.real
  let after = before + value
  self.error += if before.abs() > value.abs() {
    before - after + value
  } else {
    value - after + before
  }
  self.real = after
}

///|
fn SumState::init_real(self : SumState) -> Unit {
  if self.integer > -4503599627370496L && self.integer < 4503599627370496L {
    self.real = self.integer.to_double()
    self.error = 0.0
    self.approximate = true
    return
  }
  let small = self.integer % 16384L
  self.real = (self.integer - small).to_double()
  self.error = small.to_double()
  self.approximate = true
}

///|
fn SumState::add_integer(self : SumState, n : Int64) -> Unit {
  if n <= -4503599627370496L || n >= 4503599627370496L {
    let small = n % 16384L
    self.add_real((n - small).to_double())
    self.add_real(small.to_double())
  } else {
    self.add_real(n.to_double())
  }
}

///|
fn SumState::add(self : SumState, value : Value) -> Unit {
  if value is Null {
    return
  }
  self.count += 1L
  let value = aggregate_number(value)
  if value is Integer(n) {
    if !self.approximate {
      let next = self.integer + n
      if (n >= 0L && next >= self.integer) || (n < 0L && next < self.integer) {
        self.integer = next
        return
      }
      self.overflow = true
      self.init_real()
    }
    self.add_integer(n)
  } else {
    if !self.approximate {
      self.init_real()
    }
    self.overflow = false
    self.add_real(as_double(value))
  }
}

///|
fn SumState::finish(self : SumState, name : String) -> Value raise SqlError {
  if self.count == 0L {
    return if name == "total" { Real(0.0) } else { Null }
  }
  if name == "sum" && self.overflow {
    fail("integer overflow")
  }
  if name == "sum" && !self.approximate {
    return Integer(self.integer)
  }
  let result = if !self.approximate {
    self.integer.to_double()
  } else if self.error.is_finite() {
    self.real + self.error
  } else {
    self.real
  }
  sql_real(if name == "avg" { result / self.count.to_double() } else { result })
}
