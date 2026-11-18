# AOTの型付き結果とprepared handle

2026-11-17。SQLの[型付き結果実験](optimization-trials.md)をAOTにも追加した。`mizchi/sqlike/experimental-aot-typed`はJS専用の別entryで、通常SQL / AOTのexportやnpm entryへ混ぜない。

## 契約

事前compileしたProgramを`open(program, image)`で読み、`prepare(db, queryName)`でSELECT専用のhandleを作る。SQL文字列は受け付けず、Program内の既存のprepared IR・列位置・affinity / collationを使う。queryごとに一つのStatementを保持し、DB・行・bind・時計は実行時の値を読む。

`values(handle, bindings)`は既存のCell JSONでbindし、結果を`(bigint | number | string | null | Uint8Array)[][]`で返す。INTEGERはint64の両端もBigInt、REALはnumberとして負のゼロを維持する。重複列は位置を維持し、列名等は`query_info(db, name)`で取得する。BLOBはJS境界でコピーし、返却した配列やbytesの変更がDBへ漏れないようにする。

結果はeagerに全件生成する。Statementの最初のstepで生成済みの行から可視値だけを一度取り出し、JSONの生成・parseと各行の再stepを省く。成功・bindエラー・評価エラーの全てで行Environmentとbindをresetする。`finalize(handle)`は参照とStatement数を解放し、再呼出しも許す。finalize後のvaluesは拒否する。

handleは接続とruntimeに属する。別moduleへ渡さず、cloneした接続では新しくprepareする。同じProgram / schemaとして検証済みのimageをrestoreした後は、既存handleが復元後のStoreを読む。失敗したrestoreは公開しない。保持数・寿命は低レベルAPIの利用側が管理し、グローバルなStatement共有は行わない。

| API | 結果とエラー |
| --- | --- |
| `open(program, image)` | 接続handle。初期化エラーはinfo / prepare後のvaluesで検出 |
| `prepare(db, name)` | query handle。未知名・SELECT以外のエラーはvaluesで検出 |
| `values(query, bindings)` | native行配列。失敗はJS Error |
| `execute(db, name, bindings)` | 従来のJSON応答。DML / transaction等も実行可能 |
| `info`, `query_info`, `snapshot`, `restore`, `set_clock`, `finalize` | 従来と同じJSON応答。errorを利用側で確認 |
| `clone(db)` | 独立した接続handle |

## catalogから選択ビルド

repositoryの`buildSqlikeRuntime()` / `just sqlike-runtime`に、opt-inの`nativeResults: true`を追加した。JSだけを生成し、従来と同じcatalog解析で不要な関数・文・JOIN / CTE等を除去する。必要な機能を欠くProgramはload時に拒否する。SQL parserを含まないことを別に検査する。

```sh
pnpm build:catalog
just sqlike-runtime examples/profiles/notes-native-aot.json generated/notes-native
```

出力は`runtime.js`、接続とStatementを区別する`runtime.d.ts`、選択内容を記録する`profile.json`。Programは対応するcatalogからbuild時にcompileしておく。notes例では`examples/notes/program.generated.json`の内容を`compiledProgram`として渡す。

```ts
import * as runtime from "./generated/notes-native/runtime.js";

const checked = (text: string) => {
  const result = JSON.parse(text);
  if (result.error) throw Error(result.error);
  return result;
};
const db = runtime.open(compiledProgram, "");
checked(runtime.info(db));
checked(runtime.execute(db, "add", '[{"t":"integer","v":"1"},{"t":"text","v":"hello"},{"t":"integer","v":"0"}]'));
const get = runtime.prepare(db, "get");
try {
  const rows = runtime.values(get, '[{"t":"integer","v":"1"}]');
  // [[1n, "hello", 0n]]。表示する場合もtextContent等で扱う。
} finally {
  checked(runtime.finalize(get));
}
```

nativeResultsは現在AOT / JS用。Wasm、binary defined、typed bind、streaming / chunk、npm公開entryは後続とする。SQLite page / LTX / binary syncのexportを同時に要求するprofileも、現段階ではビルド時に拒否する。

## 検証・計測

Statementの再利用・transient bufferの解放・write拒否を先にテストしてRedを確認した。native SQLiteとの値・型・BLOB所有権・重複列・時計 / counter、error後の再実行、restore / clone、finalizeを検査する。上流1,000クエリを全件実行し、既存566ケースは562 trace一致・双方prepare拒否2・AOT対象外DDL 2に分ける。SELECTはnative、DML / PRAGMA等は既存execute経路を使う。

選択ビルドでは不要なwrite機能を使うProgramのload拒否と、生成した型の外部consumerを検査する。通常SQL / AOTからbridgeが消えること、専用entryにSQL parserが入らないことも確認する。

<!-- aot-native-results:start -->
Apple M5 / Chromium 158.0.8127.18、3 sampleの中央値。両方ともnativeのValue配列を返す条件。

| 行数 | 処理 | AOT JSON → native結果 |
| --- | --- | ---: |
| 1,000 | 主キーhit | 1.58→0.68 µs |
| 1,000 | 全件取得 | 0.50→0.15 ms |
| 100,000 | 主キーhit | 1.49→0.72 µs |
| 100,000 | 全件取得 | 81.10→18.45 ms |

専用entryのJS容量（同じ11 export、利用可能なSQL機能はcatalogで異なる）:

| build | minified未圧縮 | Brotli |
| --- | ---: | ---: |
| catalog未選択 | 536,517 B | 102,472 B |
| notes catalog選択 | 433,221 B | 82,245 B |

通常engineの公開exportを揃えた容量比較:

| engine | minified未圧縮 前→後 | Brotli 前→後 |
| --- | ---: | ---: |
| AOT + SQLite writer + LTX | 600,530→600,530 B | 113,321→113,076 B |
| SQLike dynamic SQL | 646,400→646,400 B | 120,768→120,844 B |

通常SQL / AOTのminified未圧縮JS増分は0 B。Brotliの小差も実測値を併記し、bridgeの除去はsymbol / codeの検査と分けて確認した。専用entryと通常engineはexport集合が異なるため、容量の差をbridge単独の増減とは扱わない。

MoonBit 70件×JS / Wasm、Node 403件、Chromium 59件、既存差分566ケース×12経路を通過。native AOTの562 trace一致・双方prepare拒否2・対象外DDL 2と、上流1,000クエリ、生成型の外部consumerも通過した。
<!-- aot-native-results:end -->

`just typed-result-bench`はSQL prepared JSON / nativeと、AOT JSON / nativeの4経路を同じChromiumページで比較する。全経路をnative値の配列に揃え、JSON経路にはparseとCell→BigInt等の変換も含める。AOT JSON経路は従来のnamed execute、nativeはprepare済みhandleを使う。通常のCell配列を返す8経路benchmarkとは数値を混ぜない。

native SQLite画像をimportした後、行データだけを各AOT Programの検証済みschemaへ復元する。初期化は計時外で、実行前後の型付きnative期待値を照合する。1,000 / 100,000行、3 sample・20ms目標、scanは最大2反復、pageのwatchdogは120秒。

[raw report](../../measurements/optimization-typed-results.json)と[容量を含む集計](../../measurements/optimization-trials-current.json)へsource / artifact hashを残す。専用entry単体は通常engineとはexport集合が異なるため、容量の単純な差分として扱わない。heap / RSSの削減率は未測定。
