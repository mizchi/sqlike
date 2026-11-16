# Drizzleを使う

[SQLikeを導入](../README.md#インストール)した後、動的SQLの接続をDrizzleの同期SQLite driverとして使えます。対応するバージョンは`drizzle-orm@0.45.4`です。

```sh
pnpm add drizzle-orm@0.45.4
```

```ts
import { openDatabase } from '@mizchi/sqlike';
import { drizzle } from '@mizchi/sqlike/drizzle';
import { integer, text, sqliteTable } from 'drizzle-orm/sqlite-core';

const task = sqliteTable('task', {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull(),
});
const client = openDatabase();
client.run('CREATE TABLE task(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL)');
const db = drizzle(client);

const row = db.insert(task).values({ title: 'hello' }).returning().get();
const rows = db.select().from(task).all();
```

接続はインメモリです。保存・再開には接続の`dump()`と`openDatabase(image)`を使います。IndexedDBを使う固定schema APIは[別の実行方法](prepared.md)です。

## Migration

Node.jsではDrizzle Kitで生成したディレクトリを読み込めます。

```ts
import { migrate } from '@mizchi/sqlike/drizzle/node';
await migrate(db, { migrationsFolder: './drizzle' });
```

ブラウザ等では、ビルド時に読んだ`MigrationMeta[]`を渡します。

```ts
import { migrate } from '@mizchi/sqlike/drizzle';
import { migrations } from './migrations.generated.js';
await migrate(db, migrations);
```

migrationのhashと既存履歴を検査し、履歴の不一致を拒否します。SQLikeが対応しないSQLを含むmigrationもエラーになります。

## 型とtransaction

標準のinteger / boolean / Date列、JSON text、REAL、TEXTを扱えます。安全な`number`へ変換できない整数は拒否します。大きなINTEGERには`sqliteInt64()`、BLOBには`sqliteBytes()`を使います。

```ts
import { sqliteInt64, sqliteBytes } from '@mizchi/sqlike/drizzle';
```

transactionのcallbackは同期関数です。入れ子transactionはsavepointとして扱い、例外やRETURNINGのdecode失敗はその範囲をrollbackします。

CRUD、RETURNING、JOIN、prepared placeholder、migrationに対応します。Drizzleの全機能・全生成SQLへの対応ではなく、relational query API等には未対応があります。
