<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="Riff%20logo%20dark.png">
  <img alt="Riff" src="Riff%20logo.png" width="200">
</picture>

# Riff

**Human review for AI design reasoning.**

AEC Tech Hackathon 2026 · Boston

</div>

---

Grasshopper components powered by an LLM can produce a design in seconds. They cannot tell you whether you should trust it.

Riff is the layer that makes AI design decisions reviewable. Chirp components state *why* they produced a result; Riff collects that reasoning, presents it to a person, and records what the person decided. The decisions come back as structured data the agent can act on.

Riff reviews reasoning. It never touches geometry.

## The loop

```text
External agent captures Chirp reasoning from the canvas
  -> imports one immutable CanvasReasoningSnapshot
  -> Riff presents grounded analysis (or a deterministic fallback)
  -> a human accepts, requests correction, or rejects each node
  -> Review Matrix exports reasoning, annotations, and decisions
  -> the agent continues, revises, or stops
```

The reviewer opens a web link. No Rhino, no licence, no install.

## Why it matters

Optimizers search for the best answer to a question you can score. Most real design questions cannot be scored — they involve neighbours, code interpretation, and judgement calls where reasonable people disagree.

Riff does not try to resolve those. It surfaces the reasoning, puts a person in the loop, and keeps the receipts. The audit trail is as much the deliverable as the geometry.

## Quick start

Requires **Python 3.10+**.

```bash
cd Chirp
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
CHIRP_PORT=9900 python -m chirp
```

Import the demo snapshot:

```bash
curl -X POST http://127.0.0.1:9900/api/riff/snapshots \
  -H "Content-Type: application/json" \
  -d @Chirp/examples/canvas_reasoning_snapshot.json
```

Then open the presenter:

```text
http://127.0.0.1:9900/riff/presenter.html?snapshot_id=demo-snapshot-001
```

Review each node, then download the Review Matrix to see reasoning, Riff annotations, and current decisions in one document.

Without `CHIRP_PORT`, the service binds an OS-assigned port and writes a discovery file to `$TMPDIR/rook/chirp-service-{port}.json`.

## API

```http
POST /api/riff/snapshots                      import a snapshot
GET  /api/riff/snapshots/{snapshot_id}        stored snapshot + presentation
GET  /api/riff/snapshots/{snapshot_id}/matrix Review Matrix

POST /reviews                                 create a review packet
GET  /reviews/{packet_id}                     read one packet
POST /reviews/{packet_id}/decision            accept / request_correction / reject
```

Import is synchronous and idempotent: a new snapshot returns `201`, an identical repeat returns `200`, conflicting content under the same ID returns `409`, validation failures return `422`. Publication is atomic — snapshot, presentation, and one pending review per node land together or not at all.

## How the presenter works

The intelligent path receives the validated snapshot and may select, order, group, emphasise, and annotate — but only through six trusted templates:

```text
run_summary   node_reasoning   proposal_details
conflicts_uncertainties   provenance   human_review
```

The server guarantees one run summary, complete source reasoning and review access for every node, and RFC 6901 grounding for every annotation. Invalid model output falls back to a deterministic role-aware view with no annotations. Model failures never reach API responses.

Source reasoning is immutable. Riff annotations are advisory and always visually separated from it. Human decisions are the only values that change review status, and each decision is terminal.

## Repository

| Path | Contents |
|---|---|
| `Chirp/` | The service — adapter, review store, presenter, snapshot API, web assets |
| `Chirp/src/chirp/` | `review.py`, `riff_presenter.py`, `riff_snapshot.py`, `server.py`, `adapter.py`, `rook_tool.py` |
| `Chirp/web/` | Presenter app and the earlier queue workbench |
| `Chirp/examples/` | `canvas_reasoning_snapshot.json` — the demo fixture |
| `GIS files_Land use Zoning/` | Detroit study area: 136 parcels, 273 acres, zoning and land use |
| `Design workflow/`, `Design workflow_R1/` | Workflow design canvases |
| `Approved Design Mockup/` | Workbench UI mockup |
| `00_Ref/` | Reference Rhino/Grasshopper files and a particle-swarm optimiser notebook |
| `ARCHITECTURE.md` | System boundary, contracts, concurrency model |
| `ROADMAP.md` | Current slice, definition of done, deferred work |

## Test site

The demo scenario uses **plot 14316** from `StudyArea_Zoning.gpkg` — the median B4 General Business parcel in the Detroit study area. 2,736 m², 79.2 m east–west by 39.6 m north–south, street along the south edge, two-family houses backing onto the north edge. Every figure is read from the GeoPackage, so the site is verifiable rather than invented.

Note that FAR, height, coverage, and setback standards are **not** in the GIS data. Those come from the Detroit Zoning Ordinance and must be sourced separately.

## Status

This is a hackathon prototype. It proves one round trip end to end.

**Built:** review store with terminal decisions and atomic batches · intelligent presenter with grounded output and deterministic fallback · snapshot import with idempotency, concurrency handling, and rollback · Review Matrix export · presenter web app · 131 Python tests.

**Deliberately out of scope for this slice:** geometry transport or gating · automated Grasshopper snapshot capture · a pending-review queue endpoint · database persistence · authentication and multiple reviewers · WebSockets and streaming.

State is process-local and disappears on restart. See [ROADMAP.md](ROADMAP.md) for what comes next.
