# Riff Intelligent Review Presenter Design

**Date:** 2026-08-22

**Status:** Architectural design approved; written specification awaiting human review

**Scope:** One in-memory, reasoning-only vertical slice inside the existing Chirp FastAPI service

## Goal

Prove one complete Riff intelligence and human-review path:

```text
External main agent inspects Grasshopper and Chirp
-> submits one canonical CanvasReasoningSnapshot
-> one owner evaluates the active import attempt
-> Riff publishes an intelligent or deterministic presentation
-> the checked-in presenter renders trusted templates
-> a human decides each node through the existing review API
-> Riff exports one self-contained Review Matrix
-> the external main agent may use that matrix to author corrections
```

Riff observes, organizes, presents, and records intervention on structured Chirp reasoning. Geometry and canvas mutation are completely outside this contract.

The design principle is:

> Give the LLM broad semantic authority and narrow operational authority.

The intelligent presenter may reason across novel roles, topology, complete reasoning packets, and arbitrary JSON payloads. It may select and order trusted templates, write grounded summaries and highlights, and propose advisory candidate changes. It cannot alter source reasoning, generate UI code, make human decisions, or operate Grasshopper.

## System Boundary and Responsibilities

```text
Grasshopper + Chirp
    |
    | inspected by the external main agent through existing Rook tools
    v
CanvasReasoningSnapshot
    |
    | POST /api/riff/snapshots
    v
Riff snapshot service
    |-- validates and fingerprints the immutable snapshot
    |-- coordinates snapshot-id idempotency
    |-- invokes RiffPresenter once for the owning import attempt
    |-- validates intelligent output or builds deterministic fallback
    |-- creates one pending review record per node
    `-- atomically publishes the snapshot presentation
           |
           | GET /api/riff/snapshots/{snapshot_id}
           v
Trusted static presenter at /riff/presenter.html
           |
           | POST /reviews/{packet_id}/decision
           v
Existing locked review store
           |
           | GET /api/riff/snapshots/{snapshot_id}/matrix
           v
Self-contained Review Matrix for the external main agent
```

Ownership is deliberately narrow:

- Chirp remains the reasoning engine inside Grasshopper.
- Riff is the reasoning-observation, presentation, and human-review layer.
- The external main LLM agent remains the orchestrator and canvas editor.
- The web application renders checked-in components and collects human decisions.
- The existing review store remains the sole owner of review records and their lock.
- The deterministic renderer remains available whenever intelligence fails.

The stale accepted-geometry language in `ARCHITECTURE.md` and `ROADMAP.md` must be corrected before implementation merges. The approved boundary releases reviewed reasoning to the external orchestration flow; it never snapshots, gates, duplicates, transports, or understands geometry.

## Canonical Input Snapshot

The import body is a strict, self-contained `CanvasReasoningSnapshot`:

```text
CanvasReasoningSnapshot
|-- canvas_id: string
|-- snapshot_id: string
|-- run_id: string
|-- captured_at: timezone-aware datetime
`-- nodes: ordered nonempty list[CanvasReasoningNode]
    |-- node_id: string
    |-- role: string
    |-- display_label: string
    |-- upstream_node_ids: ordered list[string]
    `-- reasoning_packet: ReviewPacket
