# JSON境界とmizchi/x/jsonの評価

2026-11-16、0.0.1時点の隔離試験。`mizchi/x/json`の開発版0.7.0、commit `e7c14c82b28c1aa85e6a6e0ccc45873c763269e6`の実装を隔離したMoon workspaceへコピーして比較した。公開版0.6.1の検証ではない。利用したファイルのhashとcheckoutを計測JSONへ記録し、SQLikeの本番ソース・依存モジュールは置き換えていない。

```sh
# 既定ではghqの兄弟checkout ../xを読む。別パスも指定できる。
just probe-json-facade ../x
```

## 現在残っている処理

JSホストの`JSON.parse`自体はネイティブだが、[aot_execute](../../packages/sqlike/src/aot.mbt)では毎回`@json.parse(bindings)`を呼び、`Array[Json]`を作ってからSQLの`Value`へ変換する。動的SQLにも同じ境界がある。結果は逆に`Value`から`Json`を組み立てて文字列化し、ホストで再びparseする。バイナリDDL / statement / snapshotへの分離後も、bindと結果のJSON ABIは残る。

`mizchi/x/json`の[JS実装](https://github.com/mizchi/x/blob/e7c14c82b28c1aa85e6a6e0ccc45873c763269e6/src/json/json_js.mbt)は、ネイティブ`JSON.parse`の結果を再帰的にMoonBitの`Json`へ変換する。`Json`型やその構築コストをなくすライブラリではない。Wasm / nativeでは[coreへ委譲する](https://github.com/mizchi/x/blob/e7c14c82b28c1aa85e6a6e0ccc45873c763269e6/src/json/json_default.mbt)。

## 比較の範囲

[単体codecの計測](../../measurements/json-facade-probe-current.json)は、同じ公開関数をOxcで圧縮し、小さいbind形式と50オブジェクトのparse / valid、事前構築した50オブジェクトのserializeを比較する。小さいbind形式はint64の文字列、REAL、BLOB、TEXTを含む。`parse_count`は木全体を構築した後にコンテナの要素数を読む。Nodeでwarmup後に8試行を交互に行ったマイクロベンチであり、DB全体の性能や全入力の保証ではない。

[実ランタイムの計測](../../measurements/json-runtime-facade-probe-current.json)は、主キー索引だけのバイナリ実行コアを一時workspaceへコピーし、`aot_execute`のbind parseだけを差し替える。SQLのJSON関数、スキーマ、保存形式、serializerは変更しない。4つのbindを返す同じ問い合わせをNodeで反復し、ホストでのbind文字列生成と結果のparseを時間から除いた。

単体codecでは大きく縮むが、DB側でも必要な数値変換等は共有される。その削減量をSQLikeランタイムからそのまま引くことはできない。今回の実ランタイムではBrotliが**81.09→79.36 KiB**、削減は**1,776 B（1.73 KiB）**だった。小さいbindのparseと実問い合わせは、今回の条件ではcore側より遅くなった。生の試行値と中央値は各JSONへ保存している。

Nodeでの中央値:

| 試験 | core | facade |
| --- | ---: | ---: |
| 小さいbind形式のparse | 0.94 µs | 1.16 µs |
| bind parseだけを替えた問い合わせ全体 | 3.87 µs | 4.38 µs |
| 単体codecのBrotli | 24.38 KiB | 5.47 KiB |
| 実ランタイムのBrotli | 81.09 KiB | 79.36 KiB |

大きいJSONのparseやvalid / serializeでは速くなるケースもあり、処理とサイズに依存する。単体codecの容量差はDBランタイムの削減量ではない。

## 互換性で見つかった差

| 入力・処理 | core側 | facade側 |
| --- | --- | --- |
| 数値`9223372036854775807`のroundtrip | 元の数値表現を保持 | `9223372036854776000`へ変化 |
| 数値キー`2, 1`の順序 | 順序を保持 | `1, 2`へ並べ替え |
| `__proto__`を持つobjectのserialize | キーを保持 | キーが消える |
| 単独サロゲートのエスケープ | parseで拒否 | 受理 |
| 明示したNumberの`repr` | 字句表現を利用 | `Number(n, ..)`からnだけを取り出す |

既定の重複キーの扱いはこの試験では両方とも後勝ちだった。SQLのJSON関数で保持している重複キーとは別の契約なので、両者を混同しない。

とくにbind parseだけの差し替えでも、TEXTに`\ud800`を持つ同じ入力が「拒否」から「問い合わせ成功」へ変わった。この差は、機能不足を拒否して成功結果の互換性を守る方針に合わない。`valid` / serializeの単体で速い場合があることも、全経路の置き換えが安全という根拠にはしない。

## 改善対象

一括置換は採用しない。JS境界で`Json`を再構築せず、型付きbind / 結果を直接受け渡す経路を次の対象にする。

- [ ] JS向けの引数・結果コントラクトを独立させる。INTEGERの精度、REALの負のゼロ・無限大、BLOBの所有権、TEXTの拒否条件を明示する。
- [ ] MoonBitのenum / Map内部表現をJSホストへ公開せず、primitive・FixedArray・opaqueな型で境界を定義する。
- [ ] SQLのJSON関数、canonicalなID / 旧形式のcodec、Wasm向けの既存経路を分けて到達性を確認する。
- [ ] 本家との差分、保存bytes、失敗後状態、Node / ブラウザを確認してから、コード量・実行速度・実際の転送量を比較する。

直接受け渡しは未実装。単なるnative parseへの差し替えより大きな変更になるため、今回の容量差だけから効果を保証しない。
