import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
interface Field {
  name: string;
  type: string;
}
interface Variant {
  tag: number;
  name: string;
  fields: string[];
}
const wire = JSON.parse(readFileSync("src/binary-wire.json", "utf8")) as {
  format: string;
  structs: Record<string, Field[]>;
  enums: Record<string, Variant[]>;
};
if (wire.format !== "sqlike-binary-wire@1") throw Error("unknown binary wire contract");
const capabilityText = readFileSync("src/runtime-capabilities.json", "utf8");
const capabilities = JSON.parse(capabilityText) as {
  format: string;
  statements: Record<string, string>;
  expressionGroups: Record<string, string[]>;
};
if (capabilities.format !== "sqlike-runtime-capabilities@1")
  throw Error("unknown decoder capability contract");
const expressionGroup = (variant: string) => Object.entries(capabilities.expressionGroups)
  .find(([, names]) => names.includes(variant))?.[0];
const expressionConstant = (group: string) =>
  "CAP_EXPRESSION_" + group.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase();
const structDecoders: Record<string, readonly [string, string]> = {
  ForeignKey: ["FEATURE_FOREIGN_KEYS", "feature disabled: foreignKeys"],
  TriggerDefinition: ["FEATURE_TRIGGERS", "feature disabled: triggers"],
  Source: ["CAP_QUERY_SOURCE", "catalog capability disabled: query source"],
};
const extra: Record<string, string> = {
  Table: "sequence: 0L, sequence_present: None, rows: row_pages([]),",
  Store:
    "changes: 0, last_rowid: 0L, deferred: false, indexes: Map([]), primary_indexes: Map([]), declaration_sources: Map([]), generated_plans: Map([]), dirty: dirty_state(), transactions: transaction_runtime(), triggers: trigger_runtime(),",
};
function feature(type: string, value: string, target: string): string {
  if (type === "ForeignKey") return `${target}.require_feature(1U)`;
  if (type === "TriggerDefinition") return `${target}.require_feature(2U)`;
  if (type === "Table") return `if ${value}.strict == Some(true) { ${target}.require_feature(4U) }`;
  if (type === "Source")
    return `if ${value}.right == Some(true) || ${value}.natural == Some(true) || ${value}.using_columns.unwrap_or([]).length() > 0 { ${target}.require_feature(8U) }`;
  return "";
}
function enumFeature(type: string, name: string, target: string, first: string): string {
  if (type === "DataStatement" && name === "PreparedPragma")
    return `${target}.require_feature(pragma_features(${first}))`;
  if (type !== "Expr") return "";
  if (name === "Window" || name === "RowNumber") return `${target}.require_feature(64U)`;
  if (name === "CurrentTime") return `${target}.require_feature(32U)`;
  if (name === "Call") return `binary_function_feature(${target}, ${first})`;
  return "";
}
const chunks = [
  `// Generated from src/binary-wire.json by generate-binary-codecs.ts.\n// Contract SHA256: ${createHash("sha256").update(readFileSync("src/binary-wire.json")).digest("hex")}\n// Capability SHA256: ${createHash("sha256").update(capabilityText).digest("hex")}\n// Numeric variant tags and ordered fields are the versioned wire contract.\n`,
];
for (const [type, fields] of Object.entries(wire.structs)) {
  chunks.push(
    `///|\nimpl Binary for ${type} with fn write(value, w) {\n${feature(type, "value", "w")}\n${fields.map((f) => `Binary::write(value.${f.name}, w)`).join("\n")}\n}`,
  );
  const body = `r.enter()\ndefer r.leave()\n${fields.map((f) => `let ${f.name} : ${f.type} = Binary::read(r)`).join("\n")}\nlet value : ${type} = { ${fields.map((f) => f.name).join(", ")}, ${extra[type] ?? ""} }\n${feature(type, "value", "r")}\nvalue`;
  const gate = structDecoders[type];
  chunks.push(`///|\nimpl Binary for ${type} with fn read(r) {\n${gate
    ? `if ${gate[0]} {\n${body}\n} else { fail(${JSON.stringify(gate[1])}) }`
    : body}\n}`);
}
for (const [type, variants] of Object.entries(wire.enums)) {
  if (
    new Set(variants.map((v) => v.tag)).size !== variants.length ||
    variants.some((v) => v.tag < 0 || !Number.isInteger(v.tag))
  )
    throw Error("invalid enum tags");
  chunks.push(
    `///|\nimpl Binary for ${type} with fn write(value, w) {\nmatch value {\n${variants
      .map((v) => {
        const args = v.fields.map((_, i) => `v${i}`);
        return `${v.name}${args.length ? `(${args.join(", ")})` : ""} => { w.uint(${v.tag}U)\n${enumFeature(type, v.name, "w", args[0] ?? "")}\n${args.map((a) => `Binary::write(${a}, w)`).join("\n")}\n}`;
      })
      .join("\n")}\n}\n}`,
  );
  chunks.push(
    `///|\nimpl Binary for ${type} with fn read(r) {\nr.enter()\ndefer r.leave()\nmatch r.uint() {\n${variants
      .map((v) => {
        const args = v.fields.map((_, i) => `v${i}`);
        const body = `${v.fields.map((t, i) => `let v${i} : ${t} = Binary::read(r)`).join("\n")}\n${enumFeature(type, v.name, "r", args[0] ?? "")}\n${v.name}${args.length ? `(${args.join(", ")})` : ""}`;
        const group = type === "Expr" ? expressionGroup(v.name) : undefined;
        return `${v.tag}U => ${group
          ? `if ${expressionConstant(group)} {\n${body}\n} else { fail("catalog capability disabled: expression ${group}") }`
          : `{\n${body}\n}`}`;
      })
      .join("\n")}\n_ => fail("unknown binary ${type} tag")\n}\n}`,
  );
}
// Both reader and writer expose the same operation but cannot share a trait
// object without introducing dynamic dispatch into this small generated codec.
let text = chunks.join("\n\n") + "\n";
text = text.replaceAll(
  "binary_function_feature(w, v0)",
  "w.require_feature(function_features(v0))",
);
text = text.replaceAll(
  "binary_function_feature(r, v0)",
  "r.require_feature(function_features(v0))",
);
writeFileSync("packages/sqlike/src/full/binary_generated.mbt", text);

