# AOT integration example

`mizchi/litestream-example` composes SQLike and Litestream into an application module. `src/runtime` exports browser database execution, the SQLite writer and LTX reader/writer. The distributed runtime excludes the SQL parser.

The `mizchi/sqlike` and `mizchi/litestream` libraries remain independent; this example depends on both and builds through `moon.work`.

Run `just build-lite`, then open `/lite/`. See the [catalog](../notes/catalog.json) and [integration design (Japanese)](../../docs/internal/aot-ltx-plan.md).
