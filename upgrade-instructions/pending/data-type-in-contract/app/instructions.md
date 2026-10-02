---
changes:
  - id: contract-stores-data-type
    summary: |
      A SQL contract names each column's data type in `dataType` (for example `pg/int4`) instead of
      its database type name in `nativeType`. Upgrade every extension that ships migrations in the
      same step, then run the colocated script on the project: it rewrites every contract, renames
      the snapshot directories to the new storage hashes, and rewrites the migrations, refs,
      `migration.ts` files and `contract.d.ts` files that name them.
    detection:
      glob: "**/*.json"
      matches:
        - '"nativeType"\s*:\s*"'
    script: ./scripts/data-type-in-contract.ts
  - id: column-descriptors-drop-native-type
    summary: |
      A hand-written column descriptor names its codec only: `{ codecId: 'pg/text@1' }` instead of
      `{ codecId: 'pg/text@1', nativeType: 'text' }`. Code that reads or builds a column of a stored
      contract uses `dataType` (for example `pg/text`) instead of `nativeType` (`text`).
    detection:
      glob: "**/*.{ts,mts,cts,tsx}"
      matches:
        - '(?<![\w$])(?<!readonly\s+)nativeType\s*:\s*[''"]'
        - '\.nativeType\b'
  - id: sign-databases-after-upgrade
    summary: |
      The upgrade changes every contract's storage hash, so every database's marker names a hash
      the project no longer has. Run `prisma db sign` against every database before deploying the
      application built with the new contract. `db sign` now signs every contract space, and its
      `--json` document is `{ ok, summary, spaces, advancedRefs }`.
  - id: parameter-casts-use-base-names
    summary: |
      PostgreSQL parameter casts are written with the data type's base name: `$1::int4` instead of
      `$1::integer`, and likewise `int2`, `int8`, `float4`, `float8` and `bool` instead of
      `smallint`, `bigint`, `real`, `double precision` and `boolean`. Logged SQL and SQL snapshots
      in tests change to match.
    detection:
      glob: "**/*.{ts,mts,cts,sql,json,snap}"
      matches:
        - '\$\d+::(?:integer|smallint|bigint|real|double precision|boolean)\b'
---

## `contract-stores-data-type`

Upgrade every extension that ships migrations (for example `@prisma/orm-extension-pgvector` and `@prisma/orm-extension-postgis`) in the same step as the framework, to the release its authors published for this change. An extension whose contract space is still in the old format makes the project refuse to load.

Commit your work first, so the script's changes can be reviewed and undone with git. Then run the script from the project root:

```sh
pnpm exec tsx <path-to-this-guide>/scripts/data-type-in-contract.ts
```

It reads and writes files only and needs no database. It rewrites every `*.json` file under the root that parses as a SQL contract in the old format (a column or `storage.types` entry that stores `nativeType`), skipping `node_modules`, `.git`, `dist` and `build`. That includes a test fixture of an old-format contract: if you keep such a fixture on purpose, restore it with git afterwards (`git restore <file>`), or keep it outside the project root.

Run your formatter afterwards. The script replaces text in `migration.ts` and `contract.d.ts`, so the import order in `migration.ts` and the line wrapping in `contract.d.ts` can differ from what a fresh emit and your formatter produce.

A contract already in the new format is never changed, even when its stored hash does not match its content, so a project already in the new format is left unchanged. It prints `<file>: stored hash did not recompute; rehashed from content` for an old-format contract whose stored storage hash does not match its content, and rewrites it anyway. It changes no file and exits 1 when a column uses a codec it does not know (`<file>: unknown codec <id>; name its data type with --data-type <id>=<data type id>`) or when a renamed snapshot directory already exists with different content.

The script knows every codec that Prisma and its own extensions ship. For a codec from another extension, pass the line that extension publishes in its upgrade notes, once per codec, for example `--data-type acme/shape@1=acme/shape`. The option cannot change the data type of a codec the script already knows for a contract's target, but it can name the data type of a shared `sql/*` codec on a target the script does not know.

