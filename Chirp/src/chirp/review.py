"""In-memory human-review API for immutable Chirp packets."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from threading import Lock
from typing import Annotated, Callable, Literal, Sequence
from uuid import uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, JsonValue, StringConstraints, model_validator


DecisionAction = Literal["accept", "request_correction", "reject"]
ReviewStatus = Literal[
    "pending",
    "accepted",
    "correction_requested",
    "rejected",
]
TrimmedNonBlank = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1),
]


class ReviewParameter(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        allow_inf_nan=False,
    )

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
    model_config = ConfigDict(
        extra="forbid",
        allow_inf_nan=False,
    )

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
    reviewer: TrimmedNonBlank
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


def _new_review_record(packet: ReviewPacket) -> dict[str, object]:
    return {
        "packet_id": str(uuid4()),
        "created_at": datetime.now(timezone.utc),
        "status": "pending",
        "packet": deepcopy(packet.model_dump(mode="python")),
        "decision": None,
    }


ReviewCommit = Callable[[tuple[ReviewResponse, ...]], None]


def create_review_batch(
    packets: Sequence[ReviewPacket],
    commit: ReviewCommit,
) -> tuple[ReviewResponse, ...]:
    if not packets:
        raise ValueError("review batch must not be empty")
    records = tuple(_new_review_record(packet) for packet in packets)
    packet_ids = tuple(str(record["packet_id"]) for record in records)

    with _review_lock:
        try:
            for packet_id, record in zip(packet_ids, records):
                _reviews[packet_id] = deepcopy(record)
            snapshots = tuple(_snapshot(_reviews[packet_id]) for packet_id in packet_ids)
            commit(snapshots)
            return tuple(review.model_copy(deep=True) for review in snapshots)
        except Exception:
            for packet_id in packet_ids:
                _reviews.pop(packet_id, None)
            raise


def _read_review_batch_locked(
    packet_ids: Sequence[str],
) -> tuple[ReviewResponse, ...]:
    missing = next((packet_id for packet_id in packet_ids if packet_id not in _reviews), None)
    if missing is not None:
        raise KeyError(missing)
    return tuple(_snapshot(_reviews[packet_id]) for packet_id in packet_ids)


def read_review_batch(packet_ids: Sequence[str]) -> tuple[ReviewResponse, ...]:
    with _review_lock:
        return _read_review_batch_locked(packet_ids)


def read_review_batch_with_observed_at(
    packet_ids: Sequence[str],
) -> tuple[tuple[ReviewResponse, ...], datetime]:
    with _review_lock:
        snapshots = _read_review_batch_locked(packet_ids)
        observed_at = datetime.now(timezone.utc)
        return snapshots, observed_at


router = APIRouter()


@router.post(
    "/reviews",
    response_model=ReviewResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_review(packet: ReviewPacket) -> ReviewResponse:
    record = _new_review_record(packet)
    packet_id = str(record["packet_id"])
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
