# Linear SQLite rename: storage compatibility specification

| Field | Value |
|---|---|
| Status | **APPROVED** |
| Decision authority | [Decision plan](rename-00-overview.md), D-01 and D-02 |
| Delivery unit | [C4](rename-01-implementation-spec.md#c4--public-room-id-fields-outbound-metadata-adapter-identity-retain-storage-schema), a commit in the single rename PR |

## Decision

Retain these private physical identifiers indefinitely:

- `linear_thenvoi_session_rooms`;
- `linear_thenvoi_bootstrap_requests`;
- both `thenvoi_room_id` columns;
- their existing named indexes.

The store accepts any caller-provided SQLite path and does not claim exclusive
ownership of the database. This rename therefore must not write
`PRAGMA user_version`, create a migration ledger, rename/drop a table or index,
or infer a file move. Private storage vocabulary is treated like historical
migration vocabulary: stable persistence format, not public branding.

## Public mapping

The public `SessionRoomRecord`, `PendingBootstrapRequest`, `SessionRoomStore`,
and their callers use `bandRoomId`. Internal row types and SQL retain
`thenvoi_room_id`. The mapping is explicit at the storage boundary in both
directions:

```text
public bandRoomId -> SQL parameter bound to thenvoi_room_id
row thenvoi_room_id -> public bandRoomId
```

Do not expose the physical name through exported TypeScript types. Do not add a
second physical column or dual-write; one durable value keeps old/new binary
interop and rollback straightforward.

## Compatibility and lifecycle

- An existing custom or default database opens with no schema-changing DDL beyond
  the pre-existing additive-column initialization behavior.
- A fresh database still uses the legacy physical schema.
- Old and new binaries can alternately open the same database because both speak
  the same physical schema.
- A failed initialization retains current poison-eviction behavior; this rename
  introduces no new transaction, backup, lock, or recovery path.
- Unrelated tables, indexes, triggers, pragmas, and `user_version` are untouched.

## Executable proof

Use the real `createSqliteSessionRoomStore` entry point and logical schema/data
dumps before and after operations.

| ID | Fixture / action | Expected | Status |
|---|---|---|---|
| P-STO-01 | Existing database with both Linear tables, representative rows, and unrelated objects/`user_version=42`; open and perform read/write through new public types. | Band public fields round-trip; all physical names, unrelated objects, and version remain unchanged. | Planned |
| P-STO-02 | Fresh path opened by the new code. | It creates the established legacy physical schema and exposes Band public fields. | Planned |
| P-STO-03 | Alternate old-code fixture operations and new-code operations on one file. | Both reuse the same bindings and bootstrap records; no duplicate rooms/rows. | Planned |
| P-STO-04 | Existing `.linear-thenvoi-example.sqlite` selected by default. | Same path and binding reused; no `.linear-band-example.sqlite` is created. | Planned |
| P-STO-05 | Custom path supplied only by `LINEAR_THENVOI_STATE_DB`. | Fallback selects the exact path, warns once, and does not create/open the default path. | Planned |
| P-STO-06 | Search the C4 commit diff for schema-changing SQL and Band physical identifiers. | No rename/drop/version DDL and no `linear_band_*`/`band_room_id` physical identifier. | Planned |

Acceptance compares `sqlite_master`, `PRAGMA user_version`, and selected row
values. A row-count-only assertion is insufficient.