```

All request models forbid undeclared fields. Identifiers and labels are required nonblank strings. The embedded `ReviewPacket` is the complete existing strict model, including proposal, inputs, assumptions, parameters, rationale, uncertainties, payload, and provenance. JSON values must remain finite and JSON-compatible.

### Identity and topology rules

- `canvas_id` stably identifies the Grasshopper definition.
- `snapshot_id` identifies one immutable captured state and is the import idempotency key.
- A changed canvas state receives a new `snapshot_id`; an earlier snapshot is never mutated.
- `node_id` is the stable Grasshopper component-instance ID supplied by the producer.
- A node keeps the same `node_id` across snapshots.
- A label, role, canvas position, list index, Rook short alias, or component-type GUID must never be used to derive `node_id`.
- Node IDs are unique within the snapshot.
- `ReviewPacket.provenance.component_id` must equal its containing node's `node_id`.
- `ReviewPacket.provenance.run_id` must equal the containing snapshot's `run_id`.
- `ReviewPacket.role.strip().casefold()` must equal `CanvasReasoningNode.role.strip().casefold()`.
- Every `upstream_node_ids` reference must resolve to another node in the same snapshot.
- Self-references and duplicate upstream references are invalid.
- Node order and upstream-reference order are preserved for deterministic presentation and export.
- Cycle detection, graph ranking, reachability analysis, and other graph algorithms are excluded.

The snapshot contains no geometry, component positions, binary Grasshopper data, arbitrary canvas objects, or serialized geometry hidden in a dedicated transport field. Arbitrary domain payloads remain permitted only as JSON-compatible values inside the established `ReviewPacket.payload` contract.

### Validation and fingerprinting

The complete snapshot is validated before presenter invocation. Invalid snapshots receive FastAPI's standard HTTP `422` response and never invoke the presenter or create state.

After validation, the service serializes the complete validated model in JSON mode with sorted object keys, compact separators, and preserved list order, then computes a SHA-256 content fingerprint. The fingerprint includes the full snapshot envelope. It is used only for process-local idempotency comparison and is not exposed as an agent contract.

## Snapshot Import Lifecycle

### API behavior

```http
POST /api/riff/snapshots
```

- A newly accepted snapshot returns HTTP `201` with the completed stored presentation.
- An identical repeat of a completed snapshot returns HTTP `200` without another presenter call or review creation.
- The same `snapshot_id` with different content returns HTTP `409`.
- Invalid input returns HTTP `422` before lookup or presenter work.
- The request is intentionally synchronous and returns only when an immediately renderable intelligent or fallback result has been published.

The completed response is a strict envelope containing:

```text
SnapshotPresentationResponse
|-- snapshot: CanvasReasoningSnapshot
|-- presentation_source: intelligent | fallback
|-- view_model: ReviewViewModel
|-- riff_annotations: ordered list[RiffAnnotation]
`-- node_reviews: ordered list[NodeReviewMapping]
    |-- node_id
    `-- packet_id