// Traverse typed IR without a JSON codec or a dependency on the SQL parser.
// Generate from the same field/variant contract so defaults, checks, views,
// indexes, trigger bodies and nested queries cannot silently escape validation.
const checks = [
  `// Generated by generate-binary-codecs.ts from src/binary-wire.json.\n// Contract SHA256: ${createHash("sha256").update(readFileSync("src/binary-wire.json")).digest("hex")}\n// Capability SHA256: ${createHash("sha256").update(capabilityText).digest("hex")}`,
  "///|\npriv trait FeatureCheck { fn check(Self) -> Unit raise SqlError }",
  ...["Int32", "Bool", "String", "Value"].map(
    (t) => `///|\nimpl FeatureCheck for ${t} with fn check(_) {}`,
  ),
  "///|\nimpl[A : FeatureCheck] FeatureCheck for Array[A] with fn check(values) { for v in values { FeatureCheck::check(v) } }",
  "///|\nimpl[A : FeatureCheck] FeatureCheck for A? with fn check(value) { if value is Some(v) { FeatureCheck::check(v) } }",
  "///|\nimpl[A : FeatureCheck, B : FeatureCheck] FeatureCheck for (A, B) with fn check(value) { FeatureCheck::check(value.0)\nFeatureCheck::check(value.1) }",
];
for (const [type, fields] of Object.entries(wire.structs).filter(
  ([t]) => !["Store", "StorageTree", "StorageField", "StoredRow"].includes(t),
))
  checks.push(
    `///|\nimpl FeatureCheck for ${type} with fn check(value) {\n${type === "Selection" ? "for part in runtime_selection_parts(value) { validate_runtime_query_part(part) }\n" : ""}${fields.map((f) => `FeatureCheck::check(value.${f.name})`).join("\n")}\n}`,
  );
