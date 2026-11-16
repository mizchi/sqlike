# npm配布

`npm/sqlike`を`@mizchi/sqlike`、`npm/litestream`を`@mizchi/litestream`として公開する。両方とも初版0.1.0・ESM・MIT。ルートはprivateなデモ / 検証workspaceで、公開しない。Mooncakesの両モジュールも独立したまま維持する。

SQLikeにはJSの実行エンジン、固定DDL / statementのバイナリ実行、独立したNode用compiler、任意のDrizzle entryとWasm GCのassetを含む。compiler・SQLite exporter・Drizzleは別entry。SQLikeのroot / definedにはLitestream、SQLite WASM、Turso、FTS、実験的LSMを読み込まない。機能選択ビルドそのもののツールはリポジトリから使い、生成したruntimeを注入する。

Litestreamは同期engine / client、policy、HTTP / peer / LTX transport、Session codec、LTX、IndexedDBのreplica storeとNode SQLiteのadapterを公開する。依存は同期のhash用`@noble/hashes`で、DBエンジンの本体は含めない。デモ用notes schemaの初期化は既存engine / clientの動作に含まれる。全driverの全SQLを受理するものではない。

## 作成・検査

```sh
pnpm install --frozen-lockfile
moon update
just npm-check
```

`generated/npm/`に2つのtarballと`audit.json`を作る。OxcでESMを圧縮し、公開export・プロパティ名・purity / license commentを維持する。型定義はTypeScript CLIから生成し、内部のopaque handleのABI宣言を同梱する。

検査はtarballを別ディレクトリへinstallし、workspaceを参照せず実行する。本家sqllogictestの31文・1,000 queryもnative SQLiteと差分比較する。Nodeのnative SQLiteとの差分、binary catalog、SQLite / LTX画像、厳密な型定義、ChromiumのJS / Wasm GC・実IndexedDB・再読込・offline書込を含む。Drizzleは別途installしてmigrationとnested transactionを確認する。配布内容とchunk graphも調べ、任意entryがrootへ混入した場合は落とす。

## 初回公開

```sh
npm login --auth-type=web
npm whoami                          # mizchiを確認
just npm-publish
npm view @mizchi/sqlike@0.1.0 version
npm view @mizchi/litestream@0.1.0 version
```

`npm-publish`は再ビルド・検査後、実際に検査したtarballを`--access public`で公開する。初回はnpmのブラウザ認証 / 2FAが必要となる。認証情報をリポジトリに保存しない。既存の公開バージョンを上書きしない。同じversionがある場合はrepositoryとtarballのintegrityが一致するretryだけを許可する。公開後は認証なしのregistry installと同じ外部consumer検査を通す。

GitHub / Mooncakesの既存`v0.1.0`タグは動かさない。npm向けhost API・package定義は追加commitで管理する。npm registry上の0.1.0は初回配布であり、既存のMooncakesの0.1.0の上書きではない。

## 以後の自動公開

初回公開後、2FAが有効なアカウントで各packageにnpm Trusted Publisherを登録できる。登録したworkflow名・GitHub repositoryと`repository.url`を一致させる。タグ起点のworkflowと、そのタグの保護を整えてから自動公開へ移行する。現時点ではローカルの`npm-publish`が公開経路であり、OIDC登録やタグ保護の設定を完了したとは扱わない。