```

The mapping is read-only. Riff assigns each node exactly one new review `packet_id` during publication. The immutable relation is:

```text
canvas_id + snapshot_id + node_id -> packet_id
```

The same node in a later snapshot receives a new packet ID. The presenter sees and emits only `node_id`; it never receives, chooses, or generates packet IDs.

### Idempotency and in-flight coordination

The process has two dedicated structures:

- a completed snapshot dictionary keyed by `snapshot_id`;
- an in-flight map keyed by `snapshot_id` for imports currently owned by one request.

For a validated request:

1. Compute the content fingerprint.
2. Under the snapshot lock, inspect completed and in-flight records.
3. A completed identical fingerprint returns a defensive copy with HTTP `200`.
4. A completed different fingerprint returns HTTP `409`.
5. An identical in-flight request waits on its owner's deterministic synchronization record.
6. A different in-flight fingerprint returns HTTP `409` immediately.
7. A new ID installs one in-flight owner record, releases the lock, and performs presentation work.
8. The owner returns HTTP `201` after successful publication. Identical waiters return HTTP `200` with the same completed result.

Concurrent identical duplicates never create duplicate presenter calls or review batches. Completed identical imports bypass the presenter entirely. These are the limits of the at-most-once guarantee: after an unexpected unpublished failure is fully cleaned up, a later explicit retry may become a new owner and invoke the presenter again. No failure tombstone is retained.

Coordination uses `threading.Event`, a condition, or an equivalent deterministic primitive. It does not use sleeps or timing thresholds.

The in-flight entry is removed after success or failure. Waiters are signaled only after both publication locks have been released. If an unexpected pre-publication failure occurs, no completed snapshot is stored, no review batch remains, and every waiter is released to receive a safe generic failure.

## Riff Intelligent Presenter

`RiffPresenter` is a long-lived service injected with the application's existing long-lived `ChirpAdapter`. It is not constructed per request and does not modify `ChirpAdapter`.

The presenter owns a code-defined prompt identified by `RIFF_PRESENTER_PROMPT_VERSION = "1.0"`. It serializes the complete validated snapshot to JSON and clearly identifies it as untrusted source data rather than executable instructions. New Chirp roles and changed content invoke the presenter for every new `snapshot_id`; the normal path does not use the fallback's fixed role rules.

The adapter call follows the existing interface exactly:

```python
result = adapter.call(
    signature="riff_instructions, snapshot_json -> candidate_json",
    inputs={
        "riff_instructions": RIFF_PRESENTER_PROMPT,
        "snapshot_json": snapshot_json,
    },
    schema={"candidate_json": "str"},
    category=None,
    use_cache=False,
    model=presenter_model,
)
candidate_text = result["outputs"]["candidate_json"]
```

Each call receives a fresh inputs dictionary because `ChirpAdapter.call()` may mutate it. `use_cache=False` bypasses only ChirpAdapter's response cache. It does not disable or reconfigure DSPy's secure global cache. The snapshot store is the authoritative guarantee that completed and concurrent identical imports do not invoke the presenter again.

The optional model comes from `RIFF_PRESENTER_MODEL`. If unset, the wrapper uses the adapter default and existing provider configuration. API callers cannot select a model, and model names do not appear in data contracts.

The model must return exactly one raw JSON object with no Markdown fence, prefix, suffix, or explanation. Standard-library parsing rejects duplicate object keys at every nesting level, `NaN`, `Infinity`, and `-Infinity`, and any top-level value other than an object. It also rejects trailing content through normal strict document parsing. The parsed object then receives strict Pydantic and semantic validation. The wrapper never repairs or partially accepts malformed candidates.

Provider failures, provider- or adapter-enforced timeout exceptions, parsing failures, schema violations, grounding failures, or semantic violations invoke deterministic fallback. Riff adds no wrapper-owned timeout, worker thread, future timeout, or cancellation layer because `ChirpAdapter.call()` exposes no safe timeout or cancellation interface. Clients initiating import must tolerate the provider's full synchronous duration, and no short Grasshopper HTTP timeout is reused.

The adapter's private `reasoning` output is discarded. Provider exceptions, prompts, credentials, stack traces, model names, token usage, and latency are not stored or returned in snapshot, presentation, annotation, or matrix contracts. Safe usage and latency metadata may be logged.

## Presenter Candidate Contract

The LLM may emit only this strict declarative model:

```text
PresenterCandidate
|-- sections: ordered list[PresenterSection]
|   |-- template: TemplateId
|   |-- node_ids: ordered list[string]
|   |-- heading: optional string
|   |-- annotation_ids: ordered list[string]
|   `-- emphasis: normal | high
`-- riff_annotations: ordered list[RiffAnnotation]
    |-- annotation_id: string
    |-- kind: AnnotationKind
    |-- text: string
    |-- severity: AnnotationSeverity
    `-- sources: ordered list[SourceRef]
        |-- node_id: string
        |-- scope: reasoning_packet | node
        `-- field_path: string