On SQLite, the contract stores a literal default of a `BigInt` column as digit text, as it does for an `Int` column, so a migration planned from now on writes `DEFAULT 42` instead of `DEFAULT '42'`. A database created with `DEFAULT '42'` still verifies. Tests that assert the planned SQL change to match.

## `column-descriptors-drop-native-type`

In `contract.ts` and every other file that builds a column descriptor by hand, delete the `nativeType` property. The contract takes the column's data type from its codec.

```ts
// before
const pgText = { codecId: 'pg/text@1', nativeType: 'text' } as const;
const Priority = enumType('Priority', { codecId: 'pg/int4@1', nativeType: 'int4' }, member('Low', 0));

// after
const pgText = { codecId: 'pg/text@1' } as const;
const Priority = enumType('Priority', { codecId: 'pg/int4@1' }, member('Low', 0));
```

Code that reads a column of a stored contract (`contract.storage…tables[name].columns[name]`) reads `dataType`, the data type id such as `pg/text`, instead of `nativeType`, the database type name such as `text`:

```tsx
// before
<span className="col-type">{column.nativeType}</span>

// after
<span className="col-type">{column.dataType}</span>
```

Code that builds a stored contract's column by hand, for example a test fixture, writes the data type id in `dataType` instead of the type name in `nativeType`:

```ts
// before
id: { nativeType: 'uuid', nullable: false, codecId: 'pg/uuid@1' },

// after
id: { dataType: 'pg/uuid', nullable: false, codecId: 'pg/uuid@1' },
```

A type written by hand for such a contract changes the same way: `readonly nativeType: 'int4'` becomes `readonly dataType: 'pg/int4'`.

## `sign-databases-after-upgrade`

The upgrade gives every contract a new storage hash. Each database's marker still holds the old hash, so until you sign it:

- `prisma db migrate` refuses to run with `MIGRATION.MARKER_MISMATCH`;
- the running application logs `CONTRACT.MARKER_MISMATCH` when it starts;
- `prisma migration status` does not label the migrations applied before the upgrade as applied.

Run `prisma db sign` against every database (development, staging, production) before you deploy the application built with the new contract:

```sh
prisma db sign --db "$DATABASE_URL"
```

`db sign` verifies the live schema of every contract space (the application's and each extension's) against its contract, then writes the marker of every space that verified, in one transaction on PostgreSQL and SQLite. It advances each signed space's `db` ref, or the ref `--advance-ref <name>` names. Running it again changes nothing. A space that fails verification is not signed: the command prints its differences and exits with code 4. Repair that schema first (for example a Supabase database whose `auth` schema drifted from the extension's contract), then sign again.

A script that reads `db sign --json` reads one outcome per space. The document was `{ ok, summary, contract, target, marker }` for the application's space; it is now:

```json
{
  "ok": true,
  "summary": "Database signed",
  "spaces": [
    {
      "space": "app",
      "status": "signed",
      "contract": { "storageHash": "…", "profileHash": "…" },
      "marker": { "created": false, "updated": true, "previous": { "storageHash": "…", "profileHash": "…" } }
    }
  ],
  "advancedRefs": [{ "space": "app", "name": "db", "hash": "…" }]
}
```

`status` is `signed`, `unchanged` (the marker already held the contract's hashes) or `failed`. A failed space has `space`, `status`, `contract: { storageHash }` and `schema`, the verification result, in place of `marker`, and `ok` is `false`.

## `parameter-casts-use-base-names`

Update tests that assert query text or SQL snapshots:

| Before | After |
| --- | --- |
| `$1::integer` | `$1::int4` |
| `$1::smallint` | `$1::int2` |
| `$1::bigint` | `$1::int8` |
| `$1::real` | `$1::float4` |
| `$1::double precision` | `$1::float8` |
| `$1::boolean` | `$1::bool` |
| `$1::integer[]` | `$1::int4[]` |

Extension types keep their names (`$1::vector`, `$1::geometry`).
