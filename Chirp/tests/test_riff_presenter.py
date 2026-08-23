"""Tests for strict, grounded Riff presentation."""

from copy import deepcopy
import json

import pytest

from chirp.riff_presenter import RiffPresenter


class FakeAdapter:
    def __init__(self, candidate_text: str, reasoning: str = "private chain"):
        self.candidate_text = candidate_text
        self.reasoning = reasoning
        self.calls = []

    def call(self, **kwargs):
        self.calls.append(deepcopy(kwargs))
        kwargs["inputs"]["mutated_by_adapter"] = True
        return {
            "outputs": {"candidate_json": self.candidate_text},
            "reasoning": self.reasoning,
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "cached": False,
            "latency_ms": 1.0,
            "model": "fake-model",
        }


@pytest.fixture
def snapshot_mapping():
    def packet(role, component_id, proposal, rationale, assumptions, uncertainties, payload):
        return {
            "stage": "review",
            "role": role,
            "contributor": "demo-agent",
            "proposal": proposal,
            "inputs": ["bounded input"],
            "assumptions": assumptions,
            "parameters": [],
            "rationale": rationale,
            "uncertainties": uncertainties,
            "payload": payload,
            "provenance": {
                "run_id": "run-1",
                "component_id": component_id,
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
                "reasoning_packet": packet(
                    "Planner", "planner-node", "Make a plan.", "Plan rationale.",
                    ["Approval comes first."], ["Timing is uncertain."], {"phase": "plan"},
                ),
            },
            {
                "node_id": "critic-node",
                "role": "Critic",
                "display_label": "Critique",
                "upstream_node_ids": ["planner-node"],
                "reasoning_packet": packet(
                    "Critic", "critic-node", "Challenge the plan.", "Critic rationale.",
                    ["Side effects matter."], [], {"conflicts": ["Boundary is unclear."]},
                ),
            },
        ],
    }


@pytest.fixture
def valid_candidate():
    return {
        "sections": [{
            "template": "conflicts_uncertainties",
            "node_ids": ["planner-node", "critic-node"],
            "heading": "Cross-node review focus",
            "annotation_ids": ["a1"],
            "emphasis": "high",
        }],
        "riff_annotations": [{
            "annotation_id": "a1",
            "kind": "conflict",
            "text": "The critic questions the planner assumption.",
            "severity": "attention",
            "sources": [
                {"node_id": "planner-node", "scope": "reasoning_packet", "field_path": "/assumptions/0"},
                {"node_id": "critic-node", "scope": "node", "field_path": "/upstream_node_ids/0"},
            ],
        }],
    }


@pytest.fixture
def valid_candidate_text(valid_candidate):
    return json.dumps(valid_candidate)


def test_presenter_returns_grounded_intelligent_view_and_discards_reasoning(
    snapshot_mapping,
):
    candidate = {
        "sections": [{
            "template": "conflicts_uncertainties",
            "node_ids": ["critic-node", "planner-node"],
            "heading": "Cross-node review focus",
            "annotation_ids": ["a1"],
            "emphasis": "high",
        }],
        "riff_annotations": [{
            "annotation_id": "a1",
            "kind": "conflict",
            "text": "The critic questions the planner assumption.",
            "severity": "attention",
            "sources": [
                {
                    "node_id": "planner-node",
                    "scope": "reasoning_packet",
                    "field_path": "/assumptions/0",
                },
                {
                    "node_id": "critic-node",
                    "scope": "node",
                    "field_path": "/upstream_node_ids/0",
                },
            ],
        }],
    }
    adapter = FakeAdapter(json.dumps(candidate))

    result = RiffPresenter(adapter).present(snapshot_mapping)

    assert result.presentation_source == "intelligent"
    assert result.riff_annotations[0].annotation_id == "a1"
    assert result.view_model.schema_version == "1.0"
    assert result.view_model.snapshot_id == snapshot_mapping["snapshot_id"]
    assert result.view_model.sections[0].template == "run_summary"
    assert "private chain" not in result.model_dump_json()
