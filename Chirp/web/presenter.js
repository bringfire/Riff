(function () {
  "use strict";

  var TERMINAL_STATUSES = Object.freeze([
    "accepted",
    "correction_requested",
    "rejected"
  ]);

  var STATUS_BY_ACTION = Object.freeze({
    accept: "accepted",
    request_correction: "correction_requested",
    reject: "rejected"
  });

  var state = {
    snapshotId: "",
    presentation: null,
    matrix: null,
    nodeById: Object.create(null),
    annotationById: Object.create(null),
    reviewByNodeId: Object.create(null),
    submitting: Object.create(null)
  };

  function elem(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function requireObject(value, label) {
    if (!isObject(value)) { throw new Error(label + " must be an object."); }
    return value;
  }

  function requireArray(value, label) {
    if (!Array.isArray(value)) { throw new Error(label + " must be an array."); }
    return value;
  }

  function requireString(value, label) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(label + " must be a nonblank string.");
    }
    return value;
  }

  function requireText(value, label) {
    if (typeof value !== "string") { throw new Error(label + " must be a string."); }
    return value;
  }

  function requireNullableString(value, label) {
    if (value !== null && typeof value !== "string") {
      throw new Error(label + " must be a string or null.");
    }
    return value;
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function addUnique(index, key, value, label) {
    requireString(key, label + " ID");
    if (hasOwn(index, key)) { throw new Error("Duplicate " + label + ": " + key); }
    index[key] = value;
  }

  function requireStringArray(value, label) {
    var result = requireArray(value, label);
    result.forEach(function (item, index) {
      requireString(item, label + "[" + index + "]");
    });
    return result;
  }

  function requireTextArray(value, label) {
    var result = requireArray(value, label);
    result.forEach(function (item, index) {
      requireText(item, label + "[" + index + "]");
    });
    return result;
  }

  function snapshotUrl() {
    return "/api/riff/snapshots/" + encodeURIComponent(state.snapshotId);
  }

  function matrixUrl() {
    return snapshotUrl() + "/matrix";
  }

  function requireJson(response, label) {
    if (!response.ok) { throw new Error(label + " returned " + response.status + "."); }
    return response.json();
  }

  function validatePacket(packet, label) {
    requireObject(packet, label);
    ["stage", "role", "contributor", "proposal", "rationale"].forEach(function (field) {
      requireText(packet[field], label + "." + field);
    });
    requireTextArray(packet.inputs, label + ".inputs");
    requireTextArray(packet.assumptions, label + ".assumptions");
    requireTextArray(packet.uncertainties, label + ".uncertainties");
    requireArray(packet.parameters, label + ".parameters");
    packet.parameters.forEach(function (parameter, index) {
      var itemLabel = label + ".parameters[" + index + "]";
      requireObject(parameter, itemLabel);
      requireText(parameter.name, itemLabel + ".name");
      requireText(parameter.unit, itemLabel + ".unit");
      requireText(parameter.source, itemLabel + ".source");
      if (!hasOwn(parameter, "value")) { throw new Error(itemLabel + ".value is required."); }
    });
    requireObject(packet.payload, label + ".payload");
    requireObject(packet.provenance, label + ".provenance");
    requireText(packet.provenance.run_id, label + ".provenance.run_id");
    requireText(packet.provenance.component_id, label + ".provenance.component_id");
    requireTextArray(
      packet.provenance.parent_packet_ids,
      label + ".provenance.parent_packet_ids"
    );
    return packet;
  }

  function validateStoredDecision(decision, status, label) {
    if (status === "pending") {
      if (decision !== null) { throw new Error(label + " must be null while pending."); }
      return null;
    }
    requireObject(decision, label);
    var expectedStatus = STATUS_BY_ACTION[decision.action];
    if (!expectedStatus || expectedStatus !== status) {
      throw new Error(label + " does not match review status.");
    }
    requireString(decision.reviewer, label + ".reviewer");
    requireNullableString(decision.note, label + ".note");
    requireString(decision.decided_at, label + ".decided_at");
    if ((decision.action === "request_correction" || decision.action === "reject") &&
        (typeof decision.note !== "string" || !decision.note.trim())) {
      throw new Error(label + " requires a nonblank note.");
    }
    return decision;
  }

  function validateReview(review, label) {
    requireObject(review, label);
    requireString(review.packet_id, label + ".packet_id");
    requireString(review.created_at, label + ".created_at");
    if (review.status !== "pending" && TERMINAL_STATUSES.indexOf(review.status) === -1) {
      throw new Error(label + " has an unknown status.");
    }
    validateStoredDecision(review.decision, review.status, label + ".decision");
    return review;
  }

  function validateAnnotation(annotation, label, nodeById) {
    requireObject(annotation, label);
    requireString(annotation.annotation_id, label + ".annotation_id");
    if ([
      "summary",
      "highlight",
      "conflict",
      "uncertainty",
      "review_focus",
      "change_candidate"
    ].indexOf(annotation.kind) === -1) {
      throw new Error(label + " has an unknown kind.");
    }
    requireString(annotation.text, label + ".text");
    if (["informational", "attention", "blocking"].indexOf(annotation.severity) === -1) {
      throw new Error(label + " has an unknown severity.");
    }
    requireArray(annotation.sources, label + ".sources");
    if (!annotation.sources.length) { throw new Error(label + " must cite a source."); }
    annotation.sources.forEach(function (source, sourceIndex) {
      var sourceLabel = label + ".sources[" + sourceIndex + "]";
      requireObject(source, sourceLabel);
      requireString(source.node_id, sourceLabel + ".node_id");
      if (!hasOwn(nodeById, source.node_id)) {
        throw new Error(sourceLabel + " references an unknown node.");
      }
      if (source.scope !== "reasoning_packet" && source.scope !== "node") {
        throw new Error(sourceLabel + " has an unknown scope.");
      }
      requireString(source.field_path, sourceLabel + ".field_path");
    });
    return annotation;
  }

  function validatePresentationEnvelope(presentation) {
    requireObject(presentation, "Snapshot response");
    var snapshot = requireObject(presentation.snapshot, "Snapshot response.snapshot");
    ["canvas_id", "snapshot_id", "run_id", "captured_at"].forEach(function (field) {
      requireString(snapshot[field], "Snapshot response.snapshot." + field);
    });
    var nodes = requireArray(snapshot.nodes, "Snapshot response.snapshot.nodes");
    if (!nodes.length) { throw new Error("Snapshot response contains no nodes."); }

    var nodeById = Object.create(null);
    nodes.forEach(function (node, index) {
      var label = "Snapshot response.snapshot.nodes[" + index + "]";
      requireObject(node, label);
      requireString(node.node_id, label + ".node_id");
      requireString(node.role, label + ".role");
      requireString(node.display_label, label + ".display_label");
      requireStringArray(node.upstream_node_ids, label + ".upstream_node_ids");
      validatePacket(node.reasoning_packet, label + ".reasoning_packet");
      addUnique(nodeById, node.node_id, node, "snapshot node");
    });
    nodes.forEach(function (node) {
      node.upstream_node_ids.forEach(function (upstreamId) {
        if (!hasOwn(nodeById, upstreamId)) {
          throw new Error("Snapshot node references an unknown upstream node.");
        }
      });
    });

    if (presentation.presentation_source !== "intelligent" &&
        presentation.presentation_source !== "fallback") {
      throw new Error("Snapshot response has an unknown presentation source.");
    }

    var viewModel = requireObject(presentation.view_model, "Snapshot response.view_model");
    if (viewModel.schema_version !== "1.0" || viewModel.snapshot_id !== snapshot.snapshot_id) {
      throw new Error("Snapshot response view identity does not match the snapshot.");
    }

    var annotationById = Object.create(null);
    requireArray(presentation.riff_annotations, "Snapshot response.riff_annotations")
      .forEach(function (annotation, index) {
        validateAnnotation(annotation, "Snapshot response.riff_annotations[" + index + "]", nodeById);
        addUnique(annotationById, annotation.annotation_id, annotation, "Riff annotation");
      });

    var mappingByNodeId = Object.create(null);
    requireArray(presentation.node_reviews, "Snapshot response.node_reviews")
      .forEach(function (mapping, index) {
        var label = "Snapshot response.node_reviews[" + index + "]";
        requireObject(mapping, label);
        requireString(mapping.node_id, label + ".node_id");
        requireString(mapping.packet_id, label + ".packet_id");
        if (!hasOwn(nodeById, mapping.node_id)) {
          throw new Error(label + " references an unknown node.");
        }
        addUnique(mappingByNodeId, mapping.node_id, mapping, "node review mapping");
      });
    if (Object.keys(mappingByNodeId).length !== nodes.length) {
      throw new Error("Snapshot response must map every node to one review.");
    }

    var sections = requireArray(viewModel.sections, "Snapshot response.view_model.sections");
    if (!sections.length) { throw new Error("Snapshot response contains no presentation sections."); }
    sections.forEach(function (section, index) {
      var label = "Snapshot response.view_model.sections[" + index + "]";
      requireObject(section, label);
      if (!hasOwn(TEMPLATE_RENDERERS, section.template)) {
        throw new Error(label + " uses an unknown template.");
      }
      if (section.heading !== null) {
        requireString(section.heading, label + ".heading");
      }
      if (section.emphasis !== "normal" && section.emphasis !== "high") {
        throw new Error(label + " uses an unknown emphasis.");
      }
      var seenNodes = Object.create(null);
      var sectionNodes = requireStringArray(section.node_ids, label + ".node_ids");
      if (!sectionNodes.length) { throw new Error(label + " must reference a node."); }
      sectionNodes.forEach(function (nodeId) {
        if (!hasOwn(nodeById, nodeId) || hasOwn(seenNodes, nodeId)) {
          throw new Error(label + " has an invalid node reference.");
        }
        seenNodes[nodeId] = true;
      });
      var seenAnnotations = Object.create(null);
      requireStringArray(section.annotation_ids, label + ".annotation_ids")
        .forEach(function (annotationId) {
          if (!hasOwn(annotationById, annotationId) || hasOwn(seenAnnotations, annotationId)) {
            throw new Error(label + " has an invalid annotation reference.");
          }
          seenAnnotations[annotationId] = true;
        });
    });

    return {
      snapshot: snapshot,
      nodeById: nodeById,
      annotationById: annotationById,
      mappingByNodeId: mappingByNodeId
    };
  }

  function validateMatrix(matrix, presentationData) {
    requireObject(matrix, "Review Matrix");
    if (matrix.schema_version !== "1.0" ||
        matrix.snapshot_id !== presentationData.snapshot.snapshot_id ||
        matrix.canvas_id !== presentationData.snapshot.canvas_id ||
        matrix.run_id !== presentationData.snapshot.run_id ||
        matrix.captured_at !== presentationData.snapshot.captured_at) {
      throw new Error("Review Matrix identity does not match the snapshot.");
    }
    requireString(matrix.exported_at, "Review Matrix.exported_at");
    if (matrix.presentation_source !== state.presentation.presentation_source) {
      throw new Error("Review Matrix presentation source does not match.");
    }
    if (typeof matrix.review_complete !== "boolean") {
      throw new Error("Review Matrix completion state is invalid.");
    }
    if (JSON.stringify(matrix.riff_annotations) !==
        JSON.stringify(state.presentation.riff_annotations)) {
      throw new Error("Review Matrix annotations do not match the immutable presentation.");
    }

    var matrixNodes = requireArray(matrix.nodes, "Review Matrix.nodes");
    var snapshotNodes = presentationData.snapshot.nodes;
    if (matrixNodes.length !== snapshotNodes.length) {
      throw new Error("Review Matrix node count does not match the snapshot.");
    }

    var reviewByNodeId = Object.create(null);
    matrixNodes.forEach(function (node, index) {
      var label = "Review Matrix.nodes[" + index + "]";
      requireObject(node, label);
      if (node.node_id !== snapshotNodes[index].node_id) {
        throw new Error("Review Matrix node order does not match the snapshot.");
      }
      if (node.role !== snapshotNodes[index].role ||
          node.display_label !== snapshotNodes[index].display_label ||
          JSON.stringify(node.upstream_node_ids) !==
            JSON.stringify(snapshotNodes[index].upstream_node_ids) ||
          JSON.stringify(node.reasoning_packet) !==
            JSON.stringify(snapshotNodes[index].reasoning_packet)) {
        throw new Error("Review Matrix immutable node data does not match the snapshot.");
      }
      validatePacket(node.reasoning_packet, label + ".reasoning_packet");
      var review = validateReview(node.review, label + ".review");
      var mapping = presentationData.mappingByNodeId[node.node_id];
      if (!mapping || review.packet_id !== mapping.packet_id) {
        throw new Error("Review Matrix packet mapping does not match the snapshot.");
      }
      addUnique(reviewByNodeId, node.node_id, review, "matrix review");
    });

    var complete = matrixNodes.every(function (node) {
      return node.review.status !== "pending";
    });
    if (matrix.review_complete !== complete) {
      throw new Error("Review Matrix completion state contradicts its reviews.");
    }
    return reviewByNodeId;
  }

  function indexResponse() {
    var presentationData = validatePresentationEnvelope(state.presentation);
    var reviewByNodeId = validateMatrix(state.matrix, presentationData);
    state.nodeById = presentationData.nodeById;
    state.annotationById = presentationData.annotationById;
    state.reviewByNodeId = reviewByNodeId;
  }

  function clearError() {
    var error = document.getElementById("errorState");
    error.textContent = "";
    error.hidden = true;
  }

  function showError(message) {
    var error = document.getElementById("errorState");
    error.textContent = message;
    error.hidden = false;
  }

  function oneNode(section) {
    if (section.node_ids.length !== 1 || !state.nodeById[section.node_ids[0]]) {
      throw new Error("Template requires one known node.");
    }
    return state.nodeById[section.node_ids[0]];
  }

  function card(section, defaultHeading) {
    var node = elem("section", "review-section emphasis-" + section.emphasis);
    node.appendChild(elem("h2", null, section.heading || defaultHeading));
    return node;
  }

  function appendList(parent, label, values) {
    parent.appendChild(elem("h3", null, label));
    var list = elem("ul", "source-list");
    (values || []).forEach(function (value) {
      list.appendChild(elem("li", null, value));
    });
    if (!list.childNodes.length) {
      list.appendChild(elem("li", null, "None declared."));
    }
    parent.appendChild(list);
  }

  function appendAnnotations(parent, section) {
    section.annotation_ids.forEach(function (annotationId) {
      var annotation = state.annotationById[annotationId];
      if (!annotation) { throw new Error("Unknown annotation reference."); }
      var box = elem("aside", "riff-annotation");
      var label = annotation.kind === "summary" ? "Riff summary" :
        (annotation.kind === "highlight" ? "Riff highlight" : "Riff assessment");
      box.appendChild(elem("strong", null, label));
      box.appendChild(elem(
        "span",
        "riff-priority",
        "Riff assessment: " + annotation.severity
      ));
      box.appendChild(elem("p", null, annotation.text));
      box.appendChild(elem(
        "p",
        "source-reference",
        annotation.sources.map(function (source) {
          return source.node_id + " · " + source.scope + " " + source.field_path;
        }).join("; ")
      ));
      parent.appendChild(box);
    });
  }

  function renderRunSummary(section) {
    var snapshot = state.presentation.snapshot;
    var node = card(section, "Run summary");
    node.appendChild(elem(
      "p",
      null,
      "Canvas " + snapshot.canvas_id + " · run " + snapshot.run_id +
      " · captured " + snapshot.captured_at + " · " + snapshot.nodes.length + " nodes"
    ));
    appendAnnotations(node, section);
    return node;
  }

  function renderNodeReasoning(section) {
    var source = oneNode(section);
    var packet = source.reasoning_packet;
    var node = card(section, source.display_label + " reasoning");
    node.appendChild(elem("p", "source-label", "Source reasoning"));
    node.appendChild(elem("p", null, packet.rationale));
    var details = elem("details", "source-packet");
    details.appendChild(elem("summary", null, "Complete immutable ReviewPacket"));
    details.appendChild(elem("pre", null, JSON.stringify(packet, null, 2)));
    node.appendChild(details);
    appendAnnotations(node, section);
    return node;
  }

  function renderProposalDetails(section) {
    var source = oneNode(section);
    var packet = source.reasoning_packet;
    var node = card(section, source.display_label + " proposal");
    node.appendChild(elem("p", null, packet.proposal));
    appendList(node, "Inputs", packet.inputs);
    appendList(node, "Assumptions", packet.assumptions);
    node.appendChild(elem("h3", null, "Parameters"));
    node.appendChild(elem("pre", null, JSON.stringify(packet.parameters, null, 2)));
    node.appendChild(elem("h3", null, "Payload"));
    node.appendChild(elem("pre", null, JSON.stringify(packet.payload, null, 2)));
    appendAnnotations(node, section);
    return node;
  }

  function renderConflictsUncertainties(section) {
    var node = card(section, "Conflicts and uncertainties");
    section.node_ids.forEach(function (nodeId) {
      var source = state.nodeById[nodeId];
      if (!source) { throw new Error("Unknown node reference."); }
      appendList(
        node,
        source.display_label + " uncertainties",
        source.reasoning_packet.uncertainties
      );
      var conflicts = source.reasoning_packet.payload.conflicts;
      if (Array.isArray(conflicts) &&
          conflicts.every(function (item) { return typeof item === "string"; })) {
        appendList(node, source.display_label + " conflicts", conflicts);
      }
    });
    appendAnnotations(node, section);
    return node;
  }

  function renderProvenance(section) {
    var source = oneNode(section);
    var packet = source.reasoning_packet;
    var node = card(section, source.display_label + " provenance");
    node.appendChild(elem("pre", null, JSON.stringify({
      role: packet.role,
      contributor: packet.contributor,
      provenance: packet.provenance
    }, null, 2)));
    appendAnnotations(node, section);
    return node;
  }

  function renderHumanReview(section) {
    var source = oneNode(section);
    var review = state.reviewByNodeId[source.node_id];
    if (!review) { throw new Error("Missing human review mapping."); }
    var node = card(section, source.display_label + " human review");
    node.appendChild(elem("p", "human-status", "Status: " + review.status));
    if (review.decision) {
      node.appendChild(elem("p", null, "Reviewer: " + review.decision.reviewer));
      node.appendChild(elem("p", null, "Note: " + (review.decision.note || "None")));
    } else {
      node.appendChild(buildReviewControls(source.node_id, review));
    }
    return node;
  }

  var TEMPLATE_RENDERERS = Object.freeze({
    run_summary: renderRunSummary,
    node_reasoning: renderNodeReasoning,
    proposal_details: renderProposalDetails,
    conflicts_uncertainties: renderConflictsUncertainties,
    provenance: renderProvenance,
    human_review: renderHumanReview
  });

  function renderNodeIndex() {
    var container = document.getElementById("nodeIndex");
    container.replaceChildren();
    state.presentation.snapshot.nodes.forEach(function (node) {
      var review = state.reviewByNodeId[node.node_id];
      var cardNode = elem("article", "node-card");
      var head = elem("div", "node-card-head");
      head.appendChild(elem("span", "node-id", node.node_id));
      head.appendChild(elem("span", "status-dot status-" + review.status));
      cardNode.appendChild(head);
      cardNode.appendChild(elem("span", "node-role", node.role));
      cardNode.appendChild(elem("span", "node-label", node.display_label));
      container.appendChild(cardNode);
    });
    document.getElementById("nodeCount").textContent =
      state.presentation.snapshot.nodes.length + " nodes";
  }

  function renderSnapshotMeta() {
    var snapshot = state.presentation.snapshot;
    document.getElementById("snapshotId").textContent = snapshot.snapshot_id;
    document.getElementById("canvasId").textContent = snapshot.canvas_id;
    document.getElementById("runId").textContent = snapshot.run_id;
    document.getElementById("capturedAt").textContent = snapshot.captured_at;
    document.getElementById("reviewComplete").textContent = state.matrix.review_complete ?
      "All node reviews are terminal" : "Review in progress";
    document.getElementById("reviewCompletionDot").className =
      "status-dot " + (state.matrix.review_complete ? "status-accepted" : "status-pending");
  }

  function renderPresentation() {
    clearError();
    var container = document.getElementById("presentation");
    container.replaceChildren();
    state.presentation.view_model.sections.forEach(function (section) {
      var renderer = TEMPLATE_RENDERERS[section.template];
      if (!renderer) { throw new Error("Unknown trusted template."); }
      container.appendChild(renderer(section));
    });
    document.getElementById("presentationSource").textContent =
      "presentation_source: " + state.presentation.presentation_source;
    document.getElementById("loadingState").hidden = true;
    container.hidden = false;
    renderNodeIndex();
    renderSnapshotMeta();
  }

  function formLabel(text, control) {
    var label = elem("label", null, text);
    label.appendChild(control);
    return label;
  }

  function buildReviewControls(nodeId, review) {
    var form = elem("form", "human-controls");
    form.addEventListener("submit", function (event) { event.preventDefault(); });

    var reviewer = document.createElement("input");
    reviewer.type = "text";
    reviewer.autocomplete = "name";
    reviewer.placeholder = "Reviewer name";

    var note = document.createElement("textarea");
    note.placeholder = "Optional for accept; required for correction or reject";

    form.appendChild(formLabel("Reviewer name", reviewer));
    form.appendChild(formLabel("Review note", note));

    [
      ["accept", "Accept"],
      ["request_correction", "Request correction"],
      ["reject", "Reject"]
    ].forEach(function (choice) {
      var button = elem("button", "decision-" + choice[0], choice[1]);
      button.type = "button";
      button.disabled = Boolean(state.submitting[nodeId]);
      button.addEventListener("click", function () {
        submitDecision(nodeId, review, choice[0], reviewer, note);
      });
      form.appendChild(button);
    });
    return form;
  }

  function validateDecisionResponse(value, expectedPacketId, expectedAction) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Decision API returned a non-object response.");
    }
    if (value.packet_id !== expectedPacketId || typeof value.created_at !== "string") {
      throw new Error("Decision API returned the wrong review identity.");
    }
    var decision = value.decision;
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      throw new Error("Decision API omitted the decision record.");
    }
    if (decision.action !== expectedAction ||
        !Object.prototype.hasOwnProperty.call(STATUS_BY_ACTION, decision.action) ||
        value.status !== STATUS_BY_ACTION[decision.action]) {
      throw new Error("Decision API returned an invalid terminal status.");
    }
    if (typeof decision.reviewer !== "string" || !decision.reviewer.trim() ||
        typeof decision.decided_at !== "string" || !decision.decided_at.trim()) {
      throw new Error("Decision API returned invalid reviewer attribution.");
    }
    if (decision.note !== null && typeof decision.note !== "string") {
      throw new Error("Decision API returned an invalid note.");
    }
    if ((decision.action === "request_correction" || decision.action === "reject") &&
        (typeof decision.note !== "string" || !decision.note.trim())) {
      throw new Error("Decision API omitted the required note.");
    }
    return {
      packet_id: value.packet_id,
      created_at: value.created_at,
      status: value.status,
      decision: {
        action: decision.action,
        reviewer: decision.reviewer,
        note: decision.note,
        decided_at: decision.decided_at
      }
    };
  }

  function setDecisionControlsDisabled(input, disabled) {
    var form = input.form;
    if (!form) { return; }
    Array.prototype.forEach.call(form.querySelectorAll("button"), function (button) {
      button.disabled = disabled;
    });
  }

  function submitDecision(nodeId, review, action, reviewerInput, noteInput) {
    if (state.submitting[nodeId]) { return; }
    clearError();
    var reviewer = reviewerInput.value.trim();
    var note = noteInput.value.trim();
    if (!reviewer) { showError("Reviewer name is required."); return; }
    if ((action === "request_correction" || action === "reject") && !note) {
      showError("A note is required for correction or rejection.");
      return;
    }
    var body = { action: action, reviewer: reviewer };
    if (note) { body.note = note; }
    state.submitting[nodeId] = true;
    setDecisionControlsDisabled(reviewerInput, true);
    fetch("/reviews/" + encodeURIComponent(review.packet_id) + "/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    }).then(function (response) {
      return requireJson(response, "Decision API");
    }).then(function (updated) {
      var validated = validateDecisionResponse(updated, review.packet_id, action);
      state.reviewByNodeId[nodeId] = validated;
      renderPresentation();
    }).catch(function (error) {
      showError("Could not record the decision: " + error.message);
      setDecisionControlsDisabled(reviewerInput, false);
    }).then(function () {
      delete state.submitting[nodeId];
    });
  }

  function refreshMatrix() {
    if (!state.snapshotId || !state.presentation) { return Promise.resolve(); }
    clearError();
    var button = document.getElementById("refreshMatrix");
    button.disabled = true;
    return fetch(matrixUrl(), {
      headers: { "Accept": "application/json" },
      cache: "no-store"
    }).then(function (response) {
      return requireJson(response, "Matrix API");
    }).then(function (matrix) {
      var presentationData = validatePresentationEnvelope(state.presentation);
      var reviews = validateMatrix(matrix, presentationData);
      state.matrix = matrix;
      state.reviewByNodeId = reviews;
      renderPresentation();
    }).catch(function (error) {
      showError("Could not refresh the Review Matrix: " + error.message);
    }).then(function () {
      button.disabled = false;
    });
  }

  function downloadMatrix() {
    if (!state.snapshotId) { return; }
    clearError();
    var button = document.getElementById("downloadMatrix");
    button.disabled = true;
    fetch(matrixUrl(), {
      headers: { "Accept": "application/json" },
      cache: "no-store"
    }).then(function (response) {
      if (!response.ok) { throw new Error("Matrix API returned " + response.status + "."); }
      return response.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "riff-review-matrix-" + state.snapshotId + ".json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }).catch(function (error) {
      showError("Could not download the Review Matrix: " + error.message);
    }).then(function () {
      button.disabled = false;
    });
  }

  function loadPresentation() {
    state.snapshotId = (
      new URLSearchParams(window.location.search).get("snapshot_id") || ""
    ).trim();
    if (!state.snapshotId) {
      document.getElementById("loadingState").hidden = true;
      showError("A snapshot_id query parameter is required.");
      return Promise.resolve();
    }
    clearError();
    return Promise.all([
      fetch(snapshotUrl(), {
        headers: { "Accept": "application/json" },
        cache: "no-store"
      }).then(function (response) { return requireJson(response, "Snapshot API"); }),
      fetch(matrixUrl(), {
        headers: { "Accept": "application/json" },
        cache: "no-store"
      }).then(function (response) { return requireJson(response, "Matrix API"); })
    ]).then(function (values) {
      state.presentation = values[0];
      state.matrix = values[1];
      indexResponse();
      renderPresentation();
    }).catch(function (error) {
      state.presentation = null;
      state.matrix = null;
      document.getElementById("loadingState").hidden = true;
      document.getElementById("presentation").hidden = true;
      showError("Could not load the Riff presentation: " + error.message);
    });
  }

  document.getElementById("refreshMatrix").addEventListener("click", refreshMatrix);
  document.getElementById("downloadMatrix").addEventListener("click", downloadMatrix);
  document.addEventListener("DOMContentLoaded", loadPresentation);
}());