for (const [type, variants] of Object.entries(wire.enums).filter(([t]) => t !== "RowEdit")) {
  checks.push(
    `///|\nimpl FeatureCheck for ${type} with fn check(value) { match value {\n${variants
      .map((v) => {
        const args = v.fields.map((_, i) => `v${i}`);
        let guard =
          type === "DataStatement" && v.name === "PreparedPragma"
            ? "validate_pragma_features(v0)"
            : type !== "Expr"
              ? ""
              : v.name === "Window" || v.name === "RowNumber"
                ? 'guard FEATURE_WINDOWS else { fail("feature disabled: windowFunctions") }'
                : v.name === "CurrentTime"
                  ? 'guard FEATURE_DATETIME else { fail("feature disabled: dateTime") }'
                  : v.name === "Call"
                    ? "validate_function_features(v0)"
                    : "";
        if (type === "Expr" && v.name === "Call")
          guard += "\nvalidate_runtime_call(v0, v1.length())\nvalidate_runtime_json_values(v0, v1)";
        if (type === "Expr" && v.name === "Binary")
          guard += '\nif CAP_CATALOG_SPECIALIZED && !CAP_FUNCTION_LIKE && v0 == "like" { fail("catalog capability disabled: function like") }';
        if (type === "Expr" && v.name === "InSelect")
          guard += '\nvalidate_runtime_query_part("inSelect")';
        if (type === "DataStatement") {
          const kinds: Record<string, string> = {
            PreparedSelect: "select",
            PreparedInsert: "insert",
            PreparedUpdate: "update",
            PreparedDelete: "delete",
            PreparedPragma: "pragma",
            PreparedTransaction: "transaction",
          };
          if (!kinds[v.name]) throw Error(`unclassified statement capability ${v.name}`);
          guard += `\nvalidate_runtime_statement(${JSON.stringify(kinds[v.name])})`;
        }
        if (!args.length && !guard) return `${v.name} => ()`;
        const body = `${guard}\n${args.map((a) => `FeatureCheck::check(${a})`).join("\n")}`;
        const group = type === "Expr" ? expressionGroup(v.name) : undefined;
        return `${v.name}${args.length ? `(${args.join(", ")})` : ""} => ${group
          ? `if ${expressionConstant(group)} {\n${body}\n} else { fail("catalog capability disabled: expression ${group}") }`
          : `{\n${body}\n}`}`;
      })
      .join("\n")}\n} }`,
  );
}
writeFileSync("packages/sqlike/src/full/feature_validation_generated.mbt", checks.join("\n\n") + "\n");

