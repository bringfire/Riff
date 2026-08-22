# Riff Architecture

**Status:** Hackathon prototype contract

**Date:** 2026-08-22

**Companion:** [ROADMAP.md](ROADMAP.md)

## Purpose

Riff is a human-in-the-loop design-reasoning system for Grasshopper. It extends the existing Chirp engine with structured, attributable reasoning that a person can inspect, accept, correct, or reject before downstream design work continues.

For the hackathon, Riff is the product and repository name. `chirp` remains the existing Python package, service, and Grasshopper reasoning engine. Renaming Chirp internals is explicitly deferred.

## Prototype success condition

The prototype is successful when this one path works end to end:

```text
Grasshopper submits a structured review packet
        -> browser displays it as pending
        -> a human accepts, requests correction, or rejects it
        -> Grasshopper retrieves and displays that decision
        -> accepted geometry is allowed through a simple local gate
```

Correction is shown to the user on the Grasshopper canvas. The prototype does not automatically feed correction back into Chirp or create a recursive Grasshopper cycle.

## System boundary

```mermaid
flowchart LR
    GH[Grasshopper + Chirp] -->|POST /reviews| API[Riff review API inside Chirp FastAPI]
    GH -->|GET /reviews/{packet_id}| API
    UI[Light-mode Riff workbench] -->|GET /reviews?status=pending| API
    UI -->|POST /reviews/{packet_id}/decision| API
    API <--> STORE[(Locked in-memory review store)]
    GH --> GATE[Accepted-geometry gate]
```

The HTTP review API is the architectural seam. Browser and Grasshopper work must depend on this contract rather than importing or modifying each other's implementation.

## Components and ownership boundaries

| Component | Location | Responsibility |
|---|---|---|
| Chirp reasoning engine | `Chirp/src/chirp/` excluding review UI files | Existing LLM calls, component generation, tracing |
| Review API and store | `Chirp/src/chirp/review.py` | Packet validation, immutable snapshots, decisions, queue listing |
| API tests | `Chirp/tests/test_review.py` | Observable review behavior and regression coverage |
| Web workbench | `Chirp/web/` | Queue, structured packet inspection, reviewer actions |
| Grasshopper bridge | `GH/` and optional `Chirp/templates/riff_review_client.cs` | Submit packets, poll status, expose accepted/correction outputs |
| Integration wiring | `Chirp/src/chirp/server.py` | Register review routes and serve the web workbench |

Exact temporary ownership for the hackathon is defined in [ROADMAP.md](ROADMAP.md). No agent may edit another lane's files without coordinator approval.

## Review API contract

### Implemented endpoints

```http
POST /reviews
GET /reviews/{packet_id}
POST /reviews/{packet_id}/decision
```

The authoritative request and response models live in `Chirp/src/chirp/review.py`.

### Prototype queue endpoint

The backend lane will add:

```http
GET /reviews?status=pending
```

The optional `status` value is one of:

```text
pending | accepted | correction_requested | rejected
```

An omitted status returns all reviews. Results are returned oldest first as defensive snapshots:

```json
{
  "reviews": [
    {
      "packet_id": "packet-id",
      "created_at": "2026-08-22T22:00:00Z",
      "status": "pending",
      "packet": {},
      "decision": null
    }
  ]
}
```

Invalid status values return FastAPI's standard HTTP `422` response.

### Decision request

```json
{
  "action": "accept",
  "reviewer": "Reviewer name",
  "note": "Optional for acceptance"
}
```

Actions are exactly `accept`, `request_correction`, or `reject`. Correction and rejection require a nonblank note.

## State and trust rules

```text
pending --accept------------> accepted
pending --request_correction--> correction_requested
pending --reject------------> rejected
```

- Every decision is terminal for its immutable packet.
- Only one decision may succeed; later attempts return HTTP `409`.
- The original packet is never modified.
- Only accepted work may release downstream geometry.
- Role, contributor, component, run, and parent-packet provenance remain visible.
- Invalid, undeclared, and non-JSON-compatible values are rejected.
- The in-memory store is protected by one lock and intentionally disappears on restart.

## Web integration rules

- The workbench is plain HTML, CSS, and JavaScript under `Chirp/web/`.
- FastAPI serves it at `/riff/` from the same origin as the API.
- API requests use relative URLs; CORS is therefore unnecessary.
- The queue polls every two seconds. WebSockets are deferred.
- `?mock=1` uses a checked-in mock response for independent development and demo fallback.
- The prototype UI uses light mode and the approved full-workbench layout.

## Grasshopper integration rules

- The demo service URL is `http://127.0.0.1:9900`, exposed as a component input.
- A Boolean trigger submits one packet; manual refresh or a Grasshopper Timer polls it.
- Outputs include review ID, status, accepted state, correction note, and approved geometry.
- Geometry remains in Grasshopper and is not serialized through the API.
- Correction is displayed but is not automatically wired back into Chirp during the prototype.

## Platform and implementation constraints

- The repository and Python service must run on Windows and macOS.
- Do not introduce OS-specific paths into tracked files.
- Use the existing FastAPI, Pydantic, and pytest stack.
- The workbench has no npm, framework, build step, or external-asset requirement.
- Do not add dependencies unless the coordinator explicitly approves them.

## Explicit non-goals for the prototype

- Database persistence
- Authentication or reviewer identity management
- WebSockets
- Multiple-reviewer consensus
- Objective functions or recursive agent loops
- Revision-chain automation
- Geometry serialization
- Production deployment
- Internal Chirp-to-Riff package renaming
- Elaborate visual styling beyond a coherent light-mode workbench

These are roadmap candidates, not prototype blockers.
