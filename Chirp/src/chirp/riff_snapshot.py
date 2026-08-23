"""Process-local import and review-matrix API for Riff reasoning snapshots."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
import hashlib
import json
import re
from threading import Event, Lock
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from chirp.review import (
    DecisionRecord,
    ReviewPacket,
    ReviewResponse,
    ReviewStatus,
    create_review_batch,
    read_review_batch_with_observed_at,
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


_PATH_SAFE_SNAPSHOT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")


def _require_path_safe_snapshot_id(value: str) -> str:
    if not _PATH_SAFE_SNAPSHOT_ID.fullmatch(value):
        raise ValueError(
            "snapshot_id must start with an ASCII letter or digit and contain only "
            "ASCII letters, digits, '.', '_', or '-'"
        )
    return value


SnapshotId = Annotated[str, AfterValidator(_require_path_safe_snapshot_id)]


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
    snapshot_id: SnapshotId
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
    snapshot_id: SnapshotId
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


@dataclass
class _InFlight:
    fingerprint: str
    event: Event = field(default_factory=Event)
    failed: bool = False


class SnapshotService:
    def __init__(self, presenter: RiffPresenter) -> None:
        self._presenter = presenter
        self._lock = Lock()
        self._completed: dict[str, _CompletedBundle] = {}
        self._in_flight: dict[str, _InFlight] = {}

    def import_snapshot(self, snapshot: CanvasReasoningSnapshot) -> _ImportResult:
        frozen_snapshot = snapshot.model_copy(deep=True)
        fingerprint = _fingerprint(frozen_snapshot)
        snapshot_id = frozen_snapshot.snapshot_id
        with self._lock:
            completed = self._completed.get(snapshot_id)
            if completed is not None:
                if completed.fingerprint != fingerprint:
                    raise SnapshotConflictError(snapshot_id)
                return _ImportResult(deepcopy(completed.response), created=False)
            active = self._in_flight.get(snapshot_id)
            if active is not None:
                if active.fingerprint != fingerprint:
                    raise SnapshotConflictError(snapshot_id)
                waiter = active
                owner = None
            else:
                owner = _InFlight(fingerprint=fingerprint)
                self._in_flight[snapshot_id] = owner
                waiter = None

        if waiter is not None:
            return self._wait_for_owner(snapshot_id, waiter)

        assert owner is not None
        try:
            presentation = self._presenter.present(_snapshot_json(frozen_snapshot))
            prepared = _PreparedPublication(
                snapshot=frozen_snapshot,
                fingerprint=fingerprint,
                presentation=presentation.model_copy(deep=True),
            )
        except Exception as exc:
            try:
                with self._lock:
                    owner.failed = True
                    self._in_flight.pop(snapshot_id, None)
            finally:
                owner.event.set()
            raise SnapshotImportError(snapshot_id) from exc

        return self._publish_owner(prepared, owner)

    def _wait_for_owner(
        self,
        snapshot_id: str,
        in_flight: _InFlight,
    ) -> _ImportResult:
        in_flight.event.wait()
        if in_flight.failed:
            raise SnapshotImportError(snapshot_id)
        with self._lock:
            bundle = self._completed.get(snapshot_id)
            if bundle is None:
                raise SnapshotImportError(snapshot_id)
            return _ImportResult(response=deepcopy(bundle.response), created=False)

    def _recheck_owner_locked(
        self,
        snapshot_id: str,
        fingerprint: str,
        owner: _InFlight,
    ) -> None:
        if self._in_flight.get(snapshot_id) is not owner:
            raise SnapshotImportError(snapshot_id)
        if owner.fingerprint != fingerprint or snapshot_id in self._completed:
            raise SnapshotImportError(snapshot_id)

    def _publish_owner(
        self,
        prepared: _PreparedPublication,
        owner: _InFlight,
    ) -> _ImportResult:
        snapshot_id = prepared.snapshot.snapshot_id
        published: list[SnapshotPresentationResponse] = []
        publication_error: Exception | None = None

        def commit(reviews: tuple[ReviewResponse, ...]) -> None:
            published.append(self._commit_bundle_locked(prepared, reviews))

        try:
            with self._lock:
                try:
                    self._recheck_owner_locked(snapshot_id, prepared.fingerprint, owner)
                    create_review_batch(
                        tuple(node.reasoning_packet for node in prepared.snapshot.nodes),
                        commit,
                    )
                    self._in_flight.pop(snapshot_id, None)
                except Exception as exc:
                    self._completed.pop(snapshot_id, None)
                    owner.failed = True
                    self._in_flight.pop(snapshot_id, None)
                    publication_error = exc
        finally:
            owner.event.set()

        if publication_error is not None:
            raise SnapshotImportError(snapshot_id) from publication_error
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

    def build_matrix(self, snapshot_id: str) -> ReviewMatrix:
        with self._lock:
            bundle = self._completed.get(snapshot_id)
            if bundle is None:
                raise SnapshotNotFoundError(snapshot_id)
            response = deepcopy(bundle.response)
            reviews, observed_at = read_review_batch_with_observed_at(
                tuple(mapping.packet_id for mapping in response.node_reviews)
            )
            review_by_packet = {review.packet_id: review for review in reviews}
            nodes = []
            for node, mapping in zip(response.snapshot.nodes, response.node_reviews):
                review = review_by_packet[mapping.packet_id]
                nodes.append(ReviewMatrixNode(
                    node_id=node.node_id,
                    role=node.role,
                    display_label=node.display_label,
                    upstream_node_ids=deepcopy(node.upstream_node_ids),
                    reasoning_packet=node.reasoning_packet.model_copy(deep=True),
                    review=ReviewMatrixReview(
                        packet_id=review.packet_id,
                        created_at=review.created_at,
                        status=review.status,
                        decision=(
                            review.decision.model_copy(deep=True)
                            if review.decision is not None
                            else None
                        ),
                    ),
                ))
            return ReviewMatrix(
                schema_version="1.0",
                canvas_id=response.snapshot.canvas_id,
                snapshot_id=response.snapshot.snapshot_id,
                run_id=response.snapshot.run_id,
                captured_at=response.snapshot.captured_at,
                exported_at=observed_at,
                presentation_source=response.presentation_source,
                review_complete=all(review.status != "pending" for review in reviews),
                riff_annotations=deepcopy(response.riff_annotations),
                nodes=nodes,
            )


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
    def get_snapshot(snapshot_id: SnapshotId) -> SnapshotPresentationResponse:
        try:
            return service.get_snapshot(snapshot_id)
        except SnapshotNotFoundError:
            raise HTTPException(status_code=404, detail="Riff snapshot not found")

    @router.get("/snapshots/{snapshot_id}/matrix", response_model=ReviewMatrix)
    def get_matrix(snapshot_id: SnapshotId) -> ReviewMatrix:
        try:
            return service.build_matrix(snapshot_id)
        except SnapshotNotFoundError:
            raise HTTPException(status_code=404, detail="Riff snapshot not found")

    return router
