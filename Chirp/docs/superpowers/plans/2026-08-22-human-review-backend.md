# Chirp Minimal Human-Review Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task with the human-review checkpoint retained. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one immutable, in-memory human-review round trip to the existing Chirp FastAPI service.

**Architecture:** `chirp.review` owns strict Pydantic v2 request and response models, one process-local dictionary, one `threading.Lock`, defensive snapshots, and an `APIRouter` containing the three review endpoints. `chirp.server` includes that router in the existing FastAPI application, and API tests cover only the six approved observable behavior areas.

**Tech Stack:** Python >=3.10, Python standard library, FastAPI, Pydantic v2 (`ConfigDict`, `model_validator`, `JsonValue`), pytest, FastAPI `TestClient`.

**Spec:** `Chirp/docs/plans/2026-08-22-human-review-backend-design.md`

## Global Constraints

- Modify only `Chirp/src/chirp/review.py`, `Chirp/src/chirp/server.py`, and `Chirp/tests/test_review.py` during implementation.
- Run every command from the activated environment with `Chirp` as the working directory. The code, tests, and commands must run unchanged on Windows and macOS; do not use platform-specific interpreter paths or shell syntax.
- Add no dependencies and no abstractions for future databases, WebSockets, Grasshopper, or revision chains.
- Treat `accepted`, `correction_requested`, and `rejected` as terminal states for the current immutable packet. In particular, `request_correction` never mutates, reopens, or creates a replacement packet.
- Forbid undeclared fields on every request model, including nested parameter and provenance models, using `ConfigDict(extra="forbid")` so FastAPI returns its standard HTTP `422` response.
- Deep-copy plain packet data when storing it and deep-copy the complete record before every response. Never expose a mutable store reference.
- Use exactly one module-level `threading.Lock`; hold it for every dictionary lookup/read and for the complete decision lookup, terminal-state check, timestamp creation, write, and response-snapshot transaction.
- Keep decision parameters typed as `DecisionRequest`; FastAPI must validate malformed request bodies before the endpoint performs packet lookup, so invalid bodies return `422` even for unknown IDs.
- Use UUID4 IDs and timezone-aware UTC timestamps from the Python standard library. State intentionally disappears on process restart.
- Do not add reset hooks. Tests must assert only observable HTTP behavior, not lock/store internals or exact UUID/timestamp formats.
- There are exactly six behavior areas and six test functions. Parameterization in two functions intentionally produces ten collected pytest cases.
- Do not commit or push implementation until the reviewer approves the completed slice.

## File Responsibilities and Interfaces

- `Chirp/src/chirp/review.py`: Create strict request/response models; define `create_review(packet: ReviewPacket) -> ReviewResponse`, `get_review(packet_id: str) -> ReviewResponse`, and `decide_review(packet_id: str, decision: DecisionRequest) -> ReviewResponse`; own the single locked in-memory store; expose `router: APIRouter`.
- `Chirp/src/chirp/server.py`: Import `router` as `review_router` and call `app.include_router(review_router)` once immediately after creating the existing `FastAPI` application.
- `Chirp/tests/test_review.py`: Create one valid-packet fixture, one `TestClient(app)`, and exactly the six named behavior-test functions specified below.

---

## 1. Add the six failing API behavior tests

**Files:**

- Create: `Chirp/tests/test_review.py`

**Interfaces:**

- Consumes: Existing `chirp.server.app: FastAPI`.
- Produces: Six test functions defining the observable contract. Two are parameterized, so pytest collects ten cases.

- [ ] **Action 1 (2–5 minutes): Create the valid packet fixture and TestClient.**

  Create `Chirp/tests/test_review.py` with these imports, client, and fixture:

  ```python
  """Observable API tests for the in-memory human-review round trip."""

  import pytest
  from fastapi.testclient import TestClient

  from chirp.server import app


  client = TestClient(app)


  @pytest.fixture
  def valid_packet() -> dict[str, object]:
      return {
          "stage": "envelope_review",
          "role": "Climate Expert",
          "contributor": "agent-or-person-name",
          "proposal": "Use 300 mm of wall insulation.",
          "inputs": [
              "Four-person overnight alpine hut",
              "Swiss Alps winter conditions",
          ],
          "assumptions": [
              "The 300 mm target refers to insulation, not total wall depth."
          ],
          "parameters": [
              {
                  "name": "wall_insulation",
                  "value": 300,
                  "unit": "mm",
                  "source": "human_target",
              }
          ],
          "rationale": "A concise, human-readable explanation.",
          "uncertainties": [],
          "payload": {"wall_insulation_mm": 300},
          "provenance": {
              "run_id": "example-run",
              "component_id": "example-component",
              "parent_packet_ids": [],
          },
      }
  ```