// The JSON wire uses the same positional enum fields. Gate before decoding
// disabled variants so FromJson cannot root their entire field-type closure.
const json = [
  `// Generated by scripts/generate-binary-codecs.ts.\n// Contract SHA256: ${createHash("sha256").update(readFileSync("src/binary-wire.json")).digest("hex")}\n// Capability SHA256: ${createHash("sha256").update(capabilityText).digest("hex")}\n`,
];
const expressionDecoders: Record<string, readonly [string, string]> = {
  CurrentTime: ["FEATURE_DATETIME", "feature disabled: dateTime"],
  RowNumber: ["FEATURE_WINDOWS", "feature disabled: windowFunctions"],
  Window: ["FEATURE_WINDOWS", "feature disabled: windowFunctions"],
  InSelect: ["CAP_QUERY_IN_SELECT", "catalog capability disabled: query inSelect"],
};
for (const type of ["Expr", "DataStatement"]) {
  const cases = wire.enums[type]!.map((variant) => {
    const args = variant.fields.map((_, i) => `v${i}`);
    let guard = "";
    if (type === "DataStatement") {
      const kind = Object.entries(capabilities.statements).find(
        ([, tag]) => tag === variant.name,
      )?.[0];
      if (!kind) throw Error(`unclassified JSON statement ${variant.name}`);
      const constant = kind.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase();
      guard = `guard CAP_STATEMENT_${constant} else { raise path.error("catalog capability disabled: statement ${kind}") }`;
    } else {
      const feature = expressionDecoders[variant.name];
      if (feature) guard = `guard ${feature[0]} else { raise path.error(${JSON.stringify(feature[1])}) }`;
      const group = expressionGroup(variant.name);
      if (group)
        guard = `guard ${expressionConstant(group)} else { raise path.error("catalog capability disabled: expression ${group}") }\n` + guard;
    }
    const pattern = args.length
      ? `Array([String(${JSON.stringify(variant.name)}), ${args.join(", ")}])`
      : `String(${JSON.stringify(variant.name)})`;
    return `${pattern} => {
${guard}
${variant.fields.map((field, i) => `let x${i} : ${field} = @json.from_json(v${i}, path=path.add_index(${i + 1}))`).join("\n")}
${variant.name}${args.length ? `(${args.map((_, i) => `x${i}`).join(", ")})` : ""}
}`;
  });
  json.push(`///|\nimpl @json.FromJson for ${type} with fn from_json(json, path) {
match json {
${cases.join("\n")}
_ => raise path.error("invalid ${type} tag or arity")
}
}`);
}
// Struct optional fields use omitted keys / unwrapped values, unlike an Option
// in an enum's positional fields. Match the derived FromJson wire semantics.
json.push(`///|
fn[T : @json.FromJson] json_required_field(fields : Map[String, Json], key : String, path : @json.DecodeContext) -> T raise @json.JsonDecodeError {
let path = path.add_key(key)
match fields.get(key) {
Some(value) => @json.from_json(value, path~)
None => raise path.error("missing required field")
}
}
///|
fn[T : @json.FromJson] json_optional_field(fields : Map[String, Json], key : String, path : @json.DecodeContext) -> T? raise @json.JsonDecodeError {
match fields.get(key) {
Some(value) => Some(@json.from_json(value, path=path.add_key(key)))
None => None
}
}`);
const compactStructs = [
  ...Object.keys(structDecoders),
  "Ordering", "Projection", "Selection", "ColumnDef", "Table", "SchemaObject",
  "Insertion", "CompiledQuery", "StorageTree", "StorageField",
];
for (const type of compactStructs) {
  const fields = [...wire.structs[type]!];
  // The binary schema keeps row state in a separate frame. The existing JSON
  // image embeds it in Table; keep those required fields and its optional flag.
  if (type === "Table") fields.push(
    { name: "sequence", type: "Int64" },
    { name: "sequence_present", type: "Option[Bool]" },
    { name: "rows", type: "RowPages" },
  );
  const gate = structDecoders[type];
  const helper = "json_decode_" + type.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase());
  if (gate) json.push(`///|\nimpl @json.FromJson for ${type} with fn from_json(json, path) {
if ${gate[0]} { ${helper}(json, path) } else { raise path.error(${JSON.stringify(gate[1])}) }
}`);
  json.push(`///|\n${gate
    ? `fn ${helper}(json : Json, path : @json.DecodeContext) -> ${type} raise @json.JsonDecodeError`
    : `impl @json.FromJson for ${type} with fn from_json(json, path)`} {
guard json is Object(json_fields) else { raise path.error("expected ${type} object") }
${fields.map((f) => {
    const optional = /^Option\[(.*)\]$/.exec(f.type);
    return `let ${f.name} : ${f.type} = json_${optional ? "optional" : "required"}_field(json_fields, ${JSON.stringify(f.name)}, path)`;
  }).join("\n")}
{ ${fields.map((f) => f.name).join(", ")} }
}`);
}
writeFileSync("packages/sqlike/src/full/json_decode_generated.mbt", json.join("\n\n") + "\n");
