/* Riff review workbench.
 *
 * Talks to the frozen review API described in ARCHITECTURE.md:
 *   GET  /reviews?status=pending
 *   POST /reviews/{packet_id}/decision
 *
 * Same-origin relative URLs only, so no CORS is needed. No dependencies,
 * no build step. `?mock=1` runs the whole UI against a checked-in fixture
 * with no backend at all.
 */

(function () {
  "use strict";

  var POLL_MS = 2000;
  var API_REVIEWS = "/reviews";
  var MOCK_URL = "mock/pending-reviews.json";

  var IS_MOCK = new URLSearchParams(window.location.search).get("mock") === "1";

  var state = {
    reviews: [],          // pending packets currently shown
    selectedId: null,
    decided: {},          // packet_id -> true, hides packets we have decided
    loadedOnce: false,
    submitting: false
  };

  // ---------- element handles ----------

  var el = {
    queueList:     document.getElementById("queueList"),
    queueLoading:  document.getElementById("queueLoading"),
    queueEmpty:    document.getElementById("queueEmpty"),
    queueError:    document.getElementById("queueError"),
    queueCount:    document.getElementById("queueCount"),

    detail:        document.getElementById("detail"),
    detailEmpty:   document.getElementById("detailEmpty"),
    detailId:      document.getElementById("detailId"),

    decisionForm:  document.getElementById("decisionForm"),
    decisionEmpty: document.getElementById("decisionEmpty"),
    reviewer:      document.getElementById("reviewer"),
    note:          document.getElementById("note"),
    noteReq:       document.getElementById("noteReq"),
    formError:     document.getElementById("formError"),

    connState:     document.getElementById("connState"),
    connText:      document.getElementById("connText"),
    mockBadge:     document.getElementById("mockBadge"),
    toast:         document.getElementById("toast")
  };

  // ---------- small helpers ----------

  function show(node, visible) {
    if (node) { node.hidden = !visible; }
  }

  function setConn(kind, text) {
    el.connState.setAttribute("data-state", kind);
    el.connText.textContent = text;
  }

  var toastTimer = null;
  function toast(kind, message) {
    el.toast.textContent = message;
    el.toast.setAttribute("data-kind", kind);
    show(el.toast, true);
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { show(el.toast, false); }, 4200);
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return iso; }
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    var ss = String(d.getSeconds()).padStart(2, "0");
    return hh + ":" + mm + ":" + ss;
  }

  function shortId(id) {
    return typeof id === "string" ? id.slice(0, 8) : String(id);
  }

  /* Build an element with text content. Using textContent throughout means
     packet strings from the model are never parsed as markup. */
  function elem(tag, className, text) {
    var n = document.createElement(tag);
    if (className) { n.className = className; }
    if (text !== undefined && text !== null) { n.textContent = String(text); }
    return n;
  }

  function listBlock(title, items, extraClass) {
    var wrap = elem("div", "block" + (extraClass ? " " + extraClass : ""));
    wrap.appendChild(elem("h3", null, title));
    if (!items || !items.length) {
      wrap.appendChild(elem("p", "state-sub", "None declared."));
      return wrap;
    }
    var ul = document.createElement("ul");
    items.forEach(function (item) { ul.appendChild(elem("li", null, item)); });
    wrap.appendChild(ul);
    return wrap;
  }

  function textBlock(title, body) {
    var wrap = elem("div", "block");
    wrap.appendChild(elem("h3", null, title));
    wrap.appendChild(elem("p", "rationale", body));
    return wrap;
  }

  // ---------- queue rendering ----------

  function visibleReviews() {
    return state.reviews.filter(function (r) { return !state.decided[r.packet_id]; });
  }

  function renderQueue() {
    var items = visibleReviews();
    el.queueCount.textContent = items.length;

    show(el.queueLoading, !state.loadedOnce);
    if (!state.loadedOnce) {
      show(el.queueList, false);
      show(el.queueEmpty, false);
      return;
    }

    show(el.queueEmpty, items.length === 0);
    show(el.queueList, items.length > 0);

    el.queueList.textContent = "";

    items.forEach(function (r) {
      var p = r.packet || {};
      var li = document.createElement("li");

      var btn = document.createElement("button");
      btn.type = "button";
      if (r.packet_id === state.selectedId) {
        btn.setAttribute("aria-current", "true");
      }

      var roleRow = elem("div", "q-role");
      roleRow.appendChild(elem("span", null, p.role || "unknown role"));
      if (p.stage) { roleRow.appendChild(elem("span", "q-stage", p.stage)); }
      btn.appendChild(roleRow);

      btn.appendChild(elem("p", "q-proposal", p.proposal || ""));
      btn.appendChild(elem("div", "q-meta",
        shortId(r.packet_id) + "  ·  " + fmtTime(r.created_at)));

      btn.addEventListener("click", function () { select(r.packet_id); });

      li.appendChild(btn);
      el.queueList.appendChild(li);
    });
  }

  // ---------- detail rendering ----------

  function findReview(id) {
    for (var i = 0; i < state.reviews.length; i++) {
      if (state.reviews[i].packet_id === id) { return state.reviews[i]; }
    }
    return null;
  }

  function renderDetail() {
    var r = state.selectedId ? findReview(state.selectedId) : null;

    if (!r || state.decided[r.packet_id]) {
      show(el.detailEmpty, true);
      show(el.detail, false);
      el.detailId.textContent = "";
      return;
    }

    show(el.detailEmpty, false);
    show(el.detail, true);
    el.detailId.textContent = r.packet_id;

    var p = r.packet || {};
    el.detail.textContent = "";

    // header: role, stage, contributor
    var head = elem("div", "detail-head");
    var roleRow = elem("div", "detail-role");
    roleRow.appendChild(elem("span", "role", p.role || "unknown role"));
    if (p.stage) { roleRow.appendChild(elem("span", "q-stage", p.stage)); }
    head.appendChild(roleRow);
    head.appendChild(elem("div", "detail-contributor",
      (p.contributor || "unknown contributor") + "  ·  submitted " + fmtTime(r.created_at)));
    head.appendChild(elem("p", "proposal", p.proposal || ""));
    el.detail.appendChild(head);

    // inputs / assumptions
    el.detail.appendChild(listBlock("Inputs", p.inputs));
    el.detail.appendChild(listBlock("Assumptions", p.assumptions));

    // parameters table
    var paramWrap = elem("div", "block");
    paramWrap.appendChild(elem("h3", null, "Parameters"));
    if (p.parameters && p.parameters.length) {
      var scroll = elem("div", "table-scroll");
      var table = elem("table", "params");

      var thead = document.createElement("thead");
      var hrow = document.createElement("tr");
      ["Name", "Value", "Unit", "Source"].forEach(function (h) {
        hrow.appendChild(elem("th", null, h));
      });
      thead.appendChild(hrow);
      table.appendChild(thead);

      var tbody = document.createElement("tbody");
      p.parameters.forEach(function (param) {
        var tr = document.createElement("tr");
        tr.appendChild(elem("td", "name", param.name));
        var v = param.value;
        tr.appendChild(elem("td", "value",
          (v !== null && typeof v === "object") ? JSON.stringify(v) : v));
        tr.appendChild(elem("td", "unit", param.unit));
        tr.appendChild(elem("td", "source", param.source));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);

      scroll.appendChild(table);
      paramWrap.appendChild(scroll);
    } else {
      paramWrap.appendChild(elem("p", "state-sub", "None declared."));
    }
    el.detail.appendChild(paramWrap);

    // rationale
    el.detail.appendChild(textBlock("Rationale", p.rationale || ""));

    // uncertainties
    el.detail.appendChild(listBlock("Uncertainties", p.uncertainties, "block-uncertain"));

    // provenance
    var prov = p.provenance || {};
    var provWrap = elem("div", "block");
    provWrap.appendChild(elem("h3", null, "Provenance"));
    var dl = elem("dl", "prov");
    dl.appendChild(elem("dt", null, "Run"));
    dl.appendChild(elem("dd", null, prov.run_id || "—"));
    dl.appendChild(elem("dt", null, "Component"));
    dl.appendChild(elem("dd", null, prov.component_id || "—"));
    dl.appendChild(elem("dt", null, "Parents"));
    if (prov.parent_packet_ids && prov.parent_packet_ids.length) {
      dl.appendChild(elem("dd", null, prov.parent_packet_ids.join(", ")));
    } else {
      dl.appendChild(elem("dd", "none", "No parent packets — this starts a chain."));
    }
    dl.appendChild(elem("dt", null, "Packet"));
    dl.appendChild(elem("dd", null, r.packet_id));
    provWrap.appendChild(dl);
    el.detail.appendChild(provWrap);

    // payload
    if (p.payload && Object.keys(p.payload).length) {
      var payWrap = elem("div", "block");
      payWrap.appendChild(elem("h3", null, "Payload"));
      payWrap.appendChild(elem("pre", "payload", JSON.stringify(p.payload, null, 2)));
      el.detail.appendChild(payWrap);
    }
  }

  // ---------- decision panel ----------

  function renderDecision() {
    var active = state.selectedId && findReview(state.selectedId) &&
                 !state.decided[state.selectedId];
    show(el.decisionEmpty, !active);
    show(el.decisionForm, !!active);
  }

  function clearFormError() {
    show(el.formError, false);
    el.reviewer.removeAttribute("aria-invalid");
    el.note.removeAttribute("aria-invalid");
  }

  function failForm(message, field) {
    el.formError.textContent = message;
    show(el.formError, true);
    if (field) {
      field.setAttribute("aria-invalid", "true");
      field.focus();
    }
  }

  function setButtonsDisabled(disabled) {
    var btns = el.decisionForm.querySelectorAll("button[data-action]");
    for (var i = 0; i < btns.length; i++) { btns[i].disabled = disabled; }
  }

  function select(id) {
    state.selectedId = id;
    clearFormError();
    el.note.value = "";
    renderQueue();
    renderDetail();
    renderDecision();
  }

  // ---------- data loading ----------

  function applyReviews(list) {
    state.reviews = Array.isArray(list) ? list : [];
    state.loadedOnce = true;

    // Drop a selection that the server no longer reports as pending.
    if (state.selectedId && !findReview(state.selectedId)) {
      state.selectedId = null;
    }
    // Auto-select the first packet so the reviewer always has something open.
    if (!state.selectedId) {
      var vis = visibleReviews();
      if (vis.length) { state.selectedId = vis[0].packet_id; }
    }

    renderQueue();
    renderDetail();
    renderDecision();
  }

  function loadMock() {
    return fetch(MOCK_URL, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) { throw new Error("mock fixture returned " + res.status); }
        return res.json();
      })
      .then(function (data) {
        show(el.queueError, false);
        setConn("mock", "Mock fixture");
        applyReviews(data.reviews);
      })
      .catch(function (err) {
        setConn("error", "Mock failed");
        state.loadedOnce = true;
        el.queueError.textContent = "Could not load the mock fixture: " + err.message;
        show(el.queueError, true);
        renderQueue();
      });
  }

  function loadLive() {
    return fetch(API_REVIEWS + "?status=pending", {
      headers: { "Accept": "application/json" },
      cache: "no-store"
    })
      .then(function (res) {
        if (!res.ok) { throw new Error("API returned " + res.status); }
        return res.json();
      })
      .then(function (data) {
        show(el.queueError, false);
        setConn("live", "Live · polling every 2s");
        applyReviews(data.reviews);
      })
      .catch(function (err) {
        setConn("error", "Disconnected");
        state.loadedOnce = true;
        el.queueError.textContent =
          "Cannot reach the review API (" + err.message +
          "). Retrying every 2s. Start Chirp on port 9900, or append ?mock=1 to work offline.";
        show(el.queueError, true);
        renderQueue();
      });
  }

  var load = IS_MOCK ? loadMock : loadLive;

  // ---------- submitting a decision ----------

  function submitDecision(action) {
    if (state.submitting) { return; }

    var id = state.selectedId;
    if (!id) { return; }

    clearFormError();

    var reviewer = el.reviewer.value.trim();
    var note = el.note.value.trim();

    if (!reviewer) {
      failForm("Enter your name before recording a decision.", el.reviewer);
      return;
    }
    if ((action === "request_correction" || action === "reject") && !note) {
      failForm(
        action === "reject"
          ? "A note is required to reject a packet. Say what is wrong."
          : "A note is required to request a correction. Say what needs to change.",
        el.note
      );
      return;
    }

    var body = { action: action, reviewer: reviewer };
    if (note) { body.note = note; }

    state.submitting = true;
    setButtonsDisabled(true);

    // Mock mode has no backend, so resolve the decision locally.
    if (IS_MOCK) {
      setTimeout(function () {
        state.decided[id] = true;
        state.selectedId = null;
        state.submitting = false;
        setButtonsDisabled(false);
        el.note.value = "";
        toast("success", "Recorded " + label(action) + " (mock — nothing was sent).");
        applyReviews(state.reviews);
      }, 220);
      return;
    }

    fetch(API_REVIEWS + "/" + encodeURIComponent(id) + "/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (payload) {
          if (res.ok) { return payload; }

          var detail = payload && payload.detail;
          if (res.status === 409) {
            throw new Error("This packet was already decided by someone else.");
          }
          if (res.status === 422) {
            throw new Error(
              typeof detail === "string" ? detail : "The API rejected this decision as invalid."
            );
          }
          if (res.status === 404) {
            throw new Error("This packet no longer exists on the server.");
          }
          throw new Error(
            (typeof detail === "string" ? detail : "Request failed") + " (HTTP " + res.status + ")"
          );
        });
      })
      .then(function () {
        state.decided[id] = true;
        state.selectedId = null;
        el.note.value = "";
        toast("success", "Recorded " + label(action) + ".");
        applyReviews(state.reviews);
        load();
      })
      .catch(function (err) {
        failForm(err.message);
        toast("error", err.message);
        // A 409 means it is gone from pending regardless; let the next poll settle it.
        load();
      })
      .then(function () {
        state.submitting = false;
        setButtonsDisabled(false);
      });
  }

  function label(action) {
    if (action === "accept") { return "acceptance"; }
    if (action === "reject") { return "rejection"; }
    return "correction request";
  }

  // ---------- wiring ----------

  el.decisionForm.addEventListener("submit", function (e) { e.preventDefault(); });

  el.decisionForm.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-action]");
    if (btn) { submitDecision(btn.getAttribute("data-action")); }
  });

  // Surface the note requirement as soon as the reviewer starts typing one.
  el.note.addEventListener("input", clearFormError);
  el.reviewer.addEventListener("input", clearFormError);
  show(el.noteReq, true);

  if (IS_MOCK) {
    show(el.mockBadge, true);
    setConn("mock", "Mock fixture");
  }

  // Initial paint, then poll.
  renderQueue();
  renderDetail();
  renderDecision();
  load();
  setInterval(load, POLL_MS);
})();