- [ ] **Action 2 (2–5 minutes): Add the creation, retrieval, and acceptance test functions.**

  Append these three tests exactly:

  ```python
  def test_create_review_returns_201_pending(valid_packet: dict[str, object]):
      response = client.post("/reviews", json=valid_packet)

      assert response.status_code == 201
      body = response.json()
      assert body["packet_id"]
      assert body["created_at"]
      assert body["status"] == "pending"
      assert body["packet"] == valid_packet
      assert body["decision"] is None


  def test_get_review_returns_submitted_packet(valid_packet: dict[str, object]):
      create_response = client.post("/reviews", json=valid_packet)
      packet_id = create_response.json()["packet_id"]

      response = client.get(f"/reviews/{packet_id}")

      assert response.status_code == 200
      body = response.json()
      assert body["packet_id"] == packet_id
      assert body["status"] == "pending"
      assert body["packet"] == valid_packet
      assert body["decision"] is None


  def test_accept_review_reports_accepted_without_mutating_packet(
      valid_packet: dict[str, object],
  ):
      create_response = client.post("/reviews", json=valid_packet)
      packet_id = create_response.json()["packet_id"]

      decision_response = client.post(
          f"/reviews/{packet_id}/decision",
          json={"action": "accept", "reviewer": "reviewer-name"},
      )
      get_response = client.get(f"/reviews/{packet_id}")

      assert decision_response.status_code == 200
      assert get_response.status_code == 200
      body = get_response.json()
      assert body["status"] == "accepted"
      assert body["packet"] == valid_packet
      assert body["decision"]["action"] == "accept"
      assert body["decision"]["reviewer"] == "reviewer-name"
      assert body["decision"]["note"] is None
      assert body["decision"]["decided_at"]
  ```

- [ ] **Action 3 (2–5 minutes): Add the validation, conflict, and not-found test functions.**

  Append these three tests exactly:

  ```python
  @pytest.mark.parametrize(
      "decision_body",
      [
          {"action": "request_correction", "reviewer": "reviewer-name"},
          {
              "action": "request_correction",
              "reviewer": "reviewer-name",
              "note": "   ",
          },
          {"action": "reject", "reviewer": "reviewer-name"},
          {"action": "reject", "reviewer": "reviewer-name", "note": "\t"},
      ],
  )
  def test_correction_and_rejection_require_note(decision_body: dict[str, object]):
      response = client.post(
          "/reviews/unknown-packet/decision",
          json=decision_body,
      )

      assert response.status_code == 422


  def test_second_decision_returns_409(valid_packet: dict[str, object]):
      create_response = client.post("/reviews", json=valid_packet)
      packet_id = create_response.json()["packet_id"]
      first_response = client.post(
          f"/reviews/{packet_id}/decision",
          json={"action": "accept", "reviewer": "first-reviewer"},
      )

      second_response = client.post(
          f"/reviews/{packet_id}/decision",
          json={
              "action": "request_correction",
              "reviewer": "second-reviewer",
              "note": "Change the insulation target.",
          },
      )

      assert first_response.status_code == 200
      assert second_response.status_code == 409
      assert second_response.json() == {"detail": "Review packet already decided"}


  @pytest.mark.parametrize("operation", ["get", "decision"])
  def test_unknown_packet_returns_404(operation: str):
      if operation == "get":
          response = client.get("/reviews/unknown-packet")
      else:
          response = client.post(
              "/reviews/unknown-packet/decision",
              json={"action": "accept", "reviewer": "reviewer-name"},
          )

      assert response.status_code == 404
      assert response.json() == {"detail": "Review packet not found"}
  ```

- [ ] **Action 4 (2–5 minutes): Run the focused suite and verify RED.**

  From the activated environment inside `Chirp`, run:

  ```text
  python -m pytest tests/test_review.py -v
  ```

  Expected RED result: nonzero exit code; ten cases are collected and fail with route-related `404` responses or dependent assertions because no review router has been added. Do not weaken assertions to make this run pass.

## 2. Add the minimum review models, locked in-memory store, and three endpoints

**Files:**

- Create: `Chirp/src/chirp/review.py`
- Modify: `Chirp/src/chirp/server.py`

**Interfaces:**

- Consumes: JSON-compatible packet and decision request bodies from FastAPI.
- Produces: `router: APIRouter`; `create_review(packet: ReviewPacket) -> ReviewResponse`; `get_review(packet_id: str) -> ReviewResponse`; `decide_review(packet_id: str, decision: DecisionRequest) -> ReviewResponse`.
- HTTP mapping: `POST /reviews` returns `201`; `GET /reviews/{packet_id}` returns `200` or `404`; `POST /reviews/{packet_id}/decision` returns `200`, `404`, `409`, or FastAPI's pre-lookup `422` validation response.