```

Every model forbids undeclared fields. Identifiers and annotation text are nonblank after trimming. Every section references at least one node. Optional headings are trimmed, nonblank plain text. HTML and Markdown are never interpreted.

### Trusted templates

The fixed template enum is:

```text
run_summary
node_reasoning
proposal_details
conflicts_uncertainties
provenance
human_review
```

Five templates are presenter-selectable: `run_summary`, `node_reasoning`, `proposal_details`, `conflicts_uncertainties`, and `provenance`. The model may select, group, order, frame, and emphasize them.

`human_review` is mandatory application behavior for every node. The model may position a valid placeholder, but it cannot omit the final control, duplicate it, change its fields, or provide decision values. Deterministic post-processing supplies missing review sections.

Template configuration contains only typed references and plain text. It contains no styles, HTML, JavaScript, CSS classes, URLs, arbitrary property bags, dynamic imports, or executable behavior. Unknown templates invalidate the complete intelligent result.

### Annotation kinds and severity

Annotation kinds are a strict enum:

```text
summary
highlight
conflict
uncertainty
review_focus
change_candidate
```

A `change_candidate` is advisory Riff analysis describing a possible change to a Chirp node. It is not a human decision, Correction-pin value, executable command, or canvas operation. The external main agent decides whether to author any correction.

Severity is required on every intelligent annotation:

```text
informational  useful context or synthesis that does not appear to require intervention
attention      something to examine before relying on the reasoning
blocking       an issue Riff believes should be resolved before the reasoning is dependable
```

Severity is labeled in the UI as **Riff assessment** or **Riff priority**. It is not numeric, is not a review decision, and has no automatic effect. A blocking annotation cannot disable Accept, change status, reject a node, create a correction, trigger the external agent, or stop Grasshopper. Schema validation does not hardcode annotation-kind/severity pairings, and neither the server nor UI silently reorders annotations by severity.

### Grounding with JSON Pointer

Every annotation has at least one supporting `SourceRef`. The scope defines the immutable object against which its pointer is resolved:

```text
reasoning_packet  the complete embedded ReviewPacket
node              node_id, role, display_label, and upstream_node_ids
```

Examples:

```text
reasoning_packet  /proposal
reasoning_packet  /assumptions/0
reasoning_packet  /parameters/2/value
reasoning_packet  /payload/conflicts/0
reasoning_packet  /provenance/parent_packet_ids
node              /role
node              /display_label
node              /upstream_node_ids/0
```

Pointers use RFC 6901 JSON Pointer syntax without URI-fragment form:

- A pointer is nonempty and starts with `/`.
- `~0` and `~1` are the only valid escapes.
- Invalid escape sequences are rejected.
- Array references use canonical nonnegative indexes.
- The `-` append token, wildcards, filters, JSONPath, URI fragments, and relative pointers are rejected.
- The pointer must resolve to an existing value in the chosen scope.
- Container values may be cited; precise child values are preferred for precise claims.
- Duplicate source references within one annotation are invalid rather than silently deduplicated.
- Every node reference and annotation reference must resolve inside the same snapshot bundle.

Resolution is implemented directly without a new dependency. One invalid node, scope, pointer, unresolved value, duplicate source, or invalid reference invalidates the complete intelligent candidate and invokes fallback. Validated source references are preserved unchanged in the Review Matrix.

## Final Review View Model

After strict candidate validation, deterministic post-processing produces a reference-only manifest:

```text
ReviewViewModel
|-- schema_version: literal "1.0"
|-- snapshot_id: string
`-- sections: ordered list[PresenterSection]
```

`snapshot_id` must match the stored snapshot and API envelope. The renderer follows section order exactly. IDs cannot repeat within a section. An annotation may be referenced by multiple sections, but every stored annotation must be referenced at least once. Section node IDs are normalized to snapshot order.

Final template cardinality is:

- `run_summary`: exactly one, first, referencing all nodes in original snapshot order.
- `node_reasoning`: exactly one per node, referencing only that node and rendering its complete immutable `ReviewPacket`.
- `human_review`: exactly one per node, referencing only that node and rendering fixed application-owned controls.
- `proposal_details`: zero or one per node.
- `provenance`: zero or one per node.
- `conflicts_uncertainties`: zero or more and may reference one or multiple nodes.

Deterministic post-processing inserts missing mandatory run-summary, node-reasoning, and human-review sections; moves the run summary to the first position; and normalizes node ordering. Contradictory cardinality, duplicate mandatory sections, invalid references, or inaccessible nodes invalidate the intelligent candidate and invoke fallback. The LLM cannot suppress a node or make its complete source reasoning inaccessible.

The final view model contains no copied reasoning, annotation bodies, review state, packet IDs, styles, provider metadata, adapter reasoning, or arbitrary renderer configuration. Immutable snapshot content, Riff annotations, mappings, and `presentation_source` are separate fields in the stored and API envelope.

## Role-Aware Deterministic Fallback

Fallback applies only after the snapshot has passed validation. It produces a strict `ReviewViewModel`, sets:

```text
presentation_source: fallback
riff_annotations: []
```

It generates exactly one run summary from source metadata only: canvas ID, run ID, captured time, and node count.

Roles are normalized by trimming and case-insensitive matching. Only `planner` and `critic` are explicitly recognized. Every other role uses the general ordering. Node order remains unchanged.

```text
planner
-> proposal_details
-> node_reasoning
-> conflicts_uncertainties when supported source fields are nonempty
-> provenance
-> human_review

critic
-> conflicts_uncertainties when supported source fields are nonempty
-> node_reasoning
-> proposal_details
-> provenance
-> human_review

unknown or general
-> node_reasoning
-> proposal_details
-> provenance
-> human_review
```

Fallback source selection is fixed:

