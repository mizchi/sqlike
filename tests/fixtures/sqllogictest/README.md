# SQLite sqllogictest fixture

`select1.test` is the complete, unmodified file from the SQLite project's
sqllogictest corpus: 31 setup statements and 1,000 queries. No failing SQL,
expected values, or hashes have been removed or rewritten.

The official project is <https://www.sqlite.org/sqllogictest/>. Its raw endpoint
returned a browser-verification page during retrieval, so the file was obtained
from the public gregrahn mirror at the commit recorded in `upstream.json`.
The SHA-256 is checked by the tests. `upstream.json` records both origins.

The upstream author is D. Richard Hipp (`drh@sqlite.org`). The notice in
`src/sqllogictest.c` offers GPL, BSD, MIT or CC0, at the recipient's choice;
we use the CC0 option. See the pinned notice URL in the provenance record.

The runner verifies the original expected values/MD5 hashes against native
SQLite and MoonBit. It additionally compares raw typed, positional results;
passing the normalized SLT output alone is not enough. Unknown directives are
errors. This selected file contains no engine-specific skip directives.
