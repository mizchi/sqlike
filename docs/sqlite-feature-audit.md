# SQLite 全機能の互換性監査

不足している機能と、成功時の非互換出力を分けて扱う。[出力互換の契約](sqlite-output-compatibility.md)と`just sqlite-output-check`を追加した。下の`just sqlite-audit`は、引き続き全機能・全検証項目を要求する別のゲートである。

2026-11-15、[index・trigger](sqlike-index-trigger.md)と[一般アプリ向けSQL・任意の全文検索](sqlike-app-features.md)、数値変換・JOIN・集約・JSON等の[差分修正](sqlite-differential-findings.md)、出力互換の拒否方針を適用して再採取した。固定・生成プローブの一致は432件。全機能互換が未達であることは変わらない。任意の全文検索APIは、FTS5仮想テーブルのSQL互換として数えない。

**現在の MoonBit engine は SQLite 全機能互換ではない。** Node 24.22.2 の SQLite 3.53.4 を参照実装として、JS / Wasm GC / Chromium JS を検証した。3対象で同じ結果となり、全互換の判定は失敗した。

```sh
just sqlite-audit
```

現状はレポートを書き出した後に **exit 1** になる。本家が受理する SQL の拒否、値の不一致、未公開 API、未検証、参照ビルドにない機能を、一致に数えない。監査を実行する Playwright テストの成功は「監査が完走した」ことを表し、末尾の厳密な判定が互換性の成否を決める。既存の `just conformance` / `just check` は、それぞれの固定入力を検証するコマンドとして残す。

## 実測結果

追加SQLと既存の文字列・条件関数を含め、一致した固定プローブは432件。各署名だけでなく、境界値の差分コーパスと4実行経路のアプリ機能テストも別途照合する。270件の候補エラーは拒否と非変更の証拠を保持し、出力互換ゲートでは許容するが、全機能監査の一致には数えない。

| 観測 | 件数 | 意味 |
| --- | ---: | --- |
| `matched-probe` | 432 | その項目の固定プローブが本家と一致 |
| `candidate-error` | 270 | 本家が受理した SQL を拒否、または意図したエラー契約と相違 |
| `value-mismatch` | 0 | 実行したプローブの値・型・順序の不一致。今回見つけた GROUP BY の差は修正済み |
| `missing-api` | 306 | 本家の公開 C 関数名に相当するエクスポートがない |
| `not-tested` | 599 | C の型・定数、未実行の関数・拡張・障害試験など |
| `oracle-unavailable` | 11 | 参照ビルドにないオプション関数・PRAGMA・module |
| `oracle-error` | 0 | プローブの想定外の参照実装エラー |
| 合計 | 1,618 | 異なる粒度の索引・振る舞い・検証要件を含む |

これは互換率ではない。関数の1引数形とトランザクションの障害要件を同じ粒度の機能として扱うことはできない。また、一つのプローブの一致は、その機能の全入力・全組み合わせの互換性を証明しない。C ABI の差を除いて SQL だけを見ても、本家が受理する文の拒否が残っている。

| 本家索引の区分 | 項目 | プローブ一致 | 拒否・エラー差 | 参照ビルドになし | 未検証 |
| --- | ---: | ---: | ---: | ---: | ---: |
| SQL 言語の見出し | 42 | 32 | 10 | 0 | 0 |
| Core scalar の署名 | 60 | 32 | 24 | 2 | 2 |
| Aggregate の署名 | 14 | 10 | 4 | 0 | 0 |
| Math の署名 | 30 | 0 | 30 | 0 | 0 |
| Date/time | 7 | 6 | 1 | 0 | 0 |
| Window の署名 | 15 | 15 | 0 | 0 | 0 |
| JSON 関数・演算子 | 36 | 13 | 23 | 0 | 0 |
| PRAGMA | 74 | 9 | 55 | 8 | 2 |
| 拡張の見出し | 16 | 1 | 5 | 1 | 9 |

別途、細かい式・SELECT・DDL・制約など80ケース、出力互換の固定26ケース・3 seedの生成324ケース、システム要件17項目、参照ビルドの登録機能と索引の差45項目も台帳に含めた。

## 再現する差