- `proposal_details` uses only proposal, inputs, assumptions, parameters, and payload.
- `node_reasoning` presents the immutable rationale as its primary narrative while rendering the complete packet as inspectable source reasoning.
- `conflicts_uncertainties` uses only the canonical uncertainties list and a nonempty `payload.conflicts` value when that value is explicitly a list of strings.
- Unsupported `payload.conflicts` types are not interpreted.
- No conflict is inferred from free-form rationale or proposal text.
- `conflicts_uncertainties` is omitted when both supported fields are empty.
- `provenance` uses only packet provenance, role, and contributor.
- `human_review` remains mandatory and is populated only from review state.

Fallback generates no summaries, highlights, inferred conflicts, change candidates, annotations, or severity values. The same valid snapshot always produces the same section order and source selection. Tests assert structure and selected fields rather than incidental prose formatting.

## Review Records and Atomic Publication

Every node receives exactly one pending record in the existing review store. Existing request validation and decision rules remain unchanged:

- one terminal decision per immutable packet;
- reviewer required;
- correction and rejection require a nonblank note;
- `accepted`, `correction_requested`, and `rejected` are terminal.

`review.py` adds only narrow internal all-or-nothing batch creation and defensive batch-read operations. It remains unaware of snapshots, presentations, and Review Matrix models. `riff_snapshot.py` never accesses review dictionaries or locks directly and never calls the existing HTTP API from inside the service.

### Transaction boundary

All expensive work and validation occurs before publication. The fixed lock order is always snapshot lock, then review lock:

```text
prepare and validate everything possible
-> acquire snapshot lock
-> recheck snapshot identity and idempotency
-> acquire review lock through the internal batch function
-> insert the complete ordered pending review batch
-> invoke the constrained snapshot commit callback
-> release review lock
-> release snapshot lock
-> notify in-flight waiters
```

The review batch function passes the callback an immutable ordered tuple of newly created review envelopes matching node order exactly. The callback is synchronous, internal, and non-reentrant. It may only assemble the node-to-packet mapping and assign the already-prepared completed bundle to the snapshot dictionary. It performs no validation, serialization, logging, HTTP or LLM calls, blocking work, review calls, or lock acquisition, and it never reacquires the snapshot lock.

If the callback fails, `review.py` removes the complete inserted batch before releasing the review lock, while `riff_snapshot.py` removes any provisional snapshot assignment before releasing the snapshot lock. The exception then follows normal import-failure handling. Waiters are signaled only after both stores are clean and both locks are released.

Review endpoints continue to acquire only the review lock. Snapshot reads acquire only the snapshot lock. Review Matrix assembly acquires the snapshot lock and then uses the review defensive batch-read operation, preserving the same lock order. No `RLock`, public rollback endpoint, transaction framework, global coordinator lock, or database abstraction is added.

Only completed immutable bundles are stored. Each bundle contains defensive copies of the validated snapshot and view, immutable annotations, `presentation_source`, content fingerprint, and ordered node-to-packet mapping. Reads return defensive deep copies.

The Review Matrix is never stored because its human-review layer changes over time.

## Snapshot Retrieval API

```http
GET /api/riff/snapshots/{snapshot_id}
```

The endpoint returns the stored strict `SnapshotPresentationResponse` containing the immutable snapshot, stored `ReviewViewModel`, immutable annotations, `presentation_source`, and node-to-packet mappings. It never invokes the presenter. An unknown snapshot returns HTTP `404`.

## Review Matrix Export

```http
GET /api/riff/snapshots/{snapshot_id}/matrix
```

The endpoint reads the immutable bundle and joins current review records under the approved lock order. It never invokes the presenter, mutates state, creates records, or performs additional API lookups. An unknown snapshot returns HTTP `404`.

The strict, self-contained result is:

```text
ReviewMatrix
|-- schema_version: literal "1.0"
|-- canvas_id
|-- snapshot_id
|-- run_id
|-- captured_at
|-- exported_at
|-- presentation_source: intelligent | fallback
|-- review_complete: boolean
|-- riff_annotations: ordered list[RiffAnnotation]
`-- nodes: ordered list[ReviewMatrixNode]
    |-- node_id
    |-- role
    |-- display_label
    |-- upstream_node_ids
    |-- reasoning_packet: complete immutable ReviewPacket
    `-- review
        |-- packet_id
        |-- created_at
        |-- status
        `-- decision: complete existing DecisionRecord | null
