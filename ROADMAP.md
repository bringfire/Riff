# Riff Hackathon Roadmap

## Current slice

The hackathon slice proves a reasoning-review round trip without geometry handling or product-wide automation:

```text
external main agent captures Chirp reasoning
-> imports one immutable CanvasReasoningSnapshot
-> Riff presents grounded intelligent analysis or deterministic fallback
-> a human decides each node
-> Review Matrix exports reasoning, Riff annotations, and current decisions
```

Implementation remains inside the existing Chirp FastAPI service and uses process-local memory, synchronous presentation, HTTP, and plain checked-in web assets.

## Definition of done

1. Start Chirp with `python -m chirp`.
2. Import `Chirp/examples/canvas_reasoning_snapshot.json` through `/docs` or a direct request.
3. Receive a completed presentation and one pending review mapping per node.
4. Open `/riff/presenter.html?snapshot_id=demo-snapshot-001`.
5. Inspect complete planner and critic source packets and clearly separated Riff annotations.
6. Accept one node and request correction or reject another through fixed controls.
7. Refresh and confirm reviewer attribution, notes, and terminal status persist.
8. Download the Review Matrix and confirm node order, immutable reasoning, Riff annotations, mappings, and current decisions.
9. Run the focused and complete Python suites without regressions on Windows and macOS.

## Implemented lanes

| Lane | Files | Result |
|---|---|---|
| Review store | `Chirp/src/chirp/review.py`, `Chirp/tests/test_review.py` | Existing decisions plus atomic ordered batch create/read |
| Intelligent presenter | `Chirp/src/chirp/riff_presenter.py`, `Chirp/tests/test_riff_presenter.py` | Strict grounded model result and deterministic fallback |
| Snapshot API | `Chirp/src/chirp/riff_snapshot.py`, `Chirp/tests/test_riff_snapshot.py` | Import idempotency, concurrency, rollback, retrieval, Review Matrix |
| Presenter web lane | `Chirp/web/presenter.html`, `presenter.js`, `presenter.css` | Trusted six-template rendering, fixed controls, refresh and download |
| Integration | `Chirp/src/chirp/server.py`, `Chirp/tests/test_server.py` | `/api/riff/...`, `/reviews/...`, and `/riff/` remain reachable |
| Demo input | `Chirp/examples/canvas_reasoning_snapshot.json` | Domain-neutral planner/critic fixture with literal-markup safety string |

The external main agent is the primary snapshot producer and later correction author. Swagger or a direct cross-platform request is the known-good fallback. No new Grasshopper component or Rook integration code is built in this slice.

## Demo flow

```text
POST /api/riff/snapshots
GET  /api/riff/snapshots/{snapshot_id}
GET  /api/riff/snapshots/{snapshot_id}/matrix
POST /reviews/{packet_id}/decision
```

When a provider is configured, record `presentation_source: intelligent` and demonstrate grounded annotations. Otherwise, record `presentation_source: fallback`; the structured review workflow still passes, but intelligent-presenter acceptance must not be claimed.

The existing `/riff/?mock=1` queue workbench remains a fallback artifact. A live pending-review queue endpoint is intentionally excluded.

## Deferred work

### Next

- Automated capture of current Grasshopper/Chirp reasoning snapshots
- External-agent consumption of Review Matrix corrections
- Persistence and audit history
- Revision/replacement packet relationships
- Windows/macOS CI and packaging of web assets

### Later

- Authentication and reviewer permissions
- Multiple reviewers, policy, or consensus
- Background/streaming presentation and explicit regeneration
- Multi-user synchronization and WebSockets
- Deliberate Chirp-to-Riff internal naming migration

Geometry transport or gating, automatic canvas mutation, recursion, a database, a storage abstraction, a pending-review queue endpoint, and scenario-specific product rules must not enter this slice.
