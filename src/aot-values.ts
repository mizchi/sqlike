import type { ResultCell, Value } from "./contract.ts";
/** MoonBit Double stays REAL even at integral values; Int64 is bigint. */
export function aotBindings(values: Value[]): string {
  return (
    "[" +
    values
      .map((value) => {
        if (value === null) return '{"t":"null"}';
        if (typeof value === "bigint")
          return JSON.stringify({ t: "integer", v: String(value) });
        if (typeof value === "number") {
          if (!Number.isFinite(value))
            throw Error("AOT bindings require finite REAL values");
          return `{"t":"real","v":${Object.is(value, -0) ? "-0.0" : String(value)}}`;
        }
        if (typeof value === "string")
          return JSON.stringify({ t: "text", v: value });
        if (value instanceof Uint8Array)
          return JSON.stringify({ t: "blob", v: Array.from(value) });
        throw Error("unsupported AOT binding");
      })
      .join(",") +
    "]"
  );
}
export function aotValue(cell: ResultCell): Value {
  switch (cell.t) {
    case "null":
      return null;
    case "integer":
      return BigInt(cell.v);
    case "real":
      if (typeof cell.v === "number") return cell.v;
      if (cell.v === "Infinity") return Infinity;
      if (cell.v === "-Infinity") return -Infinity;
      if (cell.v === "-0") return -0;
      throw Error("invalid REAL result");
    case "text":
      return cell.v;
    case "blob":
      return Uint8Array.from(cell.v);
    default:
      throw Error("invalid result cell");
  }
}
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const text = atob(value),
    bytes = new Uint8Array(text.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : Uint8Array.from(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