```

Rules:

- Snapshot node order is preserved exactly.
- Original packets are embedded without rewriting.
- Current review state is joined at export time.
- `exported_at` is a timezone-aware UTC timestamp recording that join.
- `review_complete` is true only when no node remains pending.
- Pending nodes remain in the artifact.
- Riff annotations remain immutable and separate from source reasoning and human decisions.
- Cross-node annotations appear once and retain all validated source references.
- Repeated exports with unchanged review state are semantically identical except for `exported_at`.
- The matrix includes no view model, template ordering, layout, CSS, HTML, or rendering instructions.
- No additional lookup is needed to interpret the artifact.

## Trusted Web Presenter

The intelligent presenter is a separate static entry point using exclusively new files:

```text
Chirp/web/presenter.html
Chirp/web/presenter.js
Chirp/web/presenter.css
```

The existing `Chirp/web/index.html`, `app.js`, and `styles.css` remain unchanged as a working packet-queue fallback.

The presenter is directly addressable at:

```text
/riff/presenter.html?snapshot_id={snapshot_id}
```

It uses root-relative same-origin requests and adds no CORS behavior:

```text
GET  /api/riff/snapshots/{snapshot_id}
GET  /api/riff/snapshots/{snapshot_id}/matrix
POST /reviews/{packet_id}/decision
```

The first GET loads immutable presentation data. The matrix GET loads all current per-node review state in one request, including correct state after a page reload. After a successful decision, the page updates that node locally from the decision response. A manual refresh reloads the matrix; continuous polling is excluded.

The page provides one fixed **Download Review Matrix JSON** action. Every activation refetches `GET /api/riff/snapshots/{snapshot_id}/matrix` and downloads the successful response body verbatim as JSON. JavaScript does not assemble, merge, normalize, parse-and-reserialize, or reuse a previously fetched matrix for export. A failed refetch produces a readable error and no download.

Missing, blank, malformed, not-yet-published, or unknown snapshot IDs produce clear non-crashing states. Because partial snapshots are never exposed and no background-status endpoint exists, a request made while import is still running can only report that the snapshot is not yet available. The client that initiated the synchronous POST owns its visible waiting state and may retry safely with the same `snapshot_id`.

The six templates are explicit checked-in renderer functions reached through a fixed template-ID dispatch table. Unknown templates and invalid references fail closed with a clear error and are never rendered through a generic escape hatch. `human_review` controls are deterministic and obtain values only from the mapping, matrix, and existing review API.

All packet and model text is inserted with `textContent` or equivalent safe DOM construction. The page never uses `eval`, dynamic imports, `innerHTML` for untrusted content, generated markup, model-provided styles/classes, external assets, frameworks, npm, or build tooling.

The interface clearly labels:

- **Source reasoning** for immutable Chirp content;
- **Riff summary**, **Riff highlight**, or **Riff assessment** for generated annotations;
- **Human review** for reviewer identity, note, action, and status;
- `presentation_source: intelligent | fallback` for the presentation origin.

The complete immutable `ReviewPacket` for every node remains inspectable regardless of selected templates or generated summaries. Presentation can emphasize source content but cannot suppress it.

## API and Static Boundaries

The same-origin application uses three separate route families:

```text
/riff/          static web application
/api/riff/      snapshot, presentation, and Review Matrix API
/reviews/       existing review and decision API
```

Routes are registered before the static mount, but correctness does not depend on route order because the API does not live beneath `/riff/`.

The only new snapshot routes are:

```http
POST /api/riff/snapshots
GET  /api/riff/snapshots/{snapshot_id}
GET  /api/riff/snapshots/{snapshot_id}/matrix
```

Mounting `Chirp/web/` at `/riff/` remains an integration prerequisite. `GET /reviews?status=pending` is explicitly excluded from this slice: the new presenter does not use it, and the existing packet queue remains available in mock mode until a separately reviewed queue endpoint exists. Snapshot listing, deletion, regeneration, dedicated retry, streaming, and background-status endpoints are excluded.

## Failure Behavior

- Invalid snapshots return standard HTTP `422` and create no state.
- Reused snapshot IDs with different content return HTTP `409`.
- Provider failures, provider- or adapter-enforced timeout exceptions, parsing failures, schema violations, grounding failures, or semantic violations produce a validated deterministic fallback and still publish a usable review workflow.
- Unexpected failures before or during publication return a safe generic server error, expose no provider details, clean both stores, and release waiters.
- Unknown stored snapshots return HTTP `404`.
- Stored retrieval, rendering, and export never call the LLM again.
- There is no automatic presenter retry or regenerate action.
- Invalid or unknown templates fail closed in the browser.
- Missing service or malformed browser responses produce readable non-crashing states.
- No stale, malformed, or generated content changes human review status.

## Storage and Lifecycle

Snapshots, presentations, annotations, mappings, in-flight coordination, and reviews are process-local memory only. Restarting the service intentionally clears all of them. Idempotency lasts only for the process lifetime; the external agent may import the snapshot again after restart and receive new packet IDs.

Memory is intentionally unbounded for the short-lived hackathon process. The slice adds no disk persistence, database, TTL, eviction, deletion/reset endpoint, cleanup worker, or storage abstraction. The implementation must run unchanged on Windows and macOS.

## File Ownership and Dependency Direction

The production dependency direction is fixed:

```text
server.py
|-- riff_snapshot.py
|   |-- riff_presenter.py
|   |   `-- adapter.py
|   `-- review.py
`-- static web mount
```

