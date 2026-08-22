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
    noteForId: null,      // packet the text in the note box was written for
    decided: {},          // packet_id -> true, hides packets we have decided
    loadedOnce: false,
    submitting: false,

    /* Repaint guards. The reviewer reads and types while the poll runs, so a
       pane is only rebuilt when its content actually changed. */
    queueSig: null,       // signature of the queue as currently painted
    renderedDetailId: null,

    polling: false,       // a poll is in flight
    pollSeq: 0,           // increments per poll
    appliedSeq: 0         // highest poll already applied to the DOM
  };

  // Queue buttons by packet_id, so selection and focus survive a quiet poll.
  var queueButtons = {};

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

  /* What the queue currently shows. If this is unchanged, the DOM is left
     alone: rebuilding it would remove the focused button and drop keyboard
     focus to <body> every two seconds. */
  function queueSignature(items) {
    // Stringified rather than concatenated, so no field can spoof a boundary.
    return JSON.stringify(items.map(function (r) {
      var p = r.packet || {};
      return [r.packet_id, p.role, p.stage, p.proposal, r.created_at];
    }));
  }

  function markSelectedInQueue() {
    Object.keys(queueButtons).forEach(function (id) {
      if (id === state.selectedId) {
        queueButtons[id].setAttribute("aria-current", "true");
      } else {
        queueButtons[id].removeAttribute("aria-current");
      }
    });
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

    // Selection moves without a rebuild; only the queue's contents force one.
    var sig = queueSignature(items);
    if (sig === state.queueSig) {
      markSelectedInQueue();
      return;
    }
    state.queueSig = sig;

    // A genuine rebuild must not strand a keyboard user mid-queue.
    var focusedId = null;
    if (document.activeElement && el.queueList.contains(document.activeElement)) {
      focusedId = document.activeElement.getAttribute("data-packet-id");
    }

    queueButtons = {};
    el.queueList.textContent = "";

    items.forEach(function (r) {
      var p = r.packet || {};
      var li = document.createElement("li");

      var btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-packet-id", r.packet_id);
      queueButtons[r.packet_id] = btn;

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

    markSelectedInQueue();

    if (focusedId && queueButtons[focusedId]) {
      queueButtons[focusedId].focus();
    }
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
      state.renderedDetailId = null;
      return;
    }

    show(el.detailEmpty, false);
    show(el.detail, true);
    el.detailId.textContent = r.packet_id;

    /* A submitted packet is immutable, so the same packet_id always renders
       the same content. Rebuilding it on every poll would throw away the
       reader's scroll position and any text they had selected. */
    if (state.renderedDetailId === r.packet_id) { return; }
    state.renderedDetailId = r.packet_id;

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

  /* The single place the selection changes. Every change clears the note and
     records which packet the empty note now belongs to. A note written for
     one packet must never follow the selection to another: decisions are
     terminal and immutable, so a misattributed note cannot be taken back. */
  function setSelection(id) {
    state.selectedId = id;
    state.noteForId = id;
    el.note.value = "";
    clearFormError();
  }

  function select(id) {
    setSelection(id);
    renderQueue();
    renderDetail();
    renderDecision();
  }

  // ---------- data loading ----------

  function applyReviews(list) {
    state.reviews = Array.isArray(list) ? list : [];
    state.loadedOnce = true;

    // Drop a selection that the server no longer reports as pending. Say so
    // out loud if that discards work, rather than silently moving the note.
    if (state.selectedId && !findReview(state.selectedId)) {
      if (el.note.value.trim()) {
        toast("error", "The packet you were reviewing left the queue. " +
                       "Your unsent note was discarded.");
      }
      setSelection(null);
    }
    // Auto-select the first packet so the reviewer always has something open.
    if (!state.selectedId) {
      var vis = visibleReviews();
      if (vis.length) { setSelection(vis[0].packet_id); }
    }

    renderQueue();
    renderDetail();
    renderDecision();
  }

  /* True when this response is the newest one seen. An older response that
     arrives late must be dropped, not applied, or it reverts the queue. */
  function isFreshest(seq) {
    if (seq <= state.appliedSeq) { return false; }
    state.appliedSeq = seq;
    return true;
  }

  function loadMock(seq) {
    return fetch(MOCK_URL, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) { throw new Error("mock fixture returned " + res.status); }
        return res.json();
      })
      .then(function (data) {
        if (!isFreshest(seq)) { return; }
        show(el.queueError, false);
        setConn("mock", "Mock fixture");
        applyReviews(data.reviews);
      })
      .catch(function (err) {
        if (!isFreshest(seq)) { return; }
        setConn("error", "Mock failed");
        state.loadedOnce = true;
        el.queueError.textContent = "Could not load the mock fixture: " + err.message;
        show(el.queueError, true);
        renderQueue();
      });
  }

  function loadLive(seq) {
    return fetch(API_REVIEWS + "?status=pending", {
      headers: { "Accept": "application/json" },
      cache: "no-store"
    })
      .then(function (res) {
        if (!res.ok) { throw new Error("API returned " + res.status); }
        return res.json();
      })
      .then(function (data) {
        if (!isFreshest(seq)) { return; }
        show(el.queueError, false);
        setConn("live", "Live · polling every 2s");
        applyReviews(data.reviews);
      })
      .catch(function (err) {
        if (!isFreshest(seq)) { return; }
        setConn("error", "Disconnected");
        state.loadedOnce = true;
        el.queueError.textContent =
          "Cannot reach the review API (" + err.message +
          "). Retrying every 2s. Start Chirp on port 9900, or append ?mock=1 to work offline.";
        show(el.queueError, true);
        renderQueue();
      });
  }

  var fetchReviews = IS_MOCK ? loadMock : loadLive;

  /* One poll in flight at a time. A slow backend must not let requests stack
     up behind each other and land out of order. Always resolves. */
  function load() {
    if (state.polling) { return Promise.resolve(); }
    state.polling = true;
    return fetchReviews(++state.pollSeq).then(function () {
      state.polling = false;
    });
  }

  /* Chained rather than setInterval, so the next poll is scheduled from the
     end of the previous one instead of firing into a busy client. */
  function pollLoop() {
    load().then(function () {
      setTimeout(pollLoop, POLL_MS);
    });
  }

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
    /* Belt and braces behind setSelection: refuse outright rather than record
       one packet's note against another. This decision cannot be revised. */
    if (note && state.noteForId !== id) {
      failForm("This note was written for a different packet. " +
               "Clear it and retype before deciding.", el.note);
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
        setSelection(null);
        state.submitting = false;
        setButtonsDisabled(false);
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
        setSelection(null);
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
  pollLoop();
})();
