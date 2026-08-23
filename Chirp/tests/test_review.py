"""Observable API tests for the in-memory human-review round trip."""

from copy import deepcopy
import json
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from chirp.server import app
from chirp.review import ReviewPacket, create_review_batch, read_review_batch


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


def test_create_review_returns_201_pending(valid_packet: dict[str, object]):
    response = client.post("/reviews", json=valid_packet)

    assert response.status_code == 201
    body = response.json()
    assert body["packet_id"]
    assert body["created_at"]
    assert body["status"] == "pending"
    assert body["packet"] == valid_packet
    assert body["decision"] is None


@pytest.mark.parametrize(
    ("target", "invalid_value"),
    [
        pytest.param("parameter", float("nan"), id="parameter-nan"),
        pytest.param("payload", float("inf"), id="nested-payload-infinity"),
    ],
)
def test_non_finite_packet_values_return_422(
    valid_packet: dict[str, object],
    target: str,
    invalid_value: float,
):
    packet = deepcopy(valid_packet)
    if target == "parameter":
        packet["parameters"][0]["value"] = invalid_value
    else:
        packet["payload"] = {"nested": {"value": invalid_value}}

    response = client.post(
        "/reviews",
        content=json.dumps(packet),
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 422


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


def test_create_review_batch_commits_in_packet_order(valid_packet, monkeypatch):
    ids = iter([
        UUID("00000000-0000-0000-0000-000000000101"),
        UUID("00000000-0000-0000-0000-000000000102"),
    ])
    monkeypatch.setattr("chirp.review.uuid4", lambda: next(ids))
    packets = (
        ReviewPacket.model_validate(valid_packet),
        ReviewPacket.model_validate({
            **valid_packet,
            "provenance": {
                **valid_packet["provenance"],
                "component_id": "second-component",
            },
        }),
    )
    committed = []

    result = create_review_batch(packets, lambda reviews: committed.append(reviews))

    assert tuple(review.packet_id for review in result) == (
        "00000000-0000-0000-0000-000000000101",
        "00000000-0000-0000-0000-000000000102",
    )
    assert committed == [result]
    assert all(review.status == "pending" for review in result)


def test_create_review_batch_rolls_back_every_record_when_commit_fails(
    valid_packet, monkeypatch
):
    packet_id = "00000000-0000-0000-0000-000000000103"
    monkeypatch.setattr("chirp.review.uuid4", lambda: UUID(packet_id))

    def fail(_reviews):
        raise RuntimeError("publication failed")

    with pytest.raises(RuntimeError, match="publication failed"):
        create_review_batch(
            (ReviewPacket.model_validate(valid_packet),),
            fail,
        )

    with pytest.raises(KeyError, match=packet_id):
        read_review_batch((packet_id,))


def test_read_review_batch_returns_defensive_snapshots(valid_packet, monkeypatch):
    packet_id = "00000000-0000-0000-0000-000000000104"
    monkeypatch.setattr("chirp.review.uuid4", lambda: UUID(packet_id))
    create_review_batch(
        (ReviewPacket.model_validate(valid_packet),),
        lambda _reviews: None,
    )

    first = read_review_batch((packet_id,))
    first[0].packet.payload["tampered"] = True
    second = read_review_batch((packet_id,))

    assert "tampered" not in second[0].packet.payload