`riff_presenter.py` never imports `riff_snapshot.py`. It receives a validated defensive JSON-ready mapping. Snapshot validation remains owned by `riff_snapshot.py`.

### Backend lane

```text
Chirp/src/chirp/riff_presenter.py
Chirp/src/chirp/riff_snapshot.py
Chirp/src/chirp/review.py
Chirp/tests/test_riff_presenter.py
Chirp/tests/test_riff_snapshot.py
Chirp/tests/test_review.py
Chirp/examples/canvas_reasoning_snapshot.json
```

`riff_presenter.py` owns the versioned prompt, candidate and view models, adapter wrapper, strict parsing, grounding/reference validation, deterministic assembly, and fallback.

`riff_snapshot.py` owns snapshot and matrix models, snapshot service/store, in-flight coordination, idempotency, API router, presenter invocation, atomic publication, stored retrieval, and matrix assembly.

`review.py` remains unaware of Riff snapshot and presentation models and adds only narrow review-store operations.

### Presenter web lane

```text
Chirp/web/presenter.html
Chirp/web/presenter.js
Chirp/web/presenter.css
```

These are exclusive new files. Existing queue files are not edited.

### Integration and documentation lane

```text
Chirp/src/chirp/server.py
Chirp/tests/test_server.py
ARCHITECTURE.md
ROADMAP.md
```

`server.py` only constructs long-lived dependencies, registers routers, and mounts static files. It contains no snapshot, presenter, fallback, or matrix business logic. Architecture documents replace stale geometry-gating descriptions with the approved reasoning-only external-agent loop.

No third models package is introduced.

## Verification Strategy

Automated tests make no network requests and no live LLM calls. They inject a deterministic fake adapter or presenter.

### Presenter tests

`Chirp/tests/test_riff_presenter.py` covers:

- one valid intelligent candidate;
- malformed and Markdown-fenced JSON;
- undeclared fields and unknown templates;
- invalid node, annotation, source-scope, and JSON Pointer references;
- invalid escapes, array indexes, and unresolved values;
- duplicate JSON object keys, non-finite constants, and non-object candidate roots;
- duplicate source references;
- missing and contradictory section definitions;
- mandatory source and human-review sections after post-processing;
- deterministic schema-valid fallback and source-field selection;
- discarded adapter reasoning;
- actual `use_cache=False` call arguments and fresh input dictionaries;
- optional model configuration without API model selection.

### Snapshot and API tests

`Chirp/tests/test_riff_snapshot.py` covers:

- new `201`, idempotent `200`, unknown `404`, conflict `409`, and validation `422`;
- preserved node order;
- missing upstream references and self-references;
- provenance component-ID equality;
- provenance run-ID equality and normalized node/packet role equality;
- stored retrieval without another presenter call;
- defensive-copy behavior;
- exactly one packet mapping per node;
- deterministic concurrent identical imports with one presenter call and one review batch;
- different content using the same completed or in-flight ID returning `409`;
- callback failure before assignment and immediately after provisional assignment;
- no residual snapshot, mapping, or review record after publication failure;
- released waiters after success and failure;
- current decision joins in the Review Matrix;
- `review_complete` with pending and terminal records;
- immutable source reasoning and annotations across repeated exports.

