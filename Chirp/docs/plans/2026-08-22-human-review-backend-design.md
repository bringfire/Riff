# Chirp — Minimal Human-Review Backend Design

**Date:** 2026-08-22

**Status:** Approved for implementation planning

**Scope:** One in-memory review round trip inside the existing Chirp FastAPI service

## Goal

Add one human approval gate to Chirp:

```text
Submit packet -> Pending review -> Human decides -> Retrieve final state
```

The implementation stays inside the existing FastAPI application. Both Grasshopper and a future web interface may poll the same `GET` endpoint, but neither client is part of this slice.

## API Contract

### Submit a packet

`POST /reviews`

The request body contains exactly these fields:

```json
{
  "stage": "envelope_review",
  "role": "Climate Expert",
  "contributor": "agent-or-person-name",
  "proposal": "Use 300 mm of wall insulation.",
  "inputs": [
    "Four-person overnight alpine hut",
    "Swiss Alps winter conditions"
  ],
  "assumptions": [
    "The 300 mm target refers to insulation, not total wall depth."
  ],
  "parameters": [
    {
      "name": "wall_insulation",
      "value": 300,
      "unit": "mm",
      "source": "human_target"
    }
  ],
  "rationale": "A concise, human-readable explanation.",
  "uncertainties": [],
  "payload": {
    "wall_insulation_mm": 300
  },
  "provenance": {
    "run_id": "example-run",
    "component_id": "example-component",
    "parent_packet_ids": []
  }
}
```

The server generates a UUID4 `packet_id`, a timezone-aware UTC `created_at` timestamp, and the initial `pending` status using the Python standard library. It returns HTTP `201`:

```json
{
  "packet_id": "5e88dce5-90d6-489e-b27b-a94eb7e2249f",
  "created_at": "2026-08-22T14:30:00+00:00",
  "status": "pending",
  "packet": {
    "stage": "envelope_review",
    "role": "Climate Expert",
    "contributor": "agent-or-person-name",
    "proposal": "Use 300 mm of wall insulation.",
    "inputs": [
      "Four-person overnight alpine hut",
      "Swiss Alps winter conditions"
    ],
    "assumptions": [
      "The 300 mm target refers to insulation, not total wall depth."
    ],
    "parameters": [
      {
        "name": "wall_insulation",
        "value": 300,
        "unit": "mm",
        "source": "human_target"
      }
    ],
    "rationale": "A concise, human-readable explanation.",
    "uncertainties": [],
    "payload": {
      "wall_insulation_mm": 300
    },
    "provenance": {
      "run_id": "example-run",
      "component_id": "example-component",
      "parent_packet_ids": []
    }
  },
  "decision": null
}
```

### Retrieve a packet

`GET /reviews/{packet_id}`

The response is HTTP `200` with the same envelope returned at creation. It contains the original immutable `packet`, current `status`, and either `null` or the single recorded `decision`.

A valid request for an unknown ID returns HTTP `404`:

```json
{
  "detail": "Review packet not found"
}
```

### Decide a packet

`POST /reviews/{packet_id}/decision`

The request body is:

```json
{
  "action": "accept",
  "reviewer": "reviewer-name",
  "note": "Optional when accepting"
}
```

`action` must be exactly `accept`, `request_correction`, or `reject`. The server assigns a timezone-aware UTC `decided_at` timestamp. The response is HTTP `200` with the complete updated review envelope:

```json
{
  "packet_id": "5e88dce5-90d6-489e-b27b-a94eb7e2249f",
  "created_at": "2026-08-22T14:30:00+00:00",
  "status": "accepted",
  "packet": {
    "stage": "envelope_review",
    "role": "Climate Expert",
    "contributor": "agent-or-person-name",
    "proposal": "Use 300 mm of wall insulation.",
    "inputs": [
      "Four-person overnight alpine hut",
      "Swiss Alps winter conditions"
    ],
    "assumptions": [
      "The 300 mm target refers to insulation, not total wall depth."
    ],
    "parameters": [
      {
        "name": "wall_insulation",
        "value": 300,
        "unit": "mm",
        "source": "human_target"
      }
    ],
    "rationale": "A concise, human-readable explanation.",
    "uncertainties": [],
    "payload": {
      "wall_insulation_mm": 300
    },
    "provenance": {
      "run_id": "example-run",
      "component_id": "example-component",
      "parent_packet_ids": []
    }
  },
  "decision": {
    "action": "accept",
    "reviewer": "reviewer-name",
    "note": "Optional when accepting",
    "decided_at": "2026-08-22T14:35:00+00:00"
  }
}
```

