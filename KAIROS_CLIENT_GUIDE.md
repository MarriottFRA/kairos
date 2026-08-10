# Kairos Client API Guide

Everything the Kairos desktop app needs to talk to this backend: all 60 endpoints, the sync
protocol, the authorization model, the wire conventions, and the error vocabulary.

Kairos is an Electron budgeting app that works standalone against two local SQLite stores.
This API is the **optional** backend behind it — a user publishes a plan here so colleagues
can pull it, and so a plan owner can delegate editing of named departments. Nothing here is
on the critical path for the desktop app running. A hotel with no backend configured keeps
working exactly as it does today.

Two properties shape the entire surface, and most of the design follows from them:

- **The server never interprets a plan payload.** Rows are stored as opaque client DTOs with
  a handful of promoted authorization columns beside them. The single exception is
  `departmentCode`, which is authorization metadata rather than domain data.
- **Authorization is per-object, never per-path.** A plan's OU is read from the loaded plan
  row, never from the URL, and a caller's authority over it is resolved fresh on every
  request.

---

## 1. Base URL, authentication, and the gate

All routes are mounted under `/kairos` at the API root. There is no `/api` or `/v1` prefix.

```
https://<host>/kairos/...
```

Authentication is the **device channel** — the same bearer session the desktop app already
obtains through device registration. See `DEVICE_REGISTRATION_CLIENT_GUIDE.md` for enrolment
and token lifecycle; this guide assumes you already hold a session token.

```http
Authorization: Bearer <device session token>
Content-Type: application/json
```

Every endpoint sits behind one router-level gate:

```python
require(channel="device", app=KAIROS_PLANS, ou_scope=True, department_scope=True)
```

Four things must hold before any handler runs:

| Requirement | Failure |
|---|---|
| Device channel (not a web session) | 403 |
| The user holds the `kairos` app grant | 403 |
| The user has at least one OU grant | 403 |
| The user has at least one department grant | 403 |

A small set of endpoints deliberately drop the department requirement, so a user with no
department grant can still reach the screens that would *explain* why they are stuck rather
than hitting an opaque 403 on the very page that would tell them what to request. Those are
marked **no-dept** in the reference below.

Endpoints that act on a specific plan layer a second check on top: the plan is loaded, the
caller's relation to it is resolved, and a named capability is asserted. The router gate
always runs first and the plan-level check only ever narrows.

---

## 2. Wire conventions

### camelCase, and unknown keys are refused

Request and response bodies on the sync surface use camelCase. Models are configured
`extra="forbid"`, so a misspelled field is a **422 on the whole request**, not a silently
ignored key.

This matters most on `CommitEntity`. If `baseHash` were silently dropped it would be read as
`None`, which the commit protocol interprets as "this is a new row" — turning a typo into an
`ALREADY_EXISTS` conflict storm, or worse, a create that should have been an update.

### ETags and conditional requests

Read endpoints return a **weak** ETag and `Cache-Control: private, no-cache`. Send it back as
`If-None-Match` to get a 304.

```http
GET /kairos/sync/heads?ou=OUABC12
If-None-Match: W/"3f9a2c118bd4e770"

304 Not Modified
```

Weak, not strong: the body is assembled per request and may differ byte-for-byte (key order,
compression level) while being semantically identical.

`private, no-cache` is deliberate and load-bearing. The default security headers set
`no-store`, which forbids the client from *keeping* the response to revalidate against — the
304 path would silently never fire and every "cheap probe" would become a full body.
`no-cache` keeps the response unshared and always-revalidated while permitting the client to
hold the entity and its ETag. That is the difference between a steady-state sync costing
~200 bytes and costing a full plan head.

Where the response is department-filtered, the caller's scope digest is folded into the ETag.
Without it, a user whose department grant was widened would keep being served the narrower
body from their own cache.

The `W/` prefix is tolerated present or absent on `If-None-Match`, because proxies rewrite it
in both directions.

### Compression

**Requests:** `Content-Encoding: gzip` or `deflate` is accepted on `/kairos` paths only.
There are two independent ceilings — a wire-byte limit and a separate limit on the *inflated*
stream (`KAIROS_MAX_INFLATED_BYTES`, 32 MiB), checked incrementally per chunk so a gzip bomb
dies mid-stream rather than after materialising.

**Responses:** standard `GZipMiddleware`, engaged above 1024 bytes. gzip rather than brotli —
brotli would save ~15% on these payloads and cost a compiled C-extension wheel in the
deployment.

### Error envelope

Errors return a JSON body with a stable machine-readable `code`, a human `detail`, and
sometimes a `context` object naming what would be required.

```json
{
  "detail": "You do not meet the requirements to own a plan at this property.",
  "code": "kairos_owner_not_eligible",
  "context": {
    "ou": "OUABC12",
    "required": {
      "accessType": ["hotel_admin", "above_property", "admin"],
      "ouAccessLevel": ["write", "admin"],
      "allDepartments": true,
      "app": "kairos"
    }
  }
}
```

**Branch on `code`, never on `detail`.** Detail strings are user-facing copy and may change.

### Timestamps and ordering

`clientUpdatedAt` is stored and returned **byte-for-byte** as the client sent it. It is never
parsed, never ordered by, and never rewritten. The client's engine fingerprint concatenates
`MAX(updated_at)` probes across both local stores, so a pull that rewrote this value would
invalidate every stored engine run on every pull.

**Order changes by `version` / `serverSeq`, never by any timestamp.** Client clock skew is
irrelevant to the protocol by construction.

---

## 3. The authorization model

### Relations

Every caller resolves to exactly one relation on a given plan.

| Relation | Who |
|---|---|
| `OWNER` | Owns the plan and still meets the eligibility bar. An administrator who **created** a plan resolves here too — see below |
| `OWNER_DEGRADED` | Owner whose platform access no longer meets the bar — demoted to a department list, or OU grant downgraded to read |
| `DELEGATE` | Holds a live delegation for named departments |
| `ADMIN_LEASE` | Administrator holding a support lease; acts in the owner's place |
| `GLOBAL_ADMIN` | Administrator with no lease, on a plan they did not create |
| `OU_VISITOR` | Has access to the hotel, on a plan that is not theirs and not delegated to them. Sees that it exists and who owns it; **no plan data** |

An unknown relation resolves to the empty capability set — it fails closed.

