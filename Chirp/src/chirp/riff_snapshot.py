"""Process-local import and review-matrix API for Riff reasoning snapshots."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
from threading import Lock
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from chirp.review import (
    DecisionRecord,
    ReviewPacket,
    ReviewResponse,
    ReviewStatus,
    create_review_batch,
)
from chirp.riff_presenter import (
    PresentationResult,
    PresentationSource,
    ReviewViewModel,
    RiffAnnotation,
    RiffPresenter,
)


def _require_nonblank(value: str) -> str:
    if not value.strip():
        raise ValueError("value must not be blank")
    return value


NonBlank = Annotated[str, AfterValidator(_require_nonblank)]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class CanvasReasoningNode(_StrictModel):
    node_id: NonBlank
    role: NonBlank
    display_label: NonBlank
    upstream_node_ids: list[NonBlank]
    reasoning_packet: ReviewPacket


class CanvasReasoningSnapshot(_StrictModel):
    canvas_id: NonBlank
    snapshot_id: NonBlank
    run_id: NonBlank
    captured_at: datetime
    nodes: list[CanvasReasoningNode] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_identity_and_topology(self) -> "CanvasReasoningSnapshot":
        if self.captured_at.utcoffset() is None:
            raise ValueError("captured_at must be timezone-aware")
        node_ids = [node.node_id for node in self.nodes]
        if len(node_ids) != len(set(node_ids)):
            raise ValueError("node_id values must be unique")
        known = set(node_ids)
        for node in self.nodes:
            packet = node.reasoning_packet
            if packet.provenance.component_id != node.node_id:
                raise ValueError("packet component_id must match node_id")
            if packet.provenance.run_id != self.run_id:
                raise ValueError("packet run_id must match snapshot run_id")
            if packet.role.strip().casefold() != node.role.strip().casefold():
                raise ValueError("packet role must match node role")
            if len(node.upstream_node_ids) != len(set(node.upstream_node_ids)):
                raise ValueError("upstream_node_ids must not repeat")
            if node.node_id in node.upstream_node_ids:
                raise ValueError("node cannot reference itself")
            if any(upstream not in known for upstream in node.upstream_node_ids):
                raise ValueError("upstream node must exist in the same snapshot")
        return self


class NodeReviewMapping(_StrictModel):
    node_id: NonBlank
    packet_id: NonBlank


class SnapshotPresentationResponse(_StrictModel):
    snapshot: CanvasReasoningSnapshot
    presentation_source: PresentationSource
    view_model: ReviewViewModel
    riff_annotations: list[RiffAnnotation]
    node_reviews: list[NodeReviewMapping]


class ReviewMatrixReview(_StrictModel):
    packet_id: NonBlank
    created_at: datetime
    status: ReviewStatus
    decision: DecisionRecord | None


class ReviewMatrixNode(_StrictModel):
    node_id: NonBlank
    role: NonBlank
    display_label: NonBlank
    upstream_node_ids: list[NonBlank]
    reasoning_packet: ReviewPacket
    review: ReviewMatrixReview


class ReviewMatrix(_StrictModel):
    schema_version: Literal["1.0"] = "1.0"
    canvas_id: NonBlank
    snapshot_id: NonBlank
    run_id: NonBlank
    captured_at: datetime
    exported_at: datetime
    presentation_source: PresentationSource
    review_complete: bool
    riff_annotations: list[RiffAnnotation]
    nodes: list[ReviewMatrixNode]


class SnapshotConflictError(Exception):
    """The snapshot ID is already associated with different content."""


class SnapshotNotFoundError(Exception):
    """The requested completed snapshot does not exist."""


class SnapshotImportError(Exception):
    """An unexpected import failure was cleaned up before publication."""


def _snapshot_json(snapshot: CanvasReasoningSnapshot) -> dict[str, object]:
    return snapshot.model_dump(mode="json")


def _fingerprint(snapshot: CanvasReasoningSnapshot) -> str:
    canonical = json.dumps(
        _snapshot_json(snapshot),
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class _ImportResult:
    response: SnapshotPresentationResponse
    created: bool


@dataclass(frozen=True)
class _PreparedPublication:
    snapshot: CanvasReasoningSnapshot
    fingerprint: str
    presentation: PresentationResult


@dataclass(frozen=True)
class _CompletedBundle:
    fingerprint: str
    response: SnapshotPresentationResponse


class SnapshotService:
    def __init__(self, presenter: RiffPresenter) -> None:
        self._presenter = presenter
        self._lock = Lock()
        self._completed: dict[str, _CompletedBundle] = {}

    def import_snapshot(self, snapshot: CanvasReasoningSnapshot) -> _ImportResult:
        fingerprint = _fingerprint(snapshot)
        with self._lock:
            existing = self._completed.get(snapshot.snapshot_id)
            if existing is not None:
                if existing.fingerprint != fingerprint:
                    raise SnapshotConflictError(snapshot.snapshot_id)
                return _ImportResult(deepcopy(existing.response), created=False)

        presentation = self._presenter.present(deepcopy(_snapshot_json(snapshot)))
        prepared = _PreparedPublication(
            snapshot=snapshot.model_copy(deep=True),
            fingerprint=fingerprint,
            presentation=presentation.model_copy(deep=True),
        )
        with self._lock:
            existing = self._completed.get(snapshot.snapshot_id)
            if existing is not None:
                if existing.fingerprint != fingerprint:
                    raise SnapshotConflictError(snapshot.snapshot_id)
                return _ImportResult(deepcopy(existing.response), created=False)
            published: list[SnapshotPresentationResponse] = []

            def commit(reviews: tuple[ReviewResponse, ...]) -> None:
                published.append(self._commit_bundle_locked(prepared, reviews))

            try:
                create_review_batch(
                    tuple(node.reasoning_packet for node in snapshot.nodes),
                    commit,
                )
            except Exception as exc:
                self._completed.pop(snapshot.snapshot_id, None)
                raise SnapshotImportError(snapshot.snapshot_id) from exc
            return _ImportResult(response=published[0], created=True)

    def _commit_bundle_locked(
        self,
        prepared: _PreparedPublication,
        reviews: tuple[ReviewResponse, ...],
    ) -> SnapshotPresentationResponse:
        mappings = [
            NodeReviewMapping(node_id=node.node_id, packet_id=review.packet_id)
            for node, review in zip(prepared.snapshot.nodes, reviews)
        ]
        response = SnapshotPresentationResponse(
            snapshot=prepared.snapshot.model_copy(deep=True),
            presentation_source=prepared.presentation.presentation_source,
            view_model=prepared.presentation.view_model.model_copy(deep=True),
            riff_annotations=deepcopy(prepared.presentation.riff_annotations),
            node_reviews=mappings,
        )
        stored_response = response.model_copy(deep=True)
        caller_response = response.model_copy(deep=True)
        self._completed[prepared.snapshot.snapshot_id] = _CompletedBundle(
            fingerprint=prepared.fingerprint,
            response=stored_response,
        )
        return caller_response

    def get_snapshot(self, snapshot_id: str) -> SnapshotPresentationResponse:
        with self._lock:
            bundle = self._completed.get(snapshot_id)
            if bundle is None:
                raise SnapshotNotFoundError(snapshot_id)
            return deepcopy(bundle.response)


def create_riff_router(service: SnapshotService) -> APIRouter:
    router = APIRouter(prefix="/api/riff")

    @router.post(
        "/snapshots",
        response_model=SnapshotPresentationResponse,
        status_code=status.HTTP_201_CREATED,
    )
    def import_snapshot(
        snapshot: CanvasReasoningSnapshot,
        response: Response,
    ) -> SnapshotPresentationResponse:
        try:
            result = service.import_snapshot(snapshot)
        except SnapshotConflictError:
            raise HTTPException(
                status_code=409,
                detail="Snapshot ID conflicts with different content",
            )
        except SnapshotImportError:
            raise HTTPException(status_code=500, detail="Snapshot import failed")
        response.status_code = 201 if result.created else 200
        return result.response

    @router.get("/snapshots/{snapshot_id}", response_model=SnapshotPresentationResponse)
    def get_snapshot(snapshot_id: str) -> SnapshotPresentationResponse:
        try:
            return service.get_snapshot(snapshot_id)
        except SnapshotNotFoundError:
            raise HTTPException(status_code=404, detail="Riff snapshot not found")

    return router
