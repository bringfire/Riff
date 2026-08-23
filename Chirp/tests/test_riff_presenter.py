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


@pytest.mark.parametrize(
    "candidate_text",
    [
        pytest.param("not json", id="malformed"),
        pytest.param("```json\n{}\n```", id="markdown-fence"),
        pytest.param("[]", id="non-object-root"),
        pytest.param('{"sections":[],"sections":[],"riff_annotations":[]}', id="duplicate-key"),
        pytest.param(
            '{"sections":[],"riff_annotations":[{"annotation_id":"a1",'
            '"annotation_id":"a2","kind":"summary","text":"x",'
            '"severity":"informational","sources":[]}]}',
            id="nested-duplicate-key",
        ),
        pytest.param('{"sections":[],"riff_annotations":[],"score":NaN}', id="nan"),
        pytest.param('{"sections":[],"riff_annotations":[],"score":Infinity}', id="infinity"),
        pytest.param('{"sections":[],"riff_annotations":[],"score":-Infinity}', id="negative-infinity"),
        pytest.param('{"sections":[],"riff_annotations":[]} trailing', id="trailing-content"),
        pytest.param('{"sections":[],"riff_annotations":[],"extra":true}', id="undeclared-field"),
        pytest.param(
            '{"sections":[{"template":"untrusted","node_ids":["planner-node"],'
            '"annotation_ids":[],"emphasis":"normal"}],"riff_annotations":[]}',
            id="unknown-template",
        ),
    ],
)
def test_presenter_falls_back_for_invalid_candidate_json(
    snapshot_mapping, candidate_text
):
    result = RiffPresenter(FakeAdapter(candidate_text)).present(snapshot_mapping)
    assert result.presentation_source == "fallback"
    assert result.riff_annotations == []


def _invalid_grounding_candidate(candidate, case):
    value = deepcopy(candidate)
    section = value["sections"][0]
    source = value["riff_annotations"][0]["sources"][0]
    if case == "unknown-node":
        source["node_id"] = "missing-node"
    elif case == "unknown-annotation":
        section["annotation_ids"] = ["missing-annotation"]
    elif case == "invalid-scope":
        source["scope"] = "canvas"
    elif case == "empty-pointer":
        source["field_path"] = ""
    elif case == "fragment-pointer":
        source["field_path"] = "#/assumptions/0"
    elif case == "relative-pointer":
        source["field_path"] = "0/assumptions/0"
    elif case == "invalid-escape":
        source["field_path"] = "/payload/bad~2key"
    elif case == "append-token":
        source["field_path"] = "/assumptions/-"
    elif case == "wildcard":
        source["field_path"] = "/payload/*"
    elif case == "jsonpath-filter":
        source["field_path"] = "/payload/$[?(@)]"
    elif case == "leading-zero-index":
        source["field_path"] = "/assumptions/00"
    elif case == "out-of-range-index":
        source["field_path"] = "/assumptions/99"
    elif case == "unresolved-key":
        source["field_path"] = "/missing"
    elif case == "duplicate-source":
        value["riff_annotations"][0]["sources"].append(deepcopy(source))
    elif case == "unreferenced-annotation":
        section["annotation_ids"] = []
    elif case == "duplicate-section-node":
        section["node_ids"] = ["planner-node", "planner-node"]
    elif case == "duplicate-mandatory-section":
        value["sections"].extend([
            {"template": "node_reasoning", "node_ids": ["planner-node"], "annotation_ids": [], "emphasis": "normal"},
            {"template": "node_reasoning", "node_ids": ["planner-node"], "annotation_ids": [], "emphasis": "normal"},
        ])
    elif case == "multi-node-human-review":
        value["sections"].append({
            "template": "human_review",
            "node_ids": ["planner-node", "critic-node"],
            "annotation_ids": [],
            "emphasis": "normal",
        })
    return value


@pytest.mark.parametrize(
    "case",
    [
        "unknown-node", "unknown-annotation", "invalid-scope", "empty-pointer",
        "fragment-pointer", "relative-pointer", "invalid-escape", "append-token",
        "wildcard", "jsonpath-filter", "leading-zero-index", "out-of-range-index",
        "unresolved-key", "duplicate-source", "unreferenced-annotation",
        "duplicate-section-node", "duplicate-mandatory-section", "multi-node-human-review",
    ],
)
def test_presenter_falls_back_for_invalid_grounding(snapshot_mapping, valid_candidate, case):
    candidate = _invalid_grounding_candidate(valid_candidate, case)
    result = RiffPresenter(FakeAdapter(json.dumps(candidate))).present(snapshot_mapping)
    assert result.presentation_source == "fallback"
    assert result.riff_annotations == []


def test_json_pointer_escapes_and_container_references_are_valid(
    snapshot_mapping, valid_candidate
):
    snapshot_mapping["nodes"][0]["reasoning_packet"]["payload"] = {
        "slash/key": {"tilde~key": "grounded"}
    }
    valid_candidate["riff_annotations"][0]["sources"] = [
        {"node_id": "planner-node", "scope": "reasoning_packet", "field_path": "/payload/slash~1key/tilde~0key"},
        {"node_id": "planner-node", "scope": "reasoning_packet", "field_path": "/payload"},
    ]

    result = RiffPresenter(FakeAdapter(json.dumps(valid_candidate))).present(snapshot_mapping)

    assert result.presentation_source == "intelligent"
    assert [source.field_path for source in result.riff_annotations[0].sources] == [
        "/payload/slash~1key/tilde~0key", "/payload"
    ]