- [ ] **Action 1 (2–5 minutes): Create strict packet, decision, and response models.**

  Create `Chirp/src/chirp/review.py` with the following complete module. The four request-body model levels (`ReviewParameter`, `ReviewProvenance`, `ReviewPacket`, and `DecisionRequest`) each explicitly forbid undeclared fields. The `model_validator` raises `ValueError`, allowing Pydantic/FastAPI to produce the standard `422` response.

  ```python
  """In-memory human-review API for immutable Chirp packets."""

  from __future__ import annotations

  from copy import deepcopy
  from datetime import datetime, timezone
  from threading import Lock
  from typing import Literal
  from uuid import uuid4

  from fastapi import APIRouter, HTTPException, status
  from pydantic import BaseModel, ConfigDict, JsonValue, model_validator


  DecisionAction = Literal["accept", "request_correction", "reject"]
  ReviewStatus = Literal[
      "pending",
      "accepted",
      "correction_requested",
      "rejected",
  ]


  class ReviewParameter(BaseModel):
      model_config = ConfigDict(extra="forbid")

      name: str
      value: JsonValue
      unit: str
      source: str


  class ReviewProvenance(BaseModel):
      model_config = ConfigDict(extra="forbid")

      run_id: str
      component_id: str
      parent_packet_ids: list[str]


  class ReviewPacket(BaseModel):
      model_config = ConfigDict(extra="forbid")

      stage: str
      role: str
      contributor: str
      proposal: str
      inputs: list[str]
      assumptions: list[str]
      parameters: list[ReviewParameter]
      rationale: str
      uncertainties: list[str]
      payload: dict[str, JsonValue]
      provenance: ReviewProvenance


  class DecisionRequest(BaseModel):
      model_config = ConfigDict(extra="forbid")

      action: DecisionAction
      reviewer: str
      note: str | None = None

      @model_validator(mode="after")
      def require_note_for_correction_or_rejection(self) -> DecisionRequest:
          needs_note = self.action in {"request_correction", "reject"}
          if needs_note and (self.note is None or not self.note.strip()):
              raise ValueError(
                  "note is required for request_correction and reject"
              )
          return self


  class DecisionRecord(BaseModel):
      action: DecisionAction
      reviewer: str
      note: str | None
      decided_at: datetime


  class ReviewResponse(BaseModel):
      packet_id: str
      created_at: datetime
      status: ReviewStatus
      packet: ReviewPacket
      decision: DecisionRecord | None


  _STATUS_BY_ACTION: dict[DecisionAction, ReviewStatus] = {
      "accept": "accepted",
      "request_correction": "correction_requested",
      "reject": "rejected",
  }
  _reviews: dict[str, dict[str, object]] = {}
  _review_lock = Lock()


  def _snapshot(record: dict[str, object]) -> ReviewResponse:
      """Return a validated deep copy; callers must already hold the lock."""
      return ReviewResponse.model_validate(deepcopy(record))


  router = APIRouter()


  @router.post(
      "/reviews",
      response_model=ReviewResponse,
      status_code=status.HTTP_201_CREATED,
  )
  def create_review(packet: ReviewPacket) -> ReviewResponse:
      packet_id = str(uuid4())
      record: dict[str, object] = {
          "packet_id": packet_id,
          "created_at": datetime.now(timezone.utc),
          "status": "pending",
          "packet": deepcopy(packet.model_dump(mode="python")),
          "decision": None,
      }
      with _review_lock:
          _reviews[packet_id] = deepcopy(record)
          return _snapshot(_reviews[packet_id])


  @router.get("/reviews/{packet_id}", response_model=ReviewResponse)
  def get_review(packet_id: str) -> ReviewResponse:
      with _review_lock:
          record = _reviews.get(packet_id)
          if record is None:
              raise HTTPException(
                  status_code=status.HTTP_404_NOT_FOUND,
                  detail="Review packet not found",
              )
          return _snapshot(record)


  @router.post(
      "/reviews/{packet_id}/decision",
      response_model=ReviewResponse,
  )
  def decide_review(
      packet_id: str,
      decision: DecisionRequest,
  ) -> ReviewResponse:
      with _review_lock:
          record = _reviews.get(packet_id)
          if record is None:
              raise HTTPException(
                  status_code=status.HTTP_404_NOT_FOUND,
                  detail="Review packet not found",
              )
          if record["status"] != "pending":
              raise HTTPException(
                  status_code=status.HTTP_409_CONFLICT,
                  detail="Review packet already decided",
              )

          record["status"] = _STATUS_BY_ACTION[decision.action]
          decision_snapshot = deepcopy(decision.model_dump(mode="python"))
          decision_snapshot["decided_at"] = datetime.now(timezone.utc)
          record["decision"] = decision_snapshot
          return _snapshot(record)
  ```