Concurrency tests use `threading.Event`, barriers, or equivalent deterministic synchronization, never sleeps or timing thresholds.

### Existing review tests

`Chirp/tests/test_review.py` adds only all-or-nothing batch creation and defensive batch-read behavior while preserving every existing endpoint and decision test.

### Server tests

`Chirp/tests/test_server.py` verifies:

- `/api/riff/...` routes are registered;
- `/riff/presenter.html`, JavaScript, and CSS are served with appropriate content types;
- existing `/reviews/...` and `/chirp/call` routes remain registered.

Focused tests run first, followed by the complete existing pytest suite. No coverage tool, pass-percentage requirement, Playwright, npm dependency, browser automation, or live-model test is added.

## Hackathon Demonstration

The primary path uses the external main LLM agent:

```text
Main agent inspects canvas through Rook
-> captures actual stable Chirp component-instance IDs
-> collects complete structured ReviewPackets
-> preserves node order and upstream relationships
-> assembles CanvasReasoningSnapshot
-> POSTs /api/riff/snapshots
-> waits for intelligent or fallback presentation
-> opens /riff/presenter.html?snapshot_id={snapshot_id}
```

No automated snapshot producer is implemented. Snapshot assembly is an orchestration step performed with existing tools. After review, the same external agent may consume the matrix and use existing tools to author correction Panels; that action remains outside Riff.

The fallback demonstration submits the checked-in domain-neutral fixture at:

```text
Chirp/examples/canvas_reasoning_snapshot.json
```

The fixture contains at least one planner, one critic, one connection, complete structured packets, and an uncertainty or potential conflict. It is example/test input only and is never runtime configuration or a source of product rules. The Alpine hut and every other specific design scenario are excluded as architectural dependencies.

Manual acceptance:

1. Import the fixture through the external agent, Swagger, or a small cross-platform request.
2. Confirm `presentation_source: intelligent` when a provider is configured.
3. Open the direct presenter URL.
4. Verify visibly different planner and critic presentation within the same snapshot.
5. Verify complete source packets, grounded Riff annotations, fixed review controls, and explicit source labels.
6. Submit different decisions for nodes, manually refresh, and confirm current state.
7. Use **Download Review Matrix JSON** and verify that the newly fetched authoritative response preserves node order, source reasoning, annotations, attribution, comments, and statuses.
8. Confirm source strings containing markup render as literal text.

If only fallback is available, record that the structured workflow passed but do not claim intelligent-presenter acceptance.

## Explicit Non-Goals

This slice does not add:

- Geometry transport, inspection, serialization, snapshots, gating, duplication, or preview
- Grasshopper tree or `IGH_Goo` handling
- Automatic Grasshopper snapshot-producer code
- Rook integration code, filesystem watching, or producer polling
- Canvas edits, correction Panels, wire creation, or component execution
- Automatic correction feedback, resubmission, recursion, or agent loops
- Direct model-generated HTML, JavaScript, CSS, markup, templates, or UI components
- Dynamic template types, arbitrary renderer configuration, or model-selected classes
- Human decisions authored by the presenter
- Multiple comments, drafts, multiple reviewers, decision revision, or consensus
- Review assignment, authentication, authorization, or reviewer identity management
- Database or filesystem persistence
- TTLs, eviction, deletion, reset, cleanup jobs, or storage abstractions
- Snapshot listing, regeneration, dedicated retry endpoints, automatic retry, streaming, WebSockets, event queues, or background processing
- `GET /reviews?status=pending` implementation in this slice
- New Riff service, package rename, or Chirp adapter redesign
- API-selectable models or model names in contracts
- Exposure of prompts, credentials, provider errors, stack traces, private reasoning, or internal model metadata
- npm, frameworks, build tooling, external web assets, Playwright, or new dependencies
- Production deployment, production-scale limits, or Windows/macOS CI in this slice

## Completion Gate

Implementation planning may begin only after human approval of this written specification. The implementation plan must preserve the two-module backend split, exclusive three-file web lane, integration ownership, deterministic fake-based testing, and human checkpoint. Implementation itself requires separate authorization after that plan is approved.