> **Changed.** `OU_VISITOR` was previously called `OU_MEMBER` and could read the plan, filtered
> to the caller's own departments. It can no longer read anything. See
> [Visibility is not readability](#visibility-is-not-readability) below — this is a breaking
> change for any client that treated the old relation as syncable.

### Capability matrix

| Capability | OWNER | OWNER_DEGRADED | DELEGATE | OU_VISITOR | GLOBAL_ADMIN | ADMIN_LEASE |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `plan:discover` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `plan:read` | ✅ | ✅ | ✅ | | ✅ | ✅ |
| `plan:delegate` | ✅ | | | | | ✅ |
| `plan:transfer` | ✅ | | | | | ✅ |
| `plan:archive` | ✅ | | | | | ✅ |
| `plan:delete` | ✅ | | | | | ✅ |
| `plan:takeover` | | | | | ✅ | ✅ |
| `plan:export` | | | | | ✅ | ✅ |
| `structure:read` | ✅ | ✅ | ✅ | | ✅ | ✅ |
| `structure:write` | ✅ | | | | | ✅ |
| `field_catalog:write` | ✅ | | | | | ✅ |
| `position:write` | ✅ | ✅ | ✅ | | | ✅ |
| `position:create` | ✅ | ✅ | ✅ | | | ✅ |
| `position:delete` | ✅ | ✅ | ✅ | | | ✅ |
| `pii:read` | ✅ | ✅ | ✅ | | | ✅ |
| `pii:write` | ✅ | ✅ | ✅ | | | ✅ |
| `pii:read:raw` | | | | | | ✅ |
| `pii:erase` | ✅ | | | | | ✅ |
| `bst:pull` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `bst:push` | ✅ | | | | | ✅ |
| `bst:upload` | ✅ | | | | | ✅ |
| `artifact:read` | ✅ | ✅ | | | ✅ | ✅ |
| `artifact:write` | ✅ | | | | | ✅ |
| `delegation:read` | ✅ | ✅ | ✅ | | ✅ | ✅ |
| `delegation:handback` | | | ✅ | | | |
| `activity:read` | ✅ | ✅ | ✅ | | ✅ | ✅ |
| `placeholder:create` | ✅ | | | | | ✅ |
| `lease:acquire` | | | | | ✅ | ✅ |
| `lease:release` | | | | | ✅ | ✅ |
| `scope:debug` | | | | | ✅ | ✅ |

Four entries in that table are worth understanding rather than just reading:

<a id="visibility-is-not-readability"></a>
**`plan:read` is held by the owner, a delegate, and an administrator — nobody else.** Access to
the hotel earns `plan:discover`, which tells you a plan exists, what it is called and who owns
it, so you can go and ask that person for a delegation. It carries no plan data of any kind.

This is a deliberate tightening. Previously hotel access alone conferred `plan:read` over
whatever departments your own grants covered, and the arithmetic of that was worse than it
looked: owning a plan requires **all** departments at the property (see *Owner eligibility*
below), so every hotel admin at a hotel necessarily holds every department there — and each of
them could therefore download every *other* hotel admin's plan in full. It also meant a
department-grant mistake was unbounded (someone given thirty departments instead of five gained
the property, not twenty-five extra departments), and it made delegation decorative, because the
owner's decision about who may see their plan was overridden by a grant made elsewhere, by
somebody else, for another purpose.

Breadth of department access is therefore not the control, and never was — the owner's decision
is. An owner who wants a colleague to *look* without *touching* grants an ordinary delegation
with `"canEdit": false`; the owner keeps full write throughout. See
[Delegation permission flags](#delegation-permission-flags).

**What this means for a client.** A plan in `GET /kairos/plans` or `/sync/heads` is no longer
necessarily syncable. Check `relation` before pulling: an `OU_VISITOR` entry has `version`,
`syncEpoch`, `structureVersion`, `entityCount` and `scopeKind` all `null`, and every read
endpoint answers **403 `kairos_plan_not_shared`** — *"This plan has not been shared with you. Ask
its owner to delegate the departments you need."* Render it as a locked tile naming `ownerEmail`,
not as an error. A `null` version is not version 0.



**A bare administrator has no `pii:read` at all** on a plan somebody else made. They see
positions and salaries, not names. Reading personal details there requires taking a lease,
which is a recorded decision. On a plan the administrator created themselves they resolve
as `OWNER` and do hold `pii:read` — the only personal data in such a plan is data they
published there — and their reads are recorded position by position exactly as under a
lease.

**`artifact:read` is absent for a delegate.** An engine-output artifact aggregates every
department in the plan into one opaque blob, so there is no column to filter on. The only
options are handing a three-department delegate all thirty departments or none.

**`bst:pull` *is* present for a delegate — and for an `OU_VISITOR`.** The budget workbook is a
**property** resource, not a plan resource: `GET /kairos/ou/{ou}/bst` resolves from your OU and
department grants and filters per row, and never involves a plan at all. So it survived the
tightening above, and excluding it from `DELEGATE` would mean being delegated to *removed* an
access the same person already had. A delegation adds authority over a plan; it must never
subtract authority over the property. The containment that applies to the workbook is that
per-row department filter, which the whole-plan artifact has no equivalent of.

<a id="delegation-permission-flags"></a>
### Delegation permission flags

`canEdit` decides whether a delegation is read/write or **read-only**:

| Flag | Default | Effect when `false` |
|---|---|---|
| `canEdit` | `true` | Strips **every** write capability. The delegate reads their departments and changes nothing; writes answer 403 `kairos_delegate_read_only` |

Setting `"canEdit": false` on `POST /kairos/plans/{planId}/delegations` is the supported way to
say *"look at my plan, but I am still working on it"* — and, now that hotel access confers no
read, the **only** way to let a colleague see a plan without handing over the pen. Granting it
takes nothing away from the owner, who keeps full write while it is live. It can be flipped
either way later with `PATCH .../delegations/{delegationId}`; turning it off is a *narrowing*
amendment and bumps the delegation's `generation`.

Three further capabilities each require their own per-delegation flag:

| Capability | Flag | Default |
|---|---|---|
| `position:create` | `canAddRows` | `true` |
| `position:delete` | `canDeleteRows` | **`false`** |
| `pii:read` | `canReadPii` | `true` |

`canDeleteRows` defaults off because deleting a position removes a person from a budget; that
should be an explicit grant, not a side effect of being handed a department.

### Owner eligibility

Creating a plan, writing the structure document, and uploading a workbook are not resolved
through a plan capability — there may be no plan yet. They check **all four** of:

- `accessType` in `hotel_admin`, `above_property`, or `admin`
- OU access level `write` or `admin` at that OU
- **all departments** at that OU
- the `kairos` app grant

The all-departments condition is what makes delegation coherent: an owner hands out slices of
a plan they must be able to see whole.

### Administrators, ownership and leases

An administrator (`access_type = 'admin'`) satisfies all four eligibility conditions at every
property with no grant rows at all, because `all_ous`, `all_departments` and `all_apps` are
synthesised from the role. So an administrator can create a plan anywhere — and, since they
created it, publish to it as its owner with no lease.

**The test is authorship, not ownership.** `plan.created_by` must equal both
`plan.owner_user_id` and the caller. `created_by` is stamped once at creation and never
rewritten — not by ownership transfer, not by any job — which is what makes it usable as an
authorization input. Ownership on its own is not: an administrator can take a lease, transfer
any plan to themselves and release the lease, so keying the carve-out on `owner_user_id` would
turn that into a permanent lease-free grant over another hotel's data. A plan **transferred**
to an administrator therefore still requires a lease for every write. A plan whose
`created_by` is null fails closed.

| Administrator acting on… | Reads | Writes |
|---|---|---|
| a plan they created | ✅ as `OWNER` | ✅ no lease |
| a plan transferred to them | ✅ | lease required |
| anyone else's plan | ✅ | lease required |

Four capabilities stay with the administrator role rather than following the relation, so an
admin never loses support tooling on their own plan — `OWNER` holds none of these:
`lease:acquire`, `lease:release`, `plan:takeover`, `plan:export`. Requests for those resolve as
`GLOBAL_ADMIN` even on a plan the administrator created, which is why exporting your own plan
still writes a `kairos_support_downloads` row and still counts against the 20/day cap.

**On the wire the relation is plain `OWNER`.** Clients need no special case; an administrator
on a plan they made is an owner in every respect the client can observe. The distinction is
kept in the audit trail instead: commits carry `actor_role = "ADMIN_OWNER"` and entity rows
carry `updated_via = "ADMIN_OWNER"`, so support writes never look like hotel writes.

---

## 4. The sync protocol

### Steady state

A steady-state sync is meant to be **two requests, one of which is a 304**:

```
GET /kairos/sync/heads?ou=OUABC12   →  304 Not Modified
```

That is the whole loop when nothing has changed. The probe covers plans, structure, BST,
clusters and mapping tables in one round trip precisely so the client never asks five
endpoints whose answers are almost always "no change".

### The version counters

| Counter | Scope | Bumped by | The client's response |
|---|---|---|---|
| `version` | plan | exactly once per accepted commit | pull the delta from your watermark |
| `syncEpoch` | plan | support-lease handback, forced resync | **full refresh, server wins** |
| `structureVersion` | OU | structure document replace | re-pull the structure doc |
| `schemaEpoch` | plan | genuinely breaking payload change | client may need an upgrade |
| `authzVersion` | user | any grant change | re-resolve what you can see |
| `clustersVersion` | global | cluster document replace | re-pull clusters |

`version` is monotonic per plan and bumped inside the plan row lock. This — never a timestamp
— is what orders changes and drives delta download.

`syncEpoch` is kept separate so an ordinary edit never triggers a full refresh. A client that
sees a higher epoch than it holds performs a full refresh and the server wins outright.

`schemaEpoch` is bumped only on a genuinely breaking payload change. Adding a field is not
one — payloads are opaque documents, so a missing field takes the client's local default.

### Full pull

`since=0` **is** the full pull. There is no separate bootstrap endpoint, because a full pull
is just a delta from nothing, and two code paths would mean two sets of scope bugs.

There is no history table. `/changes` reads current rows plus permanent tombstones, so no base
version can ever age out of range. The only "start again" signal is a changed `syncEpoch`.

### Recovery and self-healing

The client's own dirty-tracking is a fast path, never the source of truth: too many things
write to its local stores (cluster propagation, the legacy importer, tombstone cleanup,
scenario cloning, a settings-driven rebuild) for a dirty flag to be trustworthy.

`POST /plans/{id}/manifest/diff` is what makes publishing self-healing regardless of which of
them touched a row. Send `[entityType, entityId, contentHash]` triples; get back:

- `needed` — `[type, id, serverHash|null]`, rows you hold that the server does not have at
  that hash. A null third element means the server has never seen the row.
- `serverOnly` — `[type, id, hash, serverSeq, deleted]`, rows the server holds that your
  manifest did not mention.

The last two elements of `serverOnly` are what make it usable. Without `deleted` the client
re-pulls a tombstone it already applied on every single sync; without `serverSeq` it cannot
tell "I saw this and purged it locally" (send an explicit `purge`) from "I have never seen
this" (pull it).

### Apply order

A downloaded plan must be applied in a fixed dependency order, returned by `/sync/heads` as
`applyOrder` rather than hard-coded client-side, so the two can never disagree:

```
calendar, position_defaults, block_config, component_def, ss_scheme,
allocation, kpi_driver, field_catalog, scenario,
position, position_pii, component_value,
buyout_row, manual_input_row, engine_run
```

---

## 5. The commit protocol

### Request

```http
POST /kairos/plans/{planId}/commits?bootstrap=0
Idempotency-Key: <required, ≤64 chars>
Content-Type: application/json
Content-Encoding: gzip        (optional)

{
  "baseVersion": 41,
  "commitGroupId": "0192f3c1-...",
  "entities": [
    {
      "entityType": "position",
      "entityId": "0192f3c1-8a44-7e39-b0d2-3f6c9a1e5d77",
      "op": "upsert",
      "parentId": null,
      "department": "ROOMS",
      "baseHash": "k3Jd9fQ2xLm1",
      "hash": "p8Wq2vN4tRz6",
      "deleted": false,
      "clientUpdatedAt": "2026-08-08T11:04:22.318Z",
      "payload": { }
    }
  ]
}
```

| Field | Notes |
|---|---|
| `baseVersion` | Must equal the plan's current `version`. `0` on first publish. |
| `commitGroupId` | Optional. Groups the chunks of one logical publish. |
| `entityType` | Must be a known type — see the registry below. Unknown is rejected. |
| `entityId` | Client-minted UUIDv7, or a rendered composite for the types that have one. |
| `op` | `upsert` (default) or `purge`. |
| `parentId` | The owning position, for `position_pii` and `component_value`. |
| `department` | The row's department. Ignored and stored NULL for plan-wide types. |
| `baseHash` | The hash this client last saw from the server. `null` means "I believe this is new". |
| `hash` | `base64url(sha256(canonical DTO))[0..12]`, **computed by the client**. |
| `deleted` | Ordinary tombstone. |
| `payload` | The opaque client DTO. Required unless the row is a tombstone. |

### Three things that will bite

**`Idempotency-Key` is a required header.** Omit it and the request 422s before any logic
runs.

**The server never recomputes `hash`.** Python's `json.dumps` emits `1.0` where JS emits `1`,
and float repr, unicode escaping and key ordering all differ subtly — any cross-language
canonicalisation becomes a permanent source of phantom conflicts. The server compares the
token for byte equality and nothing else. Test fixtures must produce it exactly the way the
Electron client does or nothing will ever match.

**`purge` is a force-tombstone, not a hard delete.** The client sends it when it has locally
hard-deleted a row it had previously published (its own 30-day tombstone cleanup does this).
The server must record the death rather than forget the row — otherwise every *other* client
resurrects it on its next pull.

### Overwriting the server deliberately

There is **no client-asserted force flag**, and this is worth designing around rather than
discovering. A client that wants to push its copy over the server's cannot simply send the
rows: every one comes back `STALE` (the `baseHash` does not match) or `ALREADY_EXISTS` (sent
as new when the server has it). To overwrite on purpose, fetch the server's hashes first via
`GET /manifest` or `POST /manifest/diff`, then send those as `baseHash`. Two steps, so an
overwrite is an informed act rather than an accident.

The one force-overwrite in the protocol is server-derived and cannot be requested:
`override_base_until` is stamped with the plan version at the moment a delegation is
**re-granted**, letting a returning delegate's writes win over rows frozen at or before that
version without a matching hash. It is bounded by version and by department, it lapses on its
own, and rows written that way are reported with `overrodeBase: true`. A client-asserted
"take mine" would be a privilege the caller granted themselves.

Two rules the client cannot resolve either way:

- **Delete always wins.** `DELETED_REMOTELY` on a live row pushed over a server tombstone is
  a conflict, not a resurrection.
- **A delegate's writes stay inside their departments**, whatever the client decides.

Everything else — pull and overwrite local, or push with server hashes — is genuinely the
client's call.

### Response — 200, always

Partial success is the normal case, so this returns 200 even when nothing was accepted. Code
that asserts on status alone will pass while accepting zero rows.

```json
{
  "planId": "0192f3c1-...",
  "baseVersion": 41,
  "committedVersion": 42,
  "syncEpoch": 0,
  "structureVersion": 7,
  "scope": { "kind": "PARTIAL", "departments": ["ROOMS", "FB"] },
  "accepted":  [ { "entityType": "position", "entityId": "...", "hash": "...", "serverSeq": 42, "overrodeBase": false } ],
  "unchanged": [ { "entityType": "position", "entityId": "..." } ],
  "conflicts": [ { "entityType": "position", "entityId": "...", "reason": "STALE",
                   "serverHash": "...", "serverSeq": 40, "serverPayload": { },
                   "updatedBy": "someone@example.com", "updatedAt": "..." } ],
  "rejected":  [ { "entityType": "position", "entityId": "...", "reason": "DEPARTMENT_OUT_OF_SCOPE",
                   "department": "SPA", "detail": null } ],
  "limits": { "commitMaxBytes": 1048576, "commitMaxEntities": 5000,
              "changesMaxBytes": 1048576, "manifestMaxEntities": 10000 }
}
```

A replayed idempotency key returns the stored response with `Idempotency-Replayed: true`.

`overrodeBase` is `true` when a re-granted delegate's write overwrote a row that changed while
they were locked out. Correct, but never silent — show it, and an audit row exists.

### Conflict reasons

Stable strings. The client branches on them.

| Reason | Meaning | What the client does |
|---|---|---|
| `STALE` | `baseHash` does not match the server's current hash | Merge or present the conflict; `serverPayload` is included |
| `ALREADY_EXISTS` | Sent as new (`baseHash: null`) but the server already has it | Adopt the server hash and retry as an update |
| `DELETED_REMOTELY` | The server holds a tombstone; you sent a live row | **Delete wins.** Resurrecting a position somebody removed — a leaver, a cancelled role — is the one merge that is never harmless |

### Rejection reasons

| Reason | Meaning |
|---|---|
| `UNKNOWN_ENTITY_TYPE` | Not in the frozen registry |
| `DEPARTMENT_OUT_OF_SCOPE` | Outside your write scope |
| `DEPARTMENT_MISMATCH` | Payload `departmentCode` disagrees with the promoted column |
| `DEPARTMENT_UNASSIGNED` | Department-scoped row with no department |
| `STRUCTURE_OWNER_ONLY` | Plan-wide row, and you are not the owner or lease holder |
| `ORPHAN_ENTITY` | Inherited row whose parent position is unknown |
| `PAYLOAD_TOO_LARGE` | Over `KAIROS_ENTITY_MAX_BYTES` (256 KiB) |
| `MISSING_PAYLOAD` | Non-tombstone row with no payload |
| `PII_NOT_PERMITTED` | PII disabled for the property, or your relation has no `pii:write` |
| `PII_KEY_MISMATCH` | `position_pii` row whose `entityId` is not its `parentId` |

`PII_NOT_PERMITTED` is a per-row rejection rather than a 403 on the whole chunk, deliberately:
the rest of the positions in the same publish are perfectly legal and must still land.

### Entity type registry

Frozen in code, exhaustively tested. **An unknown type is rejected outright** — if unknown
types were accepted and defaulted to "no department", a delegate could invent a type, publish
it with `departmentCode = NULL`, and reach the plan-wide branch that governs the field
catalog.

**Plan-wide** — `department` must be NULL, owner-only write, readable by anyone who can read
the plan (a delegate needs the whole field catalog to render three departments' worth of grid):

`scenario`, `field_catalog`, `block_config`, `component_def`, `ss_scheme`, `allocation`,
`kpi_driver`, `calendar`, `position_defaults`, `engine_run`

**Department-scoped** — delegatable:

`position`, `buyout_row`, `manual_input_row`

**Inherited** — no department of their own; they take their parent position's:

`position_pii`, `component_value`

Notes on the awkward ones:

- `component_def` nests `component_base_refs`; `ss_scheme` nests `ss_brackets`; `kpi_driver`
  nests patterns and accounts; `calendar` nests `calendar_months`. All in the payload.
- `calendar` uses a rendered composite id: `"{ou}:{year}"`.
- `component_value` uses `"{positionId}:{componentDefId}"`.
- `engine_run` is **metadata only** — never the output lines. Those are an artifact.
- `position_pii` is published through the ordinary commit chunk but is diverted server-side to
  a separate encrypted table. Its `entityId` **must equal** its `parentId`.

### Department normalisation

Two rules, both from real client behaviour:

- A plan-wide row is stored as NULL whatever the client sent. The DTOs carry an `ou` and
  sometimes an empty `departmentCode`; neither is an authorization input.
- `""` becomes NULL. Both `positions` and `manual_input_rows` default `department_code` to the
  empty string client-side. Collapsing it to NULL means the value never reaches a department
  predicate at all, and the row becomes owner-only — the right home for a row nobody has
  classified yet.

---

## 6. Endpoint reference

60 endpoints. **no-dept** marks the ones reachable without a department grant.

### Probe

#### `GET /kairos/sync/heads?ou={ou}` — no-dept

Plans, structure, BST, clusters and mapping tables in one ETag'd round trip.

```json
{
  "ou": "OUABC12",
  "authzVersion": 14,
  "plans": [
    { "id": "...", "label": "Budget 2026", "ownerUserId": 41,
      "ownerEmail": "anna@example.com", "state": "ACTIVE", "relation": "OWNER",
      "version": 42, "structureVersion": 7, "syncEpoch": 0, "scopeKind": "FULL",
      "departments": null, "handbacksPending": 2 },

    { "id": "...", "label": "Rooms Budget 2026", "ownerUserId": 57,
      "ownerEmail": "bob@example.com", "state": "ACTIVE", "relation": "OU_VISITOR",
      "version": null, "structureVersion": null, "syncEpoch": null, "scopeKind": null,
      "departments": null, "handbacksPending": 0 }
  ],
  "structureVersion": 7,
  "bst": { "importId": "...", "contentHash": "...", "importedAt": "2026-07-01T09:12:00Z" },
  "clustersVersion": 3,
  "mappingTablesVersion": "v24",
  "limits": { "commitMaxBytes": 1048576, "commitMaxEntities": 5000,
              "changesMaxBytes": 1048576, "manifestMaxEntities": 10000 },
  "applyOrder": ["calendar", "position_defaults", "..."]
}
```

`departments: null` means all — but only on an entry you can read. `handbacksPending` counts
departments a delegate has handed back that the owner has not reopened — surfaced here so the
owner's client can show "2 departments are ready for you" without a second call on every screen.

**The second entry above is the shape to code for.** Plan heads are resolved for
`plan:discover`, so a plan you cannot read still appears here, with everything describing its
contents nulled. That is intentional: a plan vanishing from the probe reads to a user as data
loss, and you cannot ask for access to something you cannot see. **Gate your sync on
`relation`** — pulling an `OU_VISITOR` entry earns a 403, and treating its `null` version as `0`
would make the client believe it has a plan to download for ever.

`label`, `ownerUserId` and `ownerEmail` are on the head precisely because a visitor cannot call
`GET /kairos/plans/{planId}` at all, so this is the only place the locked tile can get its
caption from.

### Plans

#### `GET /kairos/plans?ou={ou}&year={year}` — no-dept

Plans this caller can see. **A list filters; it never 403s for scope.** Returns
`PlanSummary[]`.

Same two shapes as the probe: an entry you hold `plan:read` on is complete, and an
`OU_VISITOR` entry carries `id`, `ou`, `year`, `label`, `state`, `ownerUserId`, `ownerEmail`,
`ownerIneligible` and `updatedAt`, with `version`, `syncEpoch`, `structureVersion`,
`entityCount`, `scopeKind` and `departments` all `null`. `ownerEmail` is populated on both — it
is who to ask for a delegation.

#### `POST /kairos/plans` → 201

Register a plan; the caller becomes owner. Requires owner eligibility.

```json
{ "id": "0192f3c1-...", "ou": "OUABC12", "year": 2026, "label": "Budget 2026",
  "clientUpdatedAt": "...", "appVersion": "3.2.1", "engineVersion": "1.9.0",
  "schemaEpoch": 1 }
```

`id` is the desktop app's own `scenarios.id`, used verbatim as the primary key. That is what
makes publishing idempotent for free: a retried first publish collides on the primary key
instead of creating a second plan — and returns the existing plan rather than an error, as
long as the OU and owner match. A different owner or OU on an existing id is a 409
`kairos_plan_id_taken`.

#### `GET /kairos/plans/{planId}`

`PlanSummary` with `relation`, `scopeKind`, and `departments` filled in for this caller.
Requires `plan:read`, so an `OU_VISITOR` gets 403 `kairos_plan_not_shared` here — use the
listing or the probe for what they are allowed to know about the plan.

#### `PATCH /kairos/plans/{planId}`

`{ "label": "...", "state": "ACTIVE" | "ARCHIVED" }`. Requires `plan:archive`. Note the
schema accepts only those two states — `LOCKED_BY_SUPPORT` is set by the lease machinery, not
by a client.

#### `DELETE /kairos/plans/{planId}` → 204

**Soft delete.** The rows stay so a mistaken delete is recoverable by support. Requires
`plan:delete`.

### Publish and pull

#### `POST /kairos/plans/{planId}/commits?bootstrap={0|1}`

See section 5. Requires `position:write`. Rate limited 240/hour.

#### `GET /kairos/plans/{planId}/changes?since={n}&cursor={c}&maxBytes={n}`

Delta pull; `since=0` is the full pull. Requires `plan:read` — an `OU_VISITOR` is refused with
403 `kairos_plan_not_shared`, as they are on `/manifest`, `/manifest/diff`, `/version`,
`/pii/summary`, `/activity`, `/department-ownership` and the artifact routes. Rate limited
600/hour.

```json
{
  "planId": "...", "fromVersion": 0, "toVersion": 42,
  "syncEpoch": 0, "structureVersion": 7, "schemaEpoch": 1,
  "scope": { "kind": "FULL", "departments": null },
  "nextCursor": "eyJ0byI6NDIsIn...",
  "limits": { },
  "entities": [
    { "entityType": "position", "entityId": "...", "parentId": null,
      "department": "ROOMS", "deleted": false,
      "clientUpdatedAt": "...", "serverSeq": 42, "payload": { } }
  ]
}
```

Page until `nextCursor` is null. The upper bound is pinned on the **first** page and carried
in the cursor thereafter — re-deriving it per page would let a commit landing mid-download
widen the range, so the client would finish, record a watermark covering rows it never
received, and never ask for them again.

`maxBytes` is clamped to `[32 KiB, KAIROS_CHANGES_MAX_BYTES]`, default 256 KiB.

A cursor is invalid if `since` or `syncEpoch` no longer match — `kairos_cursor_invalid`.

#### `GET /kairos/plans/{planId}/manifest`

The server's full manifest for this caller, as a recovery path after a local rebuild. Returns
everything in `serverOnly`. Includes the PII sidecar rows — the union is not optional, because
a manifest built from the entity store alone would report every PII row as absent and cause a
permanent silent republication of exactly the data that costs most to move.

#### `POST /kairos/plans/{planId}/manifest/diff`

```json
{ "entities": [["position", "0192f3c1-...", "p8Wq2vN4tRz6"], ["..."]] }
```

Positional triples — about 55% smaller than one object per entry on a body that carries every
row in the plan. Max 10,000 entries; rate limited 120/hour. Response as described in §4.

#### `GET /kairos/plans/{planId}/version`

The cheapest possible single-plan probe.

```json
{ "planId": "...", "version": 42, "syncEpoch": 0, "structureVersion": 7,
  "state": "ACTIVE", "relation": "OWNER",
  "scope": { "kind": "FULL", "departments": null } }
```

### Structure

#### `GET /kairos/ou/{ou}/structure` — no-dept

The whole structure document: field catalog, blocks, schemes, calendars.

```json
{ "ou": "OUABC12", "structureVersion": 7, "docHash": "…", "doc": { } }
```

**404 means "no configuration yet"**, which the client treats as *keep your local copy*, not
as an error. Same contract as the mapping-table sync it mirrors.

Readable by anyone with access to the property, including a delegate holding three of thirty
departments — without the full catalog their grid renders with no columns at all.

#### `PUT /kairos/ou/{ou}/structure`

```http
If-Match: W/"…"
{ "doc": { }, "docHash": "<sha256>" }
```

Whole-document replace. Owner-eligible callers only — the field catalog is per-OU, so catalog
write is a covert channel across every department in the hotel. The server recomputes
`docHash` and 422s on mismatch (`kairos_doc_hash_mismatch`). Every prior version is retained;
one bad column edit is one restore.

### Personal details (PII)

Published through the ordinary commit chunk — the client should not run two protocols — but
read back through a separately gated, separately rate-limited, separately audited call. A
delegate who can pull the plan is not thereby able to pull its staff list.

#### `GET /kairos/plans/{planId}/pii?since={n}&cursor={c}&limit={n}`

Requires `pii:read`. Max 500 rows per page. Rate limited 600/hour. **Every call writes an
audit row.**

```json
{
  "planId": "...", "fromVersion": 0, "toVersion": 42, "syncEpoch": 0,
  "scope": { "kind": "PARTIAL", "departments": ["ROOMS"] },
  "nextCursor": null,
  "rows": [
    { "entityType": "position_pii", "positionId": "...", "department": "ROOMS",
      "hash": "...", "deleted": false, "clientUpdatedAt": "...", "serverSeq": 42,
      "payload": { }, "readable": true }
  ],
  "unreadable": 0
}
```

`payload` is null on a tombstone **and** on a row whose key has been destroyed. The client
treats both as "no record here", which is exactly right after an erasure. `unreadable` counts
the latter.

#### `GET /kairos/plans/{planId}/pii/summary`

Gated on `plan:read`, not `pii:read` — a count is not a disclosure, and the person deciding
whether to erase needs the number in front of them even if they are not entitled to read the
contents. Note that `plan:read` is still the floor: an `OU_VISITOR` does not get the count
either, because for them even "there are 340 people in this plan" is more than they are
entitled to know.

```json
{ "planId": "...", "rows": 128, "live": 124, "keyPresent": true,
  "piiEnabled": true, "scope": { "kind": "FULL", "departments": null } }
```

`keyPresent: false` lets the client show "erased" rather than "empty" — very different things
to tell a data-protection officer.

#### `DELETE /kairos/plans/{planId}/pii`

```json
{ "reason": "DSAR request #4182", "confirmPlanId": "0192f3c1-..." }
```

Crypto-shreds the plan's data keys. **Irreversible.** Requires `pii:erase` (owner or lease
holder). `confirmPlanId` must match the path — not security, since the caller already holds
the capability, but a deliberate speed bump in front of an action with no undo.

Returns `{ planId, rowsErased, keysDestroyed, version, syncEpoch }`.

#### `GET /kairos/ou/{ou}/settings` — no-dept

```json
{ "ou": "OUABC12", "piiEnabled": true, "updatedAt": "..." }
```

No row means the default, which is on — a 404 would make every client special-case "not
configured" as distinct from "configured to the default". **Call this before publishing:** a
hotel with personal-data storage off must be told up front rather than discovering it as a
wall of `PII_NOT_PERMITTED` rejections mid-publish.

#### `PUT /kairos/ou/{ou}/settings` — no-dept

`{ "piiEnabled": false, "reason": "..." }`. **Administrators only** — not the hotel's own
owner. The switch exists for jurisdictions that refuse server-side storage of employee
details, so it is a compliance position taken by the organisation, not a per-property
preference an owner can flip back the afternoon after legal turned it off.

Turning it off does not erase anything. `DELETE /plans/{id}/pii` is the separate, deliberate
act that destroys what is already there.

### Budget spread (BST)

BST is **per property, not per plan**, so these resolve authority from the caller's access
scope rather than a plan scope.

#### `GET /kairos/ou/{ou}/bst/version` — no-dept

Hash probe. Cheap enough to call before every download — an unchanged workbook costs one 304
rather than 400 KB. 404 = never uploaded, treat as *keep your local copy*.

#### `GET /kairos/ou/{ou}/bst`

The wide rows this caller may see. Rate limited 120/hour.

A caller entitled to every department gets the stored gzip blob **served verbatim** — no
parse, no re-serialise, no server CPU. A partially-scoped caller cannot be served the blob, so
their rows are rebuilt from the indexed projection. Both carry the same `scope` block, so the
client can tell which it got.

```json
{ "ou": "OUABC12", "importId": "...", "contentHash": "...",
  "asOfPeriod": "2026-06", "currency": "EUR",
  "buckets": [{ "index": 0, "type": "BUD", "year": 2026 }],
  "scope": { "kind": "FULL", "departments": null },
  "rows": [ ] }
```

#### `PUT /kairos/ou/{ou}/bst`

Owner-eligible only — BST is the shared baseline every plan's KPI drivers aggregate from, so a
delegate uploading their own workbook would silently rewrite every other department's
KPI-driven blocks. Max 20,000 rows; rate limited 20/hour.

```json
{ "importId": "...", "buckets": [{ "index": 0, "type": "BUD", "year": 2026 }],
  "rows": [ ], "sourceFilename": "budget.xlsx", "hotelName": "...", "bu": "...",
  "currency": "EUR", "asOfPeriod": "2026-06", "contentHash": "<sha256>" }
```

`contentHash` is compared, not trusted — a mismatch (`kairos_bst_hash_mismatch`) means the
upload was mangled in transit, and re-sending now is much cheaper than discovering wrong
budget numbers months later.

Rows are opaque apart from `dept`, `account`, `combo`, `description` and `cells`, which are
projected into an indexed table. Everything else is stored and returned untouched.

#### `POST /kairos/ou/{ou}/kpi-series`

Twelve numbers for one KPI driver, computed server-side. Rate limited 600/hour.

```json
{ "driverId": "rooms_occupancy", "bucket": 0,
  "deptPatterns": ["ROOMS%"], "accountPrefixes": ["4", "51"] }
```

The highest-leverage endpoint in the feature: rendering a KPI driver otherwise means
downloading ~400 KB of workbook to produce twelve floats.

POST rather than GET because the client sends the selector. The server never opens
`kpi_drivers` to read its patterns, so a driver can gain a field without a server release.
`driverId` rides along as an opaque label for auditing and caching only.

#### `GET /kairos/plans/{planId}/bst-push/eligibility`

```json
{ "allowed": false, "reasons": ["PARTIAL_SCOPE"], "planId": "...",
  "scopeKind": "PARTIAL", "importId": "...", "contentHash": "..." }
```

Reasons: `NOT_PLAN_OWNER`, `PARTIAL_SCOPE`, `ADMIN_LEASE_ACTIVE`, `NEVER_PUBLISHED`,
`NO_BST_IMPORT`.

This gate matters more than it looks. A BST push rewrites the hotel's actual Excel file with
`replace`/`clear` month actions that **zero rows before writing them** — so running it with a
partial view of the plan does not produce incomplete numbers, it destroys good ones.

**A delegate can never push**, however many departments they hold: the check is
`relation in (OWNER, ADMIN_LEASE)` *and* full read scope. This is the main reason ownership
transfer exists. If the person who set a plan up is not the person who loads it into the
workbook — an HR director building it, a finance director pushing it — the plan has to be
handed over with `POST /plans/{id}/transfer`, not delegated. The HR director does not lose
sight of the plan by doing so: the transfer leaves them a
[read-only delegation](#ownership-transfer) on the way out.

#### `POST /kairos/plans/{planId}/bst-push/log` → 204

The push itself is OOXML surgery on the hotel's real file and stays entirely client-side; this
records that it happened. Requires `bst:push`.

```json
{ "targetFile": "S:\\Budgets\\2026.xlsx", "rowsWritten": 3120,
  "backupTaken": true, "monthPlan": { } }
```

Worth an endpoint of its own because a BST push is the one Kairos action that changes a file
outside Kairos. When somebody asks in March why the workbook has different numbers from the
plan, this row is the only thing that can answer.

### Artifacts

Compressed, opaque by-products of a plan — currently the engine output lines. Stored as bytes
and served whole, never as queryable rows.

#### `PUT /kairos/plans/{planId}/artifacts/{kind}`

Raw gzipped body, max 16 MiB. Requires `artifact:write` (owner or lease). Default kind is
`engine_output`.

#### `GET /kairos/plans/{planId}/artifacts`

```json
{ "planId": "...", "planVersion": 42,
  "artifacts": [{ "kind": "engine_output", "contentHash": "...", "byteSize": 918273,
                  "planVersion": 40, "stale": true, "uploadedAt": "..." }] }
```

`stale` is `planVersion != plan.version`. The client must not render a stale artifact as
current — it was computed against an older plan and its numbers no longer match the grid.

#### `GET /kairos/plans/{planId}/artifacts/{kind}`

Returns `application/gzip` with `X-Kairos-Plan-Version` and `X-Kairos-Content-Hash`. Requires
`artifact:read` — one of the very few Kairos reads with no partial answer.

### Resumable uploads

For a workbook or an artifact on a slow link. Kinds: `BST_IMPORT`, `ARTIFACT`.

**There is no `PLAN_BOOTSTRAP` kind.** A first publish is deliberately a sequence of ordinary
commits, each individually retriable and each validated on arrival — strictly better than one
blob that must be fully assembled before any of it can be checked. Do not build the client
expecting a bulk-load endpoint.

#### `POST /kairos/uploads` → 201

```json
{ "kind": "BST_IMPORT", "ou": "OUABC12", "planId": null,
  "totalParts": 12, "declaredHash": "<sha256>", "declaredBytes": 8388608,
  "artifactKind": "engine_output" }
```

Max 256 parts, 1 MiB each, 24-hour TTL. Rate limited 600/hour. The destination is authorised
**here** as well as at completion — checking only on completion would let anyone spend the
server's storage staging megabytes against a hotel they have no access to.

#### `GET /kairos/uploads/{uploadId}`

Which parts the server already holds. The call that makes resuming possible.

#### `PUT /kairos/uploads/{uploadId}/parts/{partNo}?checksum={sha256}`

Raw body bytes, so a client streams rather than base64-ing them. **Idempotent by part
number** — re-sending after a timeout replaces the part rather than appending a second copy,
which matters because "did that part land?" is unanswerable from the client side of a dropped
connection.

#### `POST /kairos/uploads/{uploadId}/complete?artifactKind={kind}`

Assembles, verifies, and writes to the destination. Authority is **re-checked here**, not
inherited from when the upload began: on a link slow enough to need resumability, a grant can
be revoked between the first part and the last, and the byte that matters is the one being
written now.

For `BST_IMPORT` the assembled body must be gzipped JSON — either `{buckets, rows, ...}` or a
bare rows array. Anything else is `kairos_upload_not_a_workbook`.

Note: completion reads the artifact kind from the **query parameter**, defaulting to
`engine_output`. The `artifactKind` field on the begin body is accepted but is not what
completion consults — pass it on the complete call.

#### `DELETE /kairos/uploads/{uploadId}` → 204

### Delegation

#### `GET /kairos/plans/{planId}/departments`

The delegatable set with row counts and an explicit reason when a department is not grantable.
Gated on `plan:delegate` — **owner only**. This is the picker an owner opens to decide who
gets what, so it necessarily enumerates every department in the plan; served to a delegate it
would hand somebody scoped to one department the whole shape of the hotel's plan.

A department with no live rows cannot be delegated. Add a placeholder position first.

#### `GET /kairos/plans/{planId}/delegation-candidates?q={search}`

```json
{ "planId": "...",
  "candidates": [
    { "userId": 42, "email": "a@example.com", "accessType": "hotel",
      "deptScope": { "mode": "LIST", "departments": ["ROOMS"] },
      "eligible": true, "reasons": [], "existingDelegationId": null }
  ] }
```

Reasons include `IS_PLAN_OWNER`. Rate limited 60/minute.

#### `GET /kairos/plans/{planId}/delegations`

Requires `delegation:read`.

#### `POST /kairos/plans/{planId}/delegations` → 201

```json
{ "delegateUserId": 42, "departments": ["ROOMS", "FB"],
  "canEdit": true, "canAddRows": true, "canDeleteRows": false, "canReadPii": true,
  "expiresAt": null, "note": "Covering while I'm on leave",
  "acknowledgeNonOverlap": false }
```

Owner only. Rate limited 60/hour.

**There is no sub-delegation.** `plan:delegate` is owner-only, so a large property is
delegated in one flat layer from the plan owner — a delegate holding Rooms cannot subdivide
it further. "A delegate cannot sub-delegate" is the single most important containment
property in the feature. Where an owner needs someone else to run the delegation, the answer
is [ownership transfer](#ownership-transfer), not a deeper tree — which is also why transfer
leaves the outgoing owner a read-only delegation rather than nothing: handing the plan on is
already the escape hatch, and it should not cost them their view of it.

The delegation stores **intent** — the full set the owner asked for — and is never mutated by
ordinary data edits. If the delegate's own department access is later widened, the grant
widens with it and no second action is needed. That is only safe because the effective set is
intersected per request rather than frozen at grant time.

A partial overlap between the named departments and the delegate's own access is a **warning,
not a refusal**; set `acknowledgeNonOverlap` after showing the owner exactly which departments
will not take effect. No overlap at all is `kairos_delegation_no_overlap`.

#### `PATCH /kairos/plans/{planId}/delegations/{delegationId}`

Amend the four permission flags, expiry, or note. Bumps `version` always, and `generation`
only on a **narrowing** amendment — that bump is the signal a client uses to freeze rows in
departments it has just lost rather than re-pushing them into a wall of 403s.

#### `DELETE /kairos/plans/{planId}/delegations/{delegationId}?force={0|1}`

```json
{ "reason": "..." }
```

Revocation is a timestamp, never a delete — point-in-time reconstruction of "who could see
this hotel's salaries between two dates" is exactly what a compliance review asks.

With unpublished delegate work outstanding and no `?force=1`, this is a **409** naming what is
about to be stranded (`kairos_delegate_has_unsynced_work`). Forcing is legitimate and
supported — it is the owner's escape hatch when a delegate is unavailable — but it must be a
decision, not a side effect.

```json
{ "id": "...", "revokedAt": "...", "unsyncedAtRevoke": true,
  "warning": "The delegate still has unpublished local work. It is not lost, but they cannot publish it unless you delegate to them again." }
```

#### `GET /kairos/me/delegations` — no-dept

Plans delegated to me across every hotel, **including recently withdrawn ones** (30 days by
default). A withdrawn delegation stays visible on purpose: the client shows a persistent
banner and an Export button rather than the plan simply vanishing from a list, which is what
"your work is not lost" looks like in a UI.

```json
{ "delegations": [
  { "delegationId": "...", "planId": "...", "ou": "OUABC12", "year": 2026, "label": "...",
    "state": "REVOKED", "revokedAt": "...", "revokedWithUnsynced": true, "generation": 3,
    "departments": [{ "code": "ROOMS", "state": "ACTIVE" }],
    "remedy": { "kind": "CONTACT_OWNER", "ownerUserId": 7 } }
] }
```

#### `POST /kairos/plans/{planId}/delegations/me/departments/{department}/handback`

A delegate declaring one department finished. Idempotent. Requires `delegation:handback`.

`HANDED_BACK` removes the department from the delegate's **write** scope and leaves it in
their **read** scope — modelled as a state rather than a partial revoke so re-opening is one
update and the audit lineage survives.

This route does **not** check for unpublished work; the bulk one does. Handing back one
department of five is routine with four still open.

#### `POST /kairos/plans/{planId}/delegations/me/handback?force={0|1}`

The whole delegation at once. Same capability, same semantics — every `ACTIVE` department
becomes `HANDED_BACK`, already-handed-back ones are left alone, and the call is idempotent.
All the departments moved in one call share a single `handedBackAt` and
`handedBackAtVersion`, so the owner's audit trail shows one handover rather than five
coincidental ones.

```json
{ "planId": "...", "delegationId": "...",
  "departments": [
    { "department": "D0010", "state": "HANDED_BACK",
      "handedBackAt": "2026-08-08T14:02:11Z", "handedBackAtVersion": 42 }
  ] }
```

**409 `kairos_handback_with_unsynced_work`** when the delegate's client has reported dirty
entities, unless `?force=1`. Handing everything back is the moment their unpublished work
becomes unpublishable — the owner would have to reopen a department for them to finish — so
they are told before rather than after. The body carries `dirtyEntities`, `departments` and
`retryWith: {"force": true}`.

The delegation itself **survives** either way. This is not a revocation: the delegate keeps
read access, the owner can reopen any department, and nobody has to re-grant.

#### `POST /kairos/plans/{planId}/delegations/{delegationId}/departments/{department}/reopen`

Owner re-opens a handed-back department.

### Presence and the grid

#### `POST /kairos/plans/{planId}/presence` → 204

```json
{ "dirtyEntities": 14, "departments": ["ROOMS"], "lastLocalEditAt": "..." }
```

**Advisory only, never an authorization input, and not a lock.** An offline-capable desktop
client cannot hold a pessimistic lock honestly, and a crashed one would strand it forever.

It exists so the server can know that withdrawing a delegation right now would strand
somebody's afternoon, and to back the soft-presence display. Rate limited 120/hour.

#### `GET /kairos/plans/{planId}/activity`

```json
{ "planId": "...", "present": [
  { "userId": 42, "email": "a@example.com", "departments": ["ROOMS"],
    "dirtyEntities": 14, "seenAt": "..." }
] }
```

<a id="get-kairosplansplaniddepartment-ownership"></a>
#### `GET /kairos/plans/{planId}/department-ownership`

**The one call the grid makes on every render.**

```json
{ "planId": "...", "planVersion": 42, "authzVersion": 14,
  "me": { "relation": "OWNER", "scopeKind": "FULL" },
  "structureEditableByMe": true,
  "departments": [
    { "code": "ROOMS", "readable": true, "writable": false,
      "reason": "DELEGATED",
      "assignedTo": [{ "userId": 42, "state": "ACTIVE", "canEdit": true }] }
  ] }
```

`writable` is authoritative — it is the same predicate a save will use, so the grid never has
to guess and never disagrees with what happens on save.

Reasons: `DELEGATED`, `HANDED_BACK`, `NOT_IN_WRITE_SCOPE`.

**A department with an `ACTIVE`, editing delegate is not writable by the owner.** The delegate
is the one editing it; the owner's route back is to withdraw the delegation, which is a
deliberate, audited act rather than a silent override.

**A read-only delegate (`canEdit: false`) displaces nobody.** The owner granted a look while
keeping the pen, so the department stays `writable: true` with `reason: null` and the holder
still appears in `assignedTo`. Render the two differently: an editing holder is who the
department belongs to right now, a read-only one is merely who else can see it. This is also
what keeps the [read-only delegation the outgoing owner keeps after a
transfer](#ownership-transfer) invisible to the new owner's lock list.

**A `HANDED_BACK` department is writable by the owner again.** The delegate has declared it
finished, so nobody else is editing it — the grant survives to keep their read access and to
make reopening one update, not to keep holding the department. `writable` flips back to `true`
for the owner the moment the last `ACTIVE` holder goes, and `reason` becomes `null`; the
`HANDED_BACK` reason is what the *delegate* is told about their own lost write access.
Reopening is the opposite move, and hands it back to the delegate.

Both transitions change this response without moving `planVersion`, so re-request it (and
honour the `ETag`) after any handback, reopen or withdrawal rather than after plan edits only.

`structureEditableByMe` is how a demoted owner learns they have lost the columns-and-blocks UI
instead of discovering it as a 403 at save time.

Only departments this caller can **read** are listed — a delegate holding three of thirty
would otherwise be handed the plan's full department structure plus the email address of
whoever holds each one.

### Support leases

The only path by which an administrator gains write access.

#### `GET /kairos/plans/{planId}/lease`

Readable by the **hotel**, not just by support: the owner whose publish just answered 423
needs to see the ticket reference and the expiry, or the failure is inexplicable. The stored
`reason` never appears — it can name a defect, a customer, or another property. Only
`ticketRef` travels.

#### `POST /kairos/plans/{planId}/lease` → 201

```json
{ "mode": "READ_ONLY_SUPPORT", "reason": "Investigating INC-4182", "ticketRef": "INC-4182",
  "minutes": 60 }
```

`READ_ONLY_SUPPORT` changes nothing about anyone else's access; it exists so that reading a
hotel's data is a decision somebody recorded. It grants its holder **reads only** —
break-glass PII included, writes excluded. The mode is honoured for the lease holder as much
as for everyone else.

`EXCLUSIVE` is the deliberate second step and **the only mode that confers write**. It sets
the plan to `LOCKED_BY_SUPPORT` and locks the owner out. If you are taking a lease in order
to change something, take this one.

5–240 minutes per acquisition, 1440-minute ceiling overall. Rate limited 10/hour.

While an `EXCLUSIVE` lease is held, commits from anyone but the lease holder get **423
Locked** (`kairos_plan_locked_by_support`) — the whole chunk, not row by row.

#### `PATCH /kairos/plans/{planId}/lease`

Extend. Only the holder may extend.

#### `DELETE /kairos/plans/{planId}/lease`

```json
{ "summary": "Corrected 3 duplicate positions in Rooms." }
```

Handback bumps `syncEpoch`, forcing every client to full-refresh. The response reports exactly
what moved, so the client can say "the server moved 812 → 847 while support held this plan"
instead of showing an unexplained pile of conflicts.

An administrator may release someone else's lease — a colleague who went home with a hotel
locked is exactly the situation this resolves — but it is audited as the release of a lease
they did not hold.

Releasing restores the plan's `state_at_acquire`, so a lease taken on an ARCHIVED plan does
not silently un-archive it.

### Administration

#### `GET /kairos/admin/plans/{planId}/bundle?pii={mode}&reason={text}&ticketRef={ref}&outputs={0|1}`

Whole-plan repro bundle as gzipped NDJSON. `pii` is `omit`, `pseudonymize` (default), or
`raw`. **`raw` requires a lease** — it is break-glass, never held by a bare administrator.

`reason` is a mandatory **query** parameter rather than a body, because this is a GET and the
reason must be impossible to omit — a bundle with no recorded justification is the one row
nobody can explain six months later.

Rate limited **20 per day** estate-wide per administrator: every call is a full export of one
hotel's plan, so a volume anomaly should be a 429 somebody has to explain rather than a
dashboard nobody reads.

Returns `Content-Disposition: attachment; filename="kairos-{planId}.ndjson.gz"` with
`X-Kairos-Rows` and `X-Kairos-Pii-Mode`. The gzip is part of the **payload**, not
`Content-Encoding` — the file the administrator saves is a `.ndjson.gz`.

#### `GET /kairos/admin/users/{userId}/scope?planId={id}&capability={cap}` — no-dept

**Why does this user see what they see?** Renders the resolver's own reasoning step by step,
by calling the same function that enforces the decision with a trace attached. A debugger that
reimplemented the rules would one day confidently explain a decision the system did not make.

Returns `inputs` (access type, OUs, departments, apps, owner eligibility, PII switch, live
lease, and every delegation **including dead ones with the reason they are dead** —
`REVOKED`, `REVOKED_FORCED`, `EXPIRED`, `NOT_STARTED_YET`), `steps`, and `outcome`.

"Anna has no access" is not an answer anybody can act on; "Anna's OU grant expired on 3 June"
is. Administrators only, rate limited 120/hour.

#### `GET /kairos/admin/plans?ou=&year=&ownerIneligible=&limit=&offset=` — no-dept

Every plan in the estate with the flags support triages on. Administrators only.

#### `GET /kairos/admin/hotels` — no-dept

Properties with Kairos activity: plan counts, last publish, entity totals.

#### `GET /kairos/admin/downloads?planId=&limit=` — no-dept

Every administrator export, with its reason. Deliberately readable by **any** administrator,
not just the one who made the download: a control nobody but its subject can inspect is not a
control.

#### `GET /kairos/admin/audit?planId=&action=&limit=` — no-dept

Kairos audit rows, filtered. Reads the existing append-only table.

<a id="ownership-transfer"></a>
#### `POST /kairos/plans/{planId}/transfer`

```json
{ "newOwnerUserId": 42, "reason": "Previous owner left the business" }
```

**Owner-callable.** It is listed here because support uses it too, but `plan:transfer` is an
`OWNER` capability: the plan's own owner calls this directly, with no lease and no
administrator involved. An administrator transferring somebody else's plan needs a lease
first, as with any other write.

The new owner must meet the **full eligibility bar** — transferring to somebody who cannot own
would create a plan in `OWNER_DEGRADED` from the moment of transfer, which looks exactly like a
bug to everyone involved.

Delegations held by the **incoming** owner are revoked in the same transaction — an owner is
not a delegate of themselves — but **everyone else's delegations survive the handover**, so
the new owner inherits the existing delegates and their departments intact.

##### The outgoing owner keeps read access

The **previous** owner is left with a [read-only delegation](#delegation-permission-flags) on
the plan, covering every delegatable department, **granted by the incoming owner**. Handing a
plan over is not the same as being evicted from it: without this the person who built the
numbers drops to `OU_VISITOR` the instant the transfer commits — the plan visible, not one byte
of it readable — with no route back except asking their successor for a grant.

It is an ordinary delegation and there is nothing new to build for it. It appears in the new
owner's `GET .../delegations` list like any other, with `canEdit: false`, and they withdraw it
whenever they like with the ordinary `DELETE /kairos/plans/{planId}/delegations/{delegationId}`.
It never expires on its own — withdrawal is the new owner's decision, not a timer's — and it
takes nothing away from them: a read-only holder does not lock a department in
[`department-ownership`](#get-kairosplansplaniddepartment-ownership).

Retention is **best effort and never fails the transfer.** A predecessor who has been
deactivated, has lost access to the property, or holds none of the plan's departments simply
gets no row, and `retainedReason` says which — the commonest reason to hand a plan over is that
its owner is leaving, so this is the normal case rather than the exotic one:

| `retainedReason` | Meaning |
|---|---|
| `SELF_TRANSFER` | New owner is the current owner; nothing was handed over. |
| `PREVIOUS_OWNER_INACTIVE` | Deactivated or unapproved — the usual outcome once offboarding has run. |
| `OU_ACCESS_REVOKED` | No live access to the property any more. |
| `NO_KAIROS_APP` / `NO_DEPARTMENT_ACCESS` | Their own grants no longer support a delegation. |
| `NO_GRANTABLE_DEPARTMENTS` | The plan has no department with live rows. |
| `NO_OVERLAP` | No delegatable department intersects their department access. |
| `ALREADY_DELEGATED` | They already hold a live delegation on this plan. |

Response:

```json
{ "planId": "...", "ownerUserId": 42, "ownerEmail": "successor@example.com",
  "delegationsRevoked": 1,
  "retainedDelegation": { "id": "...", "delegateUserId": 7, "departments": ["ROOMS"],
                          "canEdit": false, "canReadPii": true },
  "retainedReason": null }
```

`retainedDelegation` is `null` exactly when `retainedReason` is set, and vice versa.

Transferring to yourself is permitted: reassigning a departed owner's plan is legitimate. It
retains nothing (`retainedReason: "SELF_TRANSFER"`), and it confers ownership only, never the
admin-author carve-out described in §3.

### Clusters

A named group of hotels. Clusters span properties, so they are synced as a separate global
resource rather than inside a plan bundle.

#### `GET /kairos/clusters/version` — no-dept
#### `GET /kairos/clusters` — no-dept

Returned whole rather than scoped to the caller's OUs: the desktop needs the full list to
render its picker, and a cluster's name and member OUs are the same estate structure already
visible in the hotel catalog.

#### `PUT /kairos/clusters` — no-dept

Administrators only — an owner at hotel A must not be able to add hotel B to a group and
change what B's users see in their own picker. Rate limited 120/hour. Removed clusters are
tombstoned, not deleted.

#### `GET /kairos/clusters/{clusterId}/divergence?year={year}` — no-dept

Are the hotels in this cluster configured alike? **Advisory only — it reports drift, it never
propagates anything.**

Server-side propagation is permanently out of scope: doing it with system privileges would let
a delegate holding one department at one hotel write into a sibling hotel's budget with no
grant anywhere. The desktop propagates client-side, under the user's own credentials,
publishing to each property as itself.

Scoped to the members this caller can reach, with `omittedCount` saying how many were left
out — a user seeing one row of a four-hotel cluster must not read it as "we are consistent".

---

## 7. Limits

| Setting | Default |
|---|---|
| `commitMaxEntities` | 5,000 |
| `commitMaxBytes` | 1 MiB |
| `changesMaxBytes` | 1 MiB (default page 256 KiB) |
| `manifestMaxEntities` | 10,000 |
| Entity payload | 256 KiB |
| Inflated request body | 32 MiB |
| Artifact | 16 MiB |
| BST rows | 20,000 |
| Upload part / parts | 1 MiB / 256 |
| Upload TTL | 24 h |
| Idempotency TTL | 168 h (7 days) |
| PII page | 500 rows |
| Lease default / max / ceiling | 60 / 240 / 1440 min |
| Revoked delegation visibility | 30 days |

The first four are served on `/sync/heads` and on every commit response as `limits`. **Read
them from there** rather than hard-coding, so a server-side change is enough.

## 8. Rate limits

Per user, as `requests/seconds`.

| Bucket | Limit |
|---|---|
| commit | 240/h |
| changes | 600/h |
| manifest | 120/h |
| pii read | 600/h |
| bst read | 120/h |
| bst upload | 20/h |
| kpi series | 600/h |
| uploads | 600/h |
| artifacts | 60/h |
| clusters | 120/h |
| delegation | 60/h |
| candidates | 60/min |
| presence | 120/h |
| lease | 10/h |
| scope debug | 120/h |
| bundle | **20/day** |

## 9. Error codes

Branch on `code`.

**Access**
`kairos_scope_empty`, `kairos_plan_not_shared`, `kairos_plan_not_found`,
`kairos_not_owner_or_delegate`, `kairos_not_plan_owner`, `kairos_owner_not_eligible`,
`kairos_owner_entitlement_lapsed`, `kairos_structure_owner_only`, `kairos_plan_not_editable`

Distinguish the first two — they look alike and mean opposite things to a user:

- **`kairos_scope_empty`** is the deliberately opaque denial. It does not say whether the plan
  exists, whether your OU grant lapsed, or whether a delegation was revoked last March, because
  each of those distinctions is something an attacker can probe for. Show it as-is; there is no
  action the user can take from it beyond contacting an administrator.
- **`kairos_plan_not_shared`** is the one case where the server says more, because it already
  said more: the plan is in this caller's listing, with its label and its owner's address, so
  there is nothing left to conceal. It means *this specific plan exists at your hotel and its
  owner has not delegated it to you*. Render it as an invitation to ask `ownerEmail`, not as a
  failure.

**Delegation**
`kairos_delegate_cannot`, `kairos_delegate_read_only`, `kairos_delegate_no_create`,
`kairos_delegate_no_delete`, `kairos_delegate_no_pii`, `kairos_delegation_no_overlap`,
`kairos_delegation_partial_overlap`, `kairos_delegation_revoked`,
`kairos_delegation_expired`, `kairos_delegate_is_owner`, `kairos_delegate_scope_empty`,
`kairos_delegate_has_unsynced_work`, `kairos_handback_with_unsynced_work`

**Departments**
`kairos_department_out_of_scope`, `kairos_department_not_in_plan`,
`kairos_department_handed_back`, `kairos_department_unassigned`

**PII**
`kairos_pii_disabled_for_ou`, `kairos_raw_pii_requires_lease`,
`kairos_pii_erase_unconfirmed`

**Leases**
`kairos_plan_locked_by_support` (423), `kairos_requires_admin_lease`,
`kairos_lease_held_by_other`, `kairos_lease_ceiling_reached`,
`kairos_lease_reason_required`, `kairos_lease_not_held`

**Sync**
`kairos_sync_epoch_changed`, `kairos_cursor_invalid`,
`kairos_idempotency_key_mismatch`, `kairos_idempotency_expired`,
`kairos_unknown_entity_type`, `kairos_orphan_entity`, `kairos_client_too_old`

**Resources**
`kairos_structure_not_found`, `kairos_doc_hash_mismatch`, `kairos_bst_not_found`,
`kairos_bst_hash_mismatch`, `kairos_artifact_not_found`, `kairos_upload_bad_kind`,
`kairos_upload_no_plan`, `kairos_upload_not_a_workbook`, `kairos_plan_id_taken`,
`request_too_large` (413)

`kairos_idempotency_key_mismatch` means a key was replayed with a **different body**. That is a
client bug, and replaying the stored response for it would silently discard the new writes —
the worst possible failure for the mechanism that exists to prevent data loss.

---

## 10. First publish, end to end

```
1.  GET  /kairos/ou/{ou}/settings              → is PII storage on here?
2.  GET  /kairos/sync/heads?ou={ou}            → limits, applyOrder, existing plans
3.  POST /kairos/plans                         → register (id = local scenarios.id)
4.  PUT  /kairos/ou/{ou}/structure             → field catalog, blocks, schemes
5.  POST /kairos/plans/{id}/commits?bootstrap=1  ─┐ chunk 1: baseVersion 0
    POST /kairos/plans/{id}/commits             │ chunk 2: baseVersion 1
    ...                                         │ each ≤5,000 entities and ≤1 MiB
                                               ─┘ each with its own Idempotency-Key
6.  PUT  /kairos/ou/{ou}/bst                   → workbook (or the resumable flow)
7.  PUT  /kairos/plans/{id}/artifacts/engine_output
8.  POST /kairos/plans/{id}/presence           → dirtyEntities: 0
```

Chunk in `applyOrder`. Advance `baseVersion` to the `committedVersion` of the previous chunk.
Mint a fresh `Idempotency-Key` per chunk and **reuse it on retry** — that is the whole point of
it. A shared `commitGroupId` ties the chunks together for audit.

### Steady state thereafter

```
loop:
  GET /kairos/sync/heads?ou={ou}  (If-None-Match)
  → 304                                  nothing to do
  → 200, relation == OU_VISITOR           NOT YOURS: draw the locked tile from label +
                                          ownerEmail and skip every step below for this plan
  → 200, syncEpoch changed               full refresh, server wins
  → 200, version > local watermark        GET /changes?since={watermark}, page to the end
  → 200, structureVersion changed         GET /ou/{ou}/structure
  → 200, bst.contentHash changed          GET /ou/{ou}/bst
  → 200, authzVersion changed             re-render permissions; re-check department-ownership
  local dirty rows                        POST /commits, chunked
  after a local rebuild or a conflict storm
                                          POST /manifest/diff, then reconcile
```

**Check `relation` first, before anything else in that loop.** An `OU_VISITOR` entry has a
`null` version, so a client comparing it against a local watermark with `>` will simply do
nothing (correct by luck), but one that coerces `null` to `0` will pull forever against a 403.
`/presence` and `/activity` are refused for these plans too, so a client that posts presence
unconditionally on plan open will see a 403 there — harmless, since a visitor has no local work
by construction, but do not surface it as an error.

A visitor's probe ETag is stable while the plan changes, because the fields that move are the
ones being withheld. It updates when the plan's `state` changes and when `authzVersion` moves —
and granting a delegation bumps `authzVersion`, so the moment the owner shares the plan the next
poll returns 200 and the client sees a real relation.

---

## 11. Notes for test harnesses

- **`hash` must be produced the way the Electron client produces it.** The server never
  recomputes it. A fixture that generates hashes with Python `json.dumps` will match nothing —
  every row will come back `STALE` or `ALREADY_EXISTS`.
- **A plan with `version = 0` has never had a successful commit.** Rows in `kairos_plans` and
  `kairos_plan_presence` with nothing in `kairos_plan_entities` means the client registered the
  plan and pinged presence but never published. Presence is advisory and writes a row without
  any data changing hands.
- **A commit that accepts nothing still returns 200.** Assert on `accepted`, `conflicts` and
  `rejected`, not on the status code.
- **`kairos_plans.ou` is a foreign key to `hotels.ou`.** A plan cannot exist for an OU with no
  hotel row.
- **Plans are soft-deleted.** Almost every query needs `deleted_at IS NULL`; a test that counts
  plans without it will drift.
- **Owner eligibility needs all four conditions**, including all-departments. A partial-
  department test user cannot create a plan, write structure, or upload a workbook — this is
  the most common reason a fixture silently publishes nothing.
- **An administrator can create and publish a plan with no lease**, and resolves as `OWNER`
  on it. A plan merely *transferred* to an administrator still needs one — so a fixture that
  transfers rather than creates will keep getting `kairos_requires_admin_lease`.
- **A `READ_ONLY_SUPPORT` lease does not grant write**, to its holder either. A test that
  acquires the default mode and then publishes will get 403; use `mode: "EXCLUSIVE"`.
- **Testing as an administrator never exercises the `OWNER` branch for a hotel user.** For
  the real client path you need a `hotel_admin` with write on the OU and all departments.
- The test suite builds its schema with `Base.metadata.create_all` on SQLite, which is why the
  models use flat `kairos_` table names in the default schema rather than a Postgres schema,
  `sa.JSON` rather than `JSONB`, and no partial unique indexes.

---

## 12. Design decisions worth not re-litigating

**Why the server never parses payloads.** The Kairos field catalog is at seed v24 with 23
prior bumps, and several client versions are always in the field at once. Mirroring its
columns would make every Kairos release an Alembic migration.

**Why `departmentCode` is the one exception.** It is authorization metadata, not domain data.
Denormalising it onto inherited child rows at write time is what makes the entire department
filter expressible as a single `WHERE` rather than a join every query might forget.

**Why publish is chunked commits rather than one upload.** Each chunk is individually
retriable and validated on arrival. One blob would have to be fully assembled before any of it
could be checked.

**Why revocation is a timestamp.** Point-in-time reconstruction of who could see a hotel's
salaries between two dates is exactly what a compliance review asks, and a DELETE makes it
unanswerable.

**Why PII is one sealed AEAD blob per position rather than field-by-field encryption.** One
nonce, one integrity tag, and the catalog-driven `extraValues` is covered automatically. The
per-plan data key means erasure is crypto-shredding rather than a delete sweep.

**Why presence is not a lock.** An offline-capable desktop client cannot hold a pessimistic
lock honestly, and a crashed one would strand it forever.