- [ ] **Action 2 (2–5 minutes): Verify the lock and snapshot boundaries in the completed module.**

  Read the module once and confirm all of these exact invariants before wiring it into the app:

  - `_review_lock = Lock()` is the only lock.
  - Every `_reviews.get(...)`, `_reviews[...]` read, and `_reviews[...] = ...` write occurs within `with _review_lock:`.
  - `decide_review` holds that same lock continuously from lookup through status check, UTC timestamp assignment, record write, and `_snapshot` return.
  - `create_review` stores `deepcopy(record)`, every packet starts from `deepcopy(packet.model_dump(...))`, and `_snapshot` deep-copies the full record.
  - `request_correction` maps to terminal status `correction_requested`; no code creates a replacement packet.

- [ ] **Action 3 (2–5 minutes): Wire the router into the existing FastAPI application.**

  In `Chirp/src/chirp/server.py`, add the review-router import beside the existing `chirp` imports and include it immediately after application creation:

  ```diff
   from chirp.adapter import ChirpAdapter
+from chirp.review import router as review_router
   from chirp.rook_tool import chirp_create
   from chirp.tracing import TraceLogger
  ```

  ```diff
   app = FastAPI(title="Chirp", version="0.1.0", lifespan=_lifespan)
+app.include_router(review_router)
   adapter = ChirpAdapter()
   tracer = TraceLogger()
  ```

  Do not move existing endpoints, models, lifespan behavior, adapter initialization, or tracing code.

## 3. Run the new tests

**Files:**

- Verify: `Chirp/tests/test_review.py`
- Verify: `Chirp/src/chirp/review.py`
- Verify: `Chirp/src/chirp/server.py`

**Interfaces:**

- Consumes: The six test functions and the three mounted endpoints.
- Produces: A recorded focused-suite result for the completion report.

- [ ] **Action 1 (2–5 minutes): Run the focused suite and verify GREEN.**

  From the activated environment inside `Chirp`, run exactly:

  ```text
  python -m pytest tests/test_review.py -v
  ```

  Expected GREEN result: exit code `0`; all ten collected cases from the six test functions pass unchanged.

- [ ] **Action 2 (2–5 minutes): Record the exact focused result.**

  Copy the exact command, collected count, passed count, duration, and any warnings into the eventual completion report. If the command is not green, stop and report the observed failure; do not broaden scope or modify assertions without reviewer approval.

## 4. Run the complete existing Chirp suite

**Files:**

- Verify: `Chirp/src/chirp/review.py`
- Verify: `Chirp/src/chirp/server.py`
- Verify: `Chirp/tests/test_review.py`

**Interfaces:**

- Consumes: The complete existing Chirp test suite plus the new review tests.
- Produces: A recorded regression-suite result for the completion report.

- [ ] **Action 1 (2–5 minutes): Run the complete suite and verify GREEN.**

  From the activated environment inside `Chirp`, run exactly:

  ```text
  python -m pytest tests -v
  ```

  Expected GREEN result: exit code `0` with every collected test passing on the unchanged implementation and test code.

- [ ] **Action 2 (2–5 minutes): Record the exact full-suite result.**

  Copy the exact command, collected count, passed count, duration, and any warnings into the eventual completion report. If any test fails, stop and report its exact name and output; do not add dependencies or future-facing abstractions to resolve it.

## 5. Report exact results and stop for review

**Files:**

- Report: `Chirp/src/chirp/review.py`
- Report: `Chirp/src/chirp/server.py`
- Report: `Chirp/tests/test_review.py`

**Interfaces:**

- Consumes: The final diff and the exact focused/full pytest outputs.
- Produces: A reviewer-facing completion report; no commit, push, or follow-on implementation.

- [ ] **Action 1 (2–5 minutes): Confirm the final diff remains in scope.**

  Inspect the working tree and verify that the implementation changed only the three authorized files. Report any pre-existing unrelated working-tree entries as untouched; do not stage or edit them.

- [ ] **Action 2 (2–5 minutes): Write the completion report with exact evidence.**

  Report:

  - the three changed files and each file's responsibility;
  - request and response examples for `POST /reviews`, `GET /reviews/{packet_id}`, and `POST /reviews/{packet_id}/decision`, using the actual returned ID and timestamps from verification;
  - the exact focused and full-suite commands, collected/passed counts, durations, warnings, and exit codes;
  - every deviation from the approved design, or the explicit statement that there were none;
  - confirmation that no dependency, database, WebSocket, Grasshopper, revision-chain, reset-hook, authentication, UI, commit, or push was added.

- [ ] **Action 3 (2–5 minutes): Stop at the human-review checkpoint.**

  Do not commit, push, create replacement packets, or begin any future slice. Remain paused until the reviewer explicitly approves the implementation.