以下は本家で成功し、MoonBit で失敗する入力の例。レポートの `features[].steps` に準備文を含む入力、各 target の `results[].witness` に最初に差が出た SQL とエラーを保存する。

```sql
ANALYZE;

CREATE VIRTUAL TABLE vt USING fts5(body);

SELECT max(1,3,2);
```

CAST、基本日時、再帰CTE、SQLトランザクション、複合SELECT、複合FKと参照動作は追加した。生成列、timediff・数学関数、windowの全frame構文、JSON5 / JSONB・table-valued JSONなどは未対応。署名の固定プローブ一致を、全入力・全組合せの互換性へ読み替えない。CREATE INDEXの監査プローブも、後続の未対応PRAGMA index_infoで失敗するため候補エラーに残る。

今回、対応済みの GROUP BY でも、NOCASE の列で `'A'` と `'a'` を別グループにする誤りを発見した。比較時に各グループ式の collation を使うよう修正し、BINARY / NOCASE / RTRIM、INTEGER / REAL、NULL、複数キーを native と JS / Wasm GC で照合した。Chromium の監査でも該当ケースが一致する。

## 何を網羅し、何が未検証か

入口の一覧は[本家 SQL 言語索引](https://www.sqlite.org/lang.html)、[core 関数](https://www.sqlite.org/lang_corefunc.html)、aggregate / math / date / window / JSON、[PRAGMA](https://www.sqlite.org/pragma.html)、[C 関数](https://www.sqlite.org/c3ref/funclist.html)・型・定数、[拡張一覧](https://www.sqlite.org/docs.html)から抽出した。[catalog.json](../tests/fixtures/sqlite-catalog/catalog.json) に取得日時・URL・元 HTML の SHA-256・抽出項目を保存する。無効化・非推奨の項目も削除しない。

これは索引の入口を網羅した台帳であり、SQLite の全動作仕様を列挙し尽くしたものではない。各関数の全 arity、NULL・境界値・エラー・すべての修飾子、構文同士の全組み合わせを調べ切った状態ではない。random / randomblob のプローブも型と長さの確認に限定する。参照ビルドの `function_list` / `pragma_list` / `module_list` とも照合し、一覧にあるがプローブのない登録機能を未検証として追加する。

物理 B-tree / SQLite ファイル writer / WAL writer / hot journal 復旧、VFS のロック、複数接続の分離、ネイティブの online backup / incremental BLOB / カスタム関数・collation・各種 hook も完全な互換検証はできていない。IndexedDB 保存や committed LTX reader の既存テストを、これらのネイティブ機能の合格へ読み替えない。

[本家のテスト方式](https://www.sqlite.org/testing.html)には公開 Tcl テストだけでなく、非公開の TH3 / dbsqlfuzz、I/O・メモリ・クラッシュの試験もある。完全な公開 Tcl suite を MoonBit に実行するバインディングは未実装で、TH3 等を入手して全件通したという結果もない。この不足も台帳に残す。

## 判定の再現性

- [Node JS / Wasm GC の全入力と結果](../measurements/sqlite-feature-audit-node.json)
- [Chromium の結果](../measurements/sqlite-feature-audit-chromium.json)
- [比較器と型付き値の保存](../tests/compatibility/feature-audit.ts)
- [索引に対応するプローブ](../tests/compatibility/feature-probes.ts)と[追加の動作・システム要件](../tests/compatibility/feature-requirements.ts)
- [厳密な判定](../scripts/check-sqlite-audit.ts)

DB は項目ごとに新規作成し、SQL の安全性ポリシーや同期層を通さない。本家側が予期せず失敗したケースは oracle エラーとして監査自体を止める。双方が失敗しただけでは合格にしない。型付き・列位置の結果を比較し、順序を指定しない PRAGMA の集合だけを明示的に並べ替える。

判定時には、台帳、入力計画、MoonBit ソース、比較ハーネス、参照ビルド、JS / Wasm 成果物のハッシュと全必須 ID を検査する。古い結果、欠落した結果、未検証項目を含む結果では全互換の判定を成功させない。ブラウザでは SQLite WASM / Turso を取得していないことも確認する。

```sh
# 本家索引を更新する。新しい索引は再監査が必要。
just sqlite-catalog

# 固定した元の1,000問い合わせと生成式の回帰テスト
just conformance
```
