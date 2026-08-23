"""API, concurrency, and matrix tests for process-local Riff snapshots."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
import json
from threading import Event, Lock
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient

from chirp.review import read_review_batch, router as review_router
from chirp.riff_presenter import PresentationResult, PresenterSection, ReviewViewModel
from chirp.riff_snapshot import (
    CanvasReasoningSnapshot,
    SnapshotConflictError,
    SnapshotImportError,
    SnapshotNotFoundError,
    SnapshotService,
    create_riff_router,
)
from chirp.server import validation_exception_handler


class FakePresenter:
    def __init__(self):
        self.calls = 0

    def present(self, snapshot):
        self.calls += 1
        node_ids = [node["node_id"] for node in snapshot["nodes"]]
        sections = [PresenterSection(template="run_summary", node_ids=node_ids)]
        for node_id in node_ids:
            sections.extend([
                PresenterSection(template="node_reasoning", node_ids=[node_id]),
                PresenterSection(template="human_review", node_ids=[node_id]),
            ])
        return PresentationResult(
            presentation_source="fallback",
            view_model=ReviewViewModel(snapshot_id=snapshot["snapshot_id"], sections=sections),
            riff_annotations=[],
        )


@pytest.fixture
def valid_snapshot():
    def packet(role, node_id):
        return {
            "stage": "review",
            "role": role,
            "contributor": "agent",
            "proposal": f"{role} proposal",
            "inputs": ["input"],
            "assumptions": ["assumption"],
            "parameters": [],
            "rationale": f"{role} rationale",
            "uncertainties": [],
            "payload": {},
            "provenance": {
                "run_id": "run-1",
                "component_id": node_id,
                "parent_packet_ids": [],
            },
        }

    return {
        "canvas_id": "canvas-1",
        "snapshot_id": "snapshot-1",
        "run_id": "run-1",
        "captured_at": "2026-08-23T12:00:00Z",
        "nodes": [
            {
                "node_id": "planner-node",
                "role": "Planner",
                "display_label": "Plan",
                "upstream_node_ids": [],
                "reasoning_packet": packet("Planner", "planner-node"),
            },
            {
                "node_id": "critic-node",
                "role": "Critic",
                "display_label": "Critique",
                "upstream_node_ids": ["planner-node"],
                "reasoning_packet": packet("Critic", "critic-node"),
            },
        ],
    }


@pytest.fixture
def fake_presenter():
    return FakePresenter()


@pytest.fixture
def service(fake_presenter):
    return SnapshotService(fake_presenter)


@pytest.fixture
def valid_model(valid_snapshot):
    return CanvasReasoningSnapshot.model_validate(valid_snapshot)


@pytest.fixture
def snapshot_client(service):
    app = FastAPI()
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.include_router(review_router)
    app.include_router(create_riff_router(service))
    return TestClient(app)


def test_post_snapshot_returns_201_and_one_mapping_per_node(snapshot_client, valid_snapshot):
    response = snapshot_client.post("/api/riff/snapshots", json=valid_snapshot)
    assert response.status_code == 201
    body = response.json()
    assert body["snapshot"]["snapshot_id"] == valid_snapshot["snapshot_id"]
    assert body["snapshot"]["canvas_id"] == valid_snapshot["canvas_id"]
    assert body["snapshot"]["nodes"] == valid_snapshot["nodes"]
    assert body["presentation_source"] == "fallback"
    assert [item["node_id"] for item in body["node_reviews"]] == ["planner-node", "critic-node"]
    assert len({item["packet_id"] for item in body["node_reviews"]}) == 2


def test_identical_completed_import_returns_200_without_new_work(
    snapshot_client, fake_presenter, valid_snapshot
):
    first = snapshot_client.post("/api/riff/snapshots", json=valid_snapshot)
    second = snapshot_client.post("/api/riff/snapshots", json=valid_snapshot)
    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json() == first.json()
    assert fake_presenter.calls == 1


def test_same_completed_snapshot_id_with_different_content_returns_409(
    snapshot_client, valid_snapshot
):
    assert snapshot_client.post("/api/riff/snapshots", json=valid_snapshot).status_code == 201
    changed = deepcopy(valid_snapshot)
    changed["nodes"][0]["reasoning_packet"]["proposal"] = "Changed proposal"
    assert snapshot_client.post("/api/riff/snapshots", json=changed).status_code == 409


def test_get_snapshot_returns_stored_defensive_copy_without_presenter_call(
    snapshot_client, fake_presenter, valid_snapshot
):
    created = snapshot_client.post("/api/riff/snapshots", json=valid_snapshot).json()
    fetched = snapshot_client.get(f"/api/riff/snapshots/{valid_snapshot['snapshot_id']}")
    assert fetched.status_code == 200
    assert fetched.json() == created
    assert fake_presenter.calls == 1


def test_get_unknown_snapshot_returns_404(snapshot_client):
    assert snapshot_client.get("/api/riff/snapshots/missing").status_code == 404


def test_same_nodes_in_a_later_snapshot_receive_new_packet_ids(snapshot_client, valid_snapshot):
    first = snapshot_client.post("/api/riff/snapshots", json=valid_snapshot).json()
    later = deepcopy(valid_snapshot)
    later["snapshot_id"] = "snapshot-2"
    later["captured_at"] = "2026-08-23T12:01:00Z"
    second = snapshot_client.post("/api/riff/snapshots", json=later).json()
    assert [x["node_id"] for x in first["node_reviews"]] == [x["node_id"] for x in second["node_reviews"]]
    assert all(a["packet_id"] != b["packet_id"] for a, b in zip(first["node_reviews"], second["node_reviews"]))


def _invalid_snapshot(snapshot, case):
    value = deepcopy(snapshot)
    if case == "extra-envelope": value["extra"] = True
    elif case == "blank-id": value["canvas_id"] = "  "
    elif case == "empty-nodes": value["nodes"] = []
    elif case == "duplicate-node": value["nodes"][1]["node_id"] = "planner-node"; value["nodes"][1]["reasoning_packet"]["provenance"]["component_id"] = "planner-node"
    elif case == "missing-upstream": value["nodes"][1]["upstream_node_ids"] = ["missing"]
    elif case == "self-reference": value["nodes"][0]["upstream_node_ids"] = ["planner-node"]
    elif case == "duplicate-upstream": value["nodes"][1]["upstream_node_ids"] = ["planner-node", "planner-node"]
    elif case == "component-id": value["nodes"][0]["reasoning_packet"]["provenance"]["component_id"] = "other"
    elif case == "run-id": value["nodes"][0]["reasoning_packet"]["provenance"]["run_id"] = "other"
    elif case == "role": value["nodes"][0]["reasoning_packet"]["role"] = "Critic"
    elif case == "naive-time": value["captured_at"] = "2026-08-23T12:00:00"
    elif case == "non-finite": value["nodes"][0]["reasoning_packet"]["payload"] = {"bad": float("inf")}
    return value


@pytest.mark.parametrize("case", [
    "extra-envelope", "blank-id", "empty-nodes", "duplicate-node", "missing-upstream",
    "self-reference", "duplicate-upstream", "component-id", "run-id", "role",
    "naive-time", "non-finite",
])
def test_invalid_snapshot_returns_422_without_presenter_or_reviews(
    snapshot_client, fake_presenter, valid_snapshot, case
):
    body = _invalid_snapshot(valid_snapshot, case)
    if case == "non-finite":
        response = snapshot_client.post(
            "/api/riff/snapshots",
            content=json.dumps(body),
            headers={"content-type": "application/json"},
        )
    else:
        response = snapshot_client.post("/api/riff/snapshots", json=body)
    assert response.status_code == 422
    assert fake_presenter.calls == 0


def test_invalid_snapshot_is_validated_before_snapshot_id_lookup(
    snapshot_client, fake_presenter, valid_snapshot
):
    assert snapshot_client.post("/api/riff/snapshots", json=valid_snapshot).status_code == 201
    invalid = deepcopy(valid_snapshot)
    invalid["extra"] = True
    response = snapshot_client.post("/api/riff/snapshots", json=invalid)
    assert response.status_code == 422
    assert fake_presenter.calls == 1


class BlockingPresenter(FakePresenter):
    def __init__(self):
        super().__init__()
        self.entered = Event()
        self.release = Event()
        self._call_lock = Lock()

    def present(self, snapshot):
        with self._call_lock:
            self.calls += 1
        self.entered.set()
        if not self.release.wait(timeout=2):
            raise AssertionError("owner release guard expired")
        self.calls -= 1
        try:
            return super().present(snapshot)
        finally:
            self.calls += 0


class WaiterAwareSnapshotService(SnapshotService):
    def __init__(self, presenter):
        super().__init__(presenter)
        self.waiter_entered = Event()

    def _wait_for_owner(self, snapshot_id, in_flight):
        self.waiter_entered.set()
        return super()._wait_for_owner(snapshot_id, in_flight)


def _client_for(service):
    app = FastAPI()
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.include_router(review_router)
    app.include_router(create_riff_router(service))
    return TestClient(app)


def test_concurrent_identical_imports_call_presenter_and_review_batch_once(
    valid_snapshot, monkeypatch
):
    presenter = BlockingPresenter()
    service = WaiterAwareSnapshotService(presenter)
    client = _client_for(service)
    import chirp.riff_snapshot as module
    original = module.create_review_batch
    batch_calls = 0
    count_lock = Lock()

    def counted(*args, **kwargs):
        nonlocal batch_calls
        with count_lock:
            batch_calls += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(module, "create_review_batch", counted)
    with ThreadPoolExecutor(max_workers=2) as pool:
        owner = pool.submit(client.post, "/api/riff/snapshots", json=valid_snapshot)
        assert presenter.entered.wait(timeout=2)
        waiter = pool.submit(client.post, "/api/riff/snapshots", json=valid_snapshot)
        assert service.waiter_entered.wait(timeout=2)
        presenter.release.set()
        responses = [owner.result(timeout=2), waiter.result(timeout=2)]
    assert sorted(response.status_code for response in responses) == [200, 201]
    assert presenter.calls == 1
    assert batch_calls == 1
    assert responses[0].json()["node_reviews"] == responses[1].json()["node_reviews"]


def test_different_content_conflicts_while_original_import_is_in_flight(valid_model):
    presenter = BlockingPresenter()
    service = WaiterAwareSnapshotService(presenter)
    with ThreadPoolExecutor(max_workers=2) as pool:
        owner = pool.submit(service.import_snapshot, valid_model)
        assert presenter.entered.wait(timeout=2)
        changed = valid_model.model_copy(deep=True)
        changed.nodes[0].reasoning_packet.proposal = "different"
        with pytest.raises(SnapshotConflictError):
            service.import_snapshot(changed)
        presenter.release.set()
        owner.result(timeout=2)


def test_identical_waiter_is_released_after_owner_failure(valid_model):
    class FailingBlockingPresenter(BlockingPresenter):
        def present(self, snapshot):
            super().present(snapshot)
            raise RuntimeError("presenter failed")

    presenter = FailingBlockingPresenter()
    service = WaiterAwareSnapshotService(presenter)
    with ThreadPoolExecutor(max_workers=2) as pool:
        owner = pool.submit(service.import_snapshot, valid_model)
        assert presenter.entered.wait(timeout=2)
        waiter = pool.submit(service.import_snapshot, valid_model)
        assert service.waiter_entered.wait(timeout=2)
        presenter.release.set()
        with pytest.raises(SnapshotImportError): owner.result(timeout=2)
        with pytest.raises(SnapshotImportError): waiter.result(timeout=2)


def test_identical_waiter_is_released_after_publication_callback_failure(
    valid_model, monkeypatch
):
    presenter = BlockingPresenter()
    service = WaiterAwareSnapshotService(presenter)
    monkeypatch.setattr(
        service,
        "_commit_bundle_locked",
        lambda prepared, reviews: (_ for _ in ()).throw(RuntimeError("publish")),
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        owner = pool.submit(service.import_snapshot, valid_model)
        assert presenter.entered.wait(timeout=2)
        waiter = pool.submit(service.import_snapshot, valid_model)
        assert service.waiter_entered.wait(timeout=2)
        presenter.release.set()
        with pytest.raises(SnapshotImportError): owner.result(timeout=2)
        with pytest.raises(SnapshotImportError): waiter.result(timeout=2)


def test_explicit_retry_after_clean_failure_may_invoke_presenter_again(valid_model):
    class FailOncePresenter(FakePresenter):
        def present(self, snapshot):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("first failure")
            self.calls -= 1
            return super().present(snapshot)

    presenter = FailOncePresenter()
    service = SnapshotService(presenter)
    with pytest.raises(SnapshotImportError):
        service.import_snapshot(valid_model)
    assert service.import_snapshot(valid_model).created is True
    assert presenter.calls == 2


@pytest.mark.parametrize("failure_point", ["before", "after"])
def test_callback_failure_leaves_no_residue(
    service, valid_model, monkeypatch, failure_point
):
    packet_ids = [
        "00000000-0000-0000-0000-000000000201",
        "00000000-0000-0000-0000-000000000202",
    ]
    ids = iter(UUID(value) for value in packet_ids)
    monkeypatch.setattr("chirp.review.uuid4", lambda: next(ids))
    original = service._commit_bundle_locked

    if failure_point == "before":
        def fail(prepared, reviews):
            raise RuntimeError("before")
    else:
        def fail(prepared, reviews):
            original(prepared, reviews)
            raise RuntimeError("after")
    monkeypatch.setattr(service, "_commit_bundle_locked", fail)

    with pytest.raises(SnapshotImportError):
        service.import_snapshot(valid_model)
    with pytest.raises(SnapshotNotFoundError):
        service.get_snapshot(valid_model.snapshot_id)
    with pytest.raises(KeyError):
        read_review_batch(tuple(packet_ids))


def test_matrix_preserves_node_order_and_joins_current_decisions(snapshot_client, valid_snapshot):
    created = snapshot_client.post("/api/riff/snapshots", json=valid_snapshot).json()
    first, second = created["node_reviews"]
    snapshot_client.post(f"/reviews/{first['packet_id']}/decision", json={"action": "accept", "reviewer": "Ada"})
    snapshot_client.post(f"/reviews/{second['packet_id']}/decision", json={"action": "request_correction", "reviewer": "Lin", "note": "Clarify boundary"})
    response = snapshot_client.get(f"/api/riff/snapshots/{valid_snapshot['snapshot_id']}/matrix")
    assert response.status_code == 200
    matrix = response.json()
    assert [node["node_id"] for node in matrix["nodes"]] == ["planner-node", "critic-node"]
    assert [node["review"]["status"] for node in matrix["nodes"]] == ["accepted", "correction_requested"]
    assert matrix["nodes"][1]["review"]["decision"]["reviewer"] == "Lin"
    assert matrix["nodes"][1]["review"]["decision"]["note"] == "Clarify boundary"


def test_matrix_review_complete_is_false_while_any_node_is_pending(snapshot_client, valid_snapshot):
    created = snapshot_client.post("/api/riff/snapshots", json=valid_snapshot).json()
    packet_id = created["node_reviews"][0]["packet_id"]
    snapshot_client.post(f"/reviews/{packet_id}/decision", json={"action": "accept", "reviewer": "Ada"})
    matrix = snapshot_client.get(f"/api/riff/snapshots/{valid_snapshot['snapshot_id']}/matrix").json()
    assert matrix["review_complete"] is False


def test_matrix_review_complete_is_true_when_every_node_is_terminal(snapshot_client, valid_snapshot):
    created = snapshot_client.post("/api/riff/snapshots", json=valid_snapshot).json()
    actions = [
        {"action": "accept", "reviewer": "Ada"},
        {"action": "reject", "reviewer": "Lin", "note": "Stop"},
    ]
    for mapping, decision in zip(created["node_reviews"], actions):
        snapshot_client.post(f"/reviews/{mapping['packet_id']}/decision", json=decision)
    matrix = snapshot_client.get(f"/api/riff/snapshots/{valid_snapshot['snapshot_id']}/matrix").json()
    assert matrix["review_complete"] is True


def test_matrix_exports_do_not_mutate_reasoning_or_annotations(snapshot_client, valid_snapshot):
    created = snapshot_client.post("/api/riff/snapshots", json=valid_snapshot).json()
    first = snapshot_client.get(f"/api/riff/snapshots/{valid_snapshot['snapshot_id']}/matrix").json()
    second = snapshot_client.get(f"/api/riff/snapshots/{valid_snapshot['snapshot_id']}/matrix").json()
    assert first["nodes"][0]["reasoning_packet"] == valid_snapshot["nodes"][0]["reasoning_packet"]
    assert second["nodes"][0]["reasoning_packet"] == created["snapshot"]["nodes"][0]["reasoning_packet"]
    assert first["riff_annotations"] == second["riff_annotations"] == []


def test_repeated_matrix_exports_differ_only_by_exported_at(snapshot_client, valid_snapshot):
    snapshot_client.post("/api/riff/snapshots", json=valid_snapshot)
    first = snapshot_client.get(f"/api/riff/snapshots/{valid_snapshot['snapshot_id']}/matrix").json()
    second = snapshot_client.get(f"/api/riff/snapshots/{valid_snapshot['snapshot_id']}/matrix").json()
    first.pop("exported_at")
    second.pop("exported_at")
    assert first == second


def test_snapshot_reads_are_defensive_copies(service, valid_model):
    service.import_snapshot(valid_model)
    first = service.get_snapshot(valid_model.snapshot_id)
    first.snapshot.nodes[0].reasoning_packet.payload["tampered"] = True
    second = service.get_snapshot(valid_model.snapshot_id)
    assert "tampered" not in second.snapshot.nodes[0].reasoning_packet.payload


def test_get_unknown_matrix_returns_404(snapshot_client):
    assert snapshot_client.get("/api/riff/snapshots/missing/matrix").status_code == 404
