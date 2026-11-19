# format / printfの初期範囲

2026-11-18、未リリース。`format`関数群として二つの関数名を追加した。baseline / fullで使え、固定catalogのAOT / definedは利用時だけ残す。実装は共通MoonBitで、JS / Wasm / MoonBit出力にJavaScript固有FFIを増やさない。

```sql
SELECT format('%04d:%Q', 42, 'a''b'); -- 0042:'a''b'
SELECT printf('%!.2s', 'あいう');     -- あい
```

対応するのは`%d / %i / %u / %o / %x / %X / %p`、`%s / %z / %q / %Q / %w / %c / %% / %n`。符号・左寄せ・ゼロ埋め・整数の代替表記・桁区切り、幅と精度、`*`引数、SQLでの`l / ll`、文字単位の`!`を扱う。`%n`は出力せず引数も消費しない。整数はint64 / uint64で扱い、Doubleを経由しない。

NULLのformatや引数なしはNULL。空formatは本家3.53.4がNULL、WASM 3.54.1が空文字を返すため、バージョンをまたいだ成功値を保証できず明示拒否する。NULで始まるformatも同じ扱い。欠けた変換引数はNULLとして扱う。文字列はNULで終端し、`%c`はSQLの文字列引数から最初のUnicode scalarを取る。`%q / %w`のNULLは参照版の`(NULL)`、`%Q`は引用符なしの`NULL`で、指定精度も適用する。仕様の根拠は[公式書式説明](https://sqlite.org/printf.html)と[pinned 3.53.4の実装](https://raw.githubusercontent.com/sqlite/sqlite/version-3.53.4/src/printf.c)。

## 明示拒否と上限

- 浮動小数点の`%f / %e / %E / %g / %G`、ordinal、`%j / %J`、`%#q / %#Q`の追加escapeは未対応。
- 未知の変換・不完全な幅や精度は拒否する。SQLiteの不明書式に対する途中までの文字列を成功値として返さない。末尾の単独`%`は対応する。
- byte単位の精度がUTF-8文字を途中で切る場合、portable TEXTへ置換文字を入れず拒否する。非UTF-8 BLOBからのTEXT変換も同様。文字単位なら`!`を使う。
- 出力、幅、精度は最大1 MiB。桁数の読込・repeat・最終追加時に上限を検査し、失敗した書込文を取り消す。SQLite標準の大きな文字列上限への完全互換は主張しない。

[整数・書式の組合せと6経路差分](../../tests/sqlike-format.test.ts)、[JS / Wasmの独立選択・コード除去・capability拒否](../../tests/sqlike-format-profile.test.ts)を用意した。日時・乱数・数学関数全体はこの関数群へ含めない。
