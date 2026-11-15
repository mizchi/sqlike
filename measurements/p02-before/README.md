# P02着手前の基準

S01完了時点の性能・配信・メモリとP0完了証拠を固定した。記録内の元artifactパスは現行ビルドに更新されるため、このアーカイブへ現行用の鮮度checkerを適用しない。

行ストアの変更前後の比較には、着手前のJS / Wasmを別ファイルに保存し、SHA-256をこの記録の`aot-current.json`と照合したものを使用する。[P02の条件と結果](../../docs/row-store.md)を参照。

[`source.patch`](source.patch)はP02後のproduction MoonBitソースをS01時点へ戻す逆差分。隔離したworkspaceに適用してbaselineを再ビルドするための記録で、現行workspaceへは適用しない。計測用TypeScriptやテストの逆差分は含まない。

隔離コピーで`patch -p1 -E < measurements/p02-before/source.patch`を使う。`-E`は追加した`row_pages.mbt`を削除するために必要。12個の対象ファイルが着手前ソースと一致することを確認した。
