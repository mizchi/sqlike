# npm配布

`npm/sqlike`を`@mizchi/sqlike`、`npm/litestream`を`@mizchi/litestream`として公開する。両方とも初版0.1.0・ESM・MIT。ルートはprivateなデモ / 検証workspaceで、公開しない。Mooncakesの両モジュールも独立したまま維持する。

SQLikeにはJSの実行エンジン、固定DDL / statementのバイナリ実行、独立したNode用compiler、任意のDrizzle entryとWasm GCのassetを含む。compiler・SQLite exporter・Drizzleは別entry。SQLikeのroot / definedにはLitestream、SQLite WASM、Turso、FTS、実験的LSMを読み込まない。機能選択ビルドそのもののツールはリポジトリから使い、生成したruntimeを注入する。

2026-11-16に両packageの0.1.0をnpmへ公開した。registry版を匿名installする外部consumerで、Node、型検査、ChromiumのIndexedDB / offline / 再読込、Wasm GC、Drizzle migration / savepointを確認済み。配布物とregistryのSRIは[検証記録](../../measurements/npm-registry-current.json)に保存する。初回公開は手元から行ったもので、GitHub OIDCによる公開実績とは区別する。

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

`npm-publish`は再ビルド・検査後、実際に検査したtarballを`--access public`で公開する。初回はnpmのブラウザ認証 / 2FAが必要となる。認証情報をリポジトリに保存しない。既存の公開バージョンを上書きしない。同じversionがある場合はrepositoryとtarballのintegrityを確認する。npm側の正規化で圧縮tarballが変わった場合は、registryから再取得したtarballのSRI、全ファイル名、各ファイルの内容を照合する。`package.json`の書式だけは許容し、manifestの値やJS / Wasm / 型定義の差異は拒否する。公開後は認証なしのregistry installと同じ外部consumer検査を通す。

staged publishingになった場合は`npm stage list <package>`で確認し、`npm stage view <stage-id>`と`npm stage download <stage-id>`で配布物を検査してから、2FAを伴う`npm stage approve <stage-id>`で公開する。OIDCのpublish権限でstageをapproveすることはできない。既に占有された同じversionへpublishし直さない。

GitHub / Mooncakesの既存`v0.1.0`タグは動かさない。npm向けhost API・package定義は追加commitで管理する。npm registry上の0.1.0は初回配布であり、既存のMooncakesの0.1.0の上書きではない。

## 以後の自動公開

`.github/workflows/npm-release.yml`を使用する。GitHub hosted Ubuntu runner上で、`v*`タグのpushを受けて公開する。repositoryは`mizchi/sqlike`、workflow名は`npm-release.yml`、GitHub Environmentは指定しない。

両packageに、2FAが有効なownerのアカウントで登録する。npm CLI 11.15以上が必要。

```sh
npm trust github @mizchi/sqlike --repo mizchi/sqlike --file npm-release.yml --allow-publish --allow-stage-publish -y
npm trust github @mizchi/litestream --repo mizchi/sqlike --file npm-release.yml --allow-publish --allow-stage-publish -y
npm trust list @mizchi/sqlike
npm trust list @mizchi/litestream
```

`--file`はファイル名のみ。workflowを改名した場合は登録も更新する。CLIが要求する追加認証はnpmの画面で行う。登録済みかどうかは`npm trust list`の実際の結果で確認する。

2026-11-16に両packageの登録と`npm trust list`による照合を完了した。

| package | Trusted Publisher ID |
| --- | --- |
| `@mizchi/sqlike` | `07cd26aa-4359-4fce-9853-77e997f2300d` |
| `@mizchi/litestream` | `83a005a5-2b9c-4595-8480-406fe1a70efc` |

いずれもGitHubの`mizchi/sqlike` / `npm-release.yml`に対して、publishとstage publishを許可する。GitHub上でもworkflowがactiveであることを確認した。OIDC経由の実公開は、次回の新しいversionタグで確認する。

workflowはNode 24、pnpm 10.28.2、npm 11.19.1、MoonBit `0.10.20+65efd5b93`を使い、actionはcommit SHAで固定する。タグ、ルートと両packageのversionを照合し、MoonBit JS / Wasm、独立したnpm consumerのNode / Chromium、型検査を通してから検査済みtarballを公開する。pre-releaseは`next`、通常版は`latest`を使用する。公開後に匿名のregistry consumer検査を実行する。

`id-token: write`でGitHubのOIDCを使用する。`NPM_TOKEN`や`NODE_AUTH_TOKEN`をsecretから渡さない。公開scriptの`--oidc`は対象repositoryのtag pushとOIDC環境変数を検査し、ローカル公開用の`npm whoami`を省略する。npm自身がOIDCを検証し、Trusted Publishingではprovenanceが自動的に付く。

公開時はversionと変更履歴をcommitし、新しい`v<version>`タグをpushする。既存の`v0.1.0`はworkflow追加前のリリースなので動かさない。ローカル検証が通っても、GitHub上で実行するOIDC公開の成功とは区別する。

`v*`タグの管理者限定rulesetとworkflowのレビュー体制を別途維持する。設定確認:

```sh
gh api repos/mizchi/sqlike/rulesets --jq '.[] | {name, enforcement}'
```

公式手順: [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)、[Trusted publishing](https://docs.npmjs.com/trusted-publishers/)、[staged publishing](https://docs.npmjs.com/staged-publishing/)。
