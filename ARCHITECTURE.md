# Riff Architecture

**Status:** Hackathon prototype contract

Riff is the product; `chirp` remains the existing Python package and reasoning engine. Riff reviews Chirp's structured reasoning. It does not transport, understand, or gate geometry.

## Prototype success path

```text
External main agent submits an immutable reasoning snapshot
-> Riff produces an intelligent or deterministic trusted presentation
-> a human accepts, requests correction, or rejects each node
-> Riff exports current decisions with immutable reasoning and annotations
-> the external main agent continues, revises, or stops the reasoning path
```

The external main agent assembles `CanvasReasoningSnapshot` from the current Grasshopper/Chirp state. Stable `node_id` values come from component-instance identity. Riff never mutates the canvas and does not automate a correction loop.

## System boundary

```mermaid
flowchart LR
    AGENT[External main agent] -->|POST /api/riff/snapshots| API[Riff snapshot API in Chirp FastAPI]
    API --> PRESENTER[Riff presenter]
    PRESENTER --> STORE[(Process-local completed snapshot store)]
    UI[Trusted presenter] -->|GET snapshot + matrix| API
    UI -->|POST /reviews/{packet_id}/decision| REV[Review API]
    REV <--> RSTORE[(Locked in-memory review store)]
    API -->|Review Matrix| AGENT
```

The reasoning snapshot API, per-packet decision API, and Review Matrix are the stable seams. The browser and external agent use HTTP; no UI behavior is imported into the backend.

## Implemented API

```http
POST /api/riff/snapshots
GET  /api/riff/snapshots/{snapshot_id}
GET  /api/riff/snapshots/{snapshot_id}/matrix

POST /reviews
GET  /reviews/{packet_id}
POST /reviews/{packet_id}/decision
```

Snapshot import is synchronous. A new valid snapshot returns `201`; an identical process-lifetime repeat returns `200`; different content under the same `snapshot_id` returns `409`. Validation errors return `422`. Import publishes the immutable snapshot, presentation, and one pending review per node atomically.

Stored snapshot retrieval never invokes the presenter. Matrix export joins current review state on demand and never mutates or regenerates stored content. `GET /reviews?status=pending` is not part of this slice.

## Contracts and ownership

| Concern | Location | Responsibility |
|---|---|---|
| Chirp reasoning packet and human decisions | `Chirp/src/chirp/review.py` | Strict packets, one terminal decision, locked review records, narrow batch transaction |
| Riff presentation | `Chirp/src/chirp/riff_presenter.py` | Versioned prompt, strict grounded candidate, trusted view normalization, deterministic fallback |
| Snapshot lifecycle and matrix | `Chirp/src/chirp/riff_snapshot.py` | Snapshot validation, idempotency, concurrency, atomic publication, live matrix join |
| HTTP/static integration | `Chirp/src/chirp/server.py` | Long-lived dependencies, routers, `/riff/` mount only |
| Presenter application | `Chirp/web/presenter.*` | Trusted template dispatch, safe DOM rendering, fixed human controls, matrix download |

`ReviewPacket` remains immutable source reasoning. Riff annotations are immutable advisory interpretations with grounded source references. Human decisions are the only values that change review status. The reference-only `ReviewViewModel` contains no copied reasoning, decisions, packet IDs, styles, markup, or executable behavior.

## Presenter behavior

The intelligent path receives the complete validated snapshot and may select, order, group, emphasize, and annotate only these trusted templates:

```text
run_summary
node_reasoning
proposal_details
conflicts_uncertainties
provenance
human_review
```

The server guarantees one run summary, complete source reasoning and human-review access for every node, valid node/annotation references, and RFC 6901 grounding. Invalid model output produces a deterministic role-aware fallback with no Riff annotations. Model failures and private reasoning never enter API responses.

The static presenter is directly addressable at:

```text
/riff/presenter.html?snapshot_id={snapshot_id}
```

It uses root-relative same-origin requests, fixed checked-in styling, safe DOM APIs, current matrix state after reload, and verbatim matrix download. `/riff/?mock=1` remains the older queue-workbench fallback; it is not the new snapshot architecture.

## State and concurrency

Snapshots, presentations, mappings, and reviews are process-local and disappear on restart. Concurrent identical imports coordinate through an in-flight record and invoke the presenter and review batch once. Conflicting content returns `409`. The fixed lock order is snapshot lock, then review lock; neither is held during an LLM call. Publication failure removes both snapshot and review residue and releases waiters.

## Explicit non-goals

- Geometry transport, gating, duplication, or canvas-object serialization
- An automated Grasshopper snapshot producer or correction loop
- `GET /reviews?status=pending`
- Database or disk persistence, TTLs, cleanup workers, or storage abstractions
- Authentication, multiple reviewers, decision revision, or consensus
- WebSockets, background presentation, retries, regeneration, or streaming
- CORS, npm, external UI assets, or browser automation
- Internal Chirp-to-Riff package renaming

These remain future work, not prototype requirements.