def test_prompt_declares_candidate_contract_grounding_and_adaptation(
    snapshot_mapping, valid_candidate_text
):
    adapter = FakeAdapter(valid_candidate_text)
    RiffPresenter(adapter).present(snapshot_mapping)
    prompt = adapter.calls[0]["inputs"]["riff_instructions"]
    for required in (
        '"sections"', '"riff_annotations"', '"template"', '"node_ids"',
        '"annotation_ids"', '"sources"', '"scope"', '"field_path"',
        "change_candidate", "informational | attention | blocking", "RFC 6901",
        "novel roles", "COMPACT VALID EXAMPLE",
    ):
        assert required in prompt


def test_presenter_uses_fresh_inputs_and_disables_only_adapter_cache(
    snapshot_mapping, valid_candidate_text
):
    adapter = FakeAdapter(valid_candidate_text)
    presenter = RiffPresenter(adapter)
    presenter.present(snapshot_mapping)
    presenter.present(snapshot_mapping)
    assert len(adapter.calls) == 2
    assert adapter.calls[0]["inputs"] == adapter.calls[1]["inputs"]
    assert adapter.calls[0]["category"] is None
    assert adapter.calls[0]["use_cache"] is False
    assert adapter.calls[0]["schema"] == {"candidate_json": "str"}
    assert "mutated_by_adapter" not in adapter.calls[0]["inputs"]


def test_presenter_reads_optional_model_from_environment(
    snapshot_mapping, valid_candidate_text, monkeypatch
):
    monkeypatch.setenv("RIFF_PRESENTER_MODEL", "configured-presenter")
    adapter = FakeAdapter(valid_candidate_text)
    RiffPresenter(adapter).present(snapshot_mapping)
    assert adapter.calls[0]["model"] == "configured-presenter"


def test_presenter_provider_failure_uses_fallback_without_exposing_error(snapshot_mapping):
    class FailingAdapter:
        def call(self, **_kwargs):
            raise TimeoutError("secret provider detail")

    result = RiffPresenter(FailingAdapter()).present(snapshot_mapping)
    serialized = result.model_dump_json()
    assert result.presentation_source == "fallback"
    assert "secret" not in serialized
    assert "provider detail" not in serialized


def _snapshot_with_general(snapshot_mapping):
    snapshot = deepcopy(snapshot_mapping)
    general = deepcopy(snapshot["nodes"][0])
    general.update({"node_id": "general-node", "role": "Specialist", "display_label": "General"})
    general["reasoning_packet"]["role"] = "Specialist"
    general["reasoning_packet"]["uncertainties"] = []
    general["reasoning_packet"]["payload"] = {}
    general["reasoning_packet"]["provenance"]["component_id"] = "general-node"
    snapshot["nodes"].append(general)
    return snapshot


def test_fallback_is_deterministic_schema_valid_and_preserves_node_order(snapshot_mapping):
    snapshot = _snapshot_with_general(snapshot_mapping)
    first = RiffPresenter(FakeAdapter("not json")).present(snapshot)
    second = RiffPresenter(FakeAdapter("not json")).present(snapshot)
    assert first == second
    assert first.presentation_source == "fallback"
    assert first.riff_annotations == []
    assert first.view_model.sections[0].model_dump(mode="json") == {
        "template": "run_summary",
        "node_ids": ["planner-node", "critic-node", "general-node"],
        "heading": None,
        "annotation_ids": [],
        "emphasis": "normal",
    }


def test_fallback_uses_planner_critic_and_general_section_order(snapshot_mapping):
    result = RiffPresenter(FakeAdapter("not json")).present(_snapshot_with_general(snapshot_mapping))
    by_node = {}
    for section in result.view_model.sections[1:]:
        by_node.setdefault(section.node_ids[0], []).append(section.template)
    assert by_node["planner-node"] == ["proposal_details", "node_reasoning", "conflicts_uncertainties", "provenance", "human_review"]
    assert by_node["critic-node"] == ["conflicts_uncertainties", "node_reasoning", "proposal_details", "provenance", "human_review"]
    assert by_node["general-node"] == ["node_reasoning", "proposal_details", "provenance", "human_review"]


def test_fallback_conflicts_use_only_uncertainties_and_string_list_payload(snapshot_mapping):
    result = RiffPresenter(FakeAdapter("bad")).present(snapshot_mapping)
    conflict_nodes = [s.node_ids[0] for s in result.view_model.sections if s.template == "conflicts_uncertainties"]
    assert conflict_nodes == ["planner-node", "critic-node"]


def test_fallback_omits_conflicts_for_unsupported_or_empty_source_fields(snapshot_mapping):
    for node in snapshot_mapping["nodes"]:
        node["reasoning_packet"]["uncertainties"] = []
        node["reasoning_packet"]["payload"]["conflicts"] = {"not": "a string list"}
    result = RiffPresenter(FakeAdapter("bad")).present(snapshot_mapping)
    assert all(s.template != "conflicts_uncertainties" for s in result.view_model.sections)


def test_final_view_inserts_source_and_human_review_for_every_node(
    snapshot_mapping, valid_candidate_text
):
    result = RiffPresenter(FakeAdapter(valid_candidate_text)).present(snapshot_mapping)
    for node_id in ("planner-node", "critic-node"):
        assert sum(s.template == "node_reasoning" and s.node_ids == [node_id] for s in result.view_model.sections) == 1
        assert sum(s.template == "human_review" and s.node_ids == [node_id] for s in result.view_model.sections) == 1