A valid decision for an unknown ID returns HTTP `404`. A valid second decision for an already-decided packet returns HTTP `409`:

```json
{
  "detail": "Review packet already decided"
}
```

## State Transitions

```text
pending --accept------------> accepted
pending --request_correction> correction_requested
pending --reject------------> rejected
```

All three resulting states are terminal for the current immutable packet. In particular, `request_correction` does not mutate or reopen the packet. Creating and linking a replacement packet is future work. Any decision attempted after a terminal state returns HTTP `409`.

## Validation Rules

- Pydantic models define the packet, nested parameter, provenance, and decision request shapes.
- Every field shown in the packet contract is required. List fields may be empty.
- `payload` must be a JSON object. A parameter `value` may be any JSON-compatible value.
- Every request model, including nested models, forbids undeclared fields. Violations use FastAPI's standard HTTP `422` validation response.
- `reviewer` is required. No reviewer identity, trimming, or authentication rules are added.
- `note` is optional for `accept`.
- `request_correction` and `reject` require a note containing at least one non-whitespace character. This is the only cross-field business validation.
- Invalid actions, missing required fields, wrong field types, extra fields, and invalid notes use FastAPI's standard HTTP `422` response.
- FastAPI validates typed request bodies before endpoint code performs a packet lookup. Therefore malformed bodies return `422`; valid requests can then return `404` or `409` based on stored state.

## Concurrency and Snapshot Rules

- Review state is a process-local dictionary in `Chirp/src/chirp/review.py`. Restarting the service intentionally clears it.
- One `threading.Lock` protects every dictionary lookup and read.
- The same lock protects the complete decision lookup, pending-state check, timestamp creation, and write as one transaction. Two concurrent decisions cannot both succeed.
- The accepted request packet is converted to a plain data snapshot and deep-copied when stored.
- Reads and endpoint responses receive deep copies created while the lock is held. Mutable references from the store are never exposed.
- Recording a decision changes only the record's status and decision fields. The stored original packet is never modified.
- IDs and timestamps use `uuid`, `datetime`, and `timezone` from the Python standard library. No dependency is added.

## Acceptance Tests

Tests cover only these six observable behavior areas:

1. Creating a valid packet returns HTTP `201` with a generated ID, creation timestamp, `pending` status, the submitted packet, and no decision.
2. Retrieving the created packet returns HTTP `200` and the same submitted content.
3. Accepting the packet returns HTTP `200`; subsequent retrieval reports `accepted` and the recorded decision while the packet remains unchanged.
4. `request_correction` and `reject` each return HTTP `422` when the note is missing or blank. This behavior may be covered with parameterized cases.
5. A second valid decision for the same packet returns HTTP `409`.
6. A valid retrieval or decision request for an unknown packet ID returns HTTP `404`. Cases may be parameterized.

Tests do not assert storage or lock internals, exact UUID or timestamp formatting, or the internal structure of FastAPI's validation error beyond HTTP `422`.

## Files Expected to Change During Implementation

```text
Chirp/src/chirp/review.py
Chirp/src/chirp/server.py
Chirp/tests/test_review.py
```

No package is renamed or reorganized.

## Explicit Non-Goals

This slice does not add:

- A web interface
- Styling or light-mode implementation
- A separate Riff service
- A database or persistence across restarts
- Authentication or reviewer identity management
- WebSockets
- Grasshopper component changes
- LLM calls
- Geometry serialization
- Agent consensus or recursion
- Revision or replacement-packet chains
- Event queues or background workers
- New dependencies
- Plugin or package renaming
- Abstractions for future databases, WebSockets, Grasshopper, or revision chains
