/* Riff review workbench.
 *
 * Talks to the frozen review API described in ARCHITECTURE.md:
 *   GET  /reviews?status=pending          pending queue
 *   GET  /reviews                         all reviews, used by the History screen
 *   POST /reviews/{packet_id}/decision    record a terminal decision
 *
 * Same-origin relative URLs only, so no CORS is needed. No dependencies,
 * no build step. Mock mode runs the whole UI against checked-in fixtures
 * with no backend at all; it can be entered with `?mock=1` or toggled at
 * runtime from the Connect screen.
 *
 * Rendering discipline: the poll runs every two seconds while the reviewer is
 * reading and typing, so no pane is rebuilt unless its content actually
 * changed. Rebuilding a pane under the reader destroys scroll position, text
 * selection, and keyboard focus.
 */

(function () {
  "use strict";

  var POLL_MS = 2000;
  var API_REVIEWS = "/reviews";
  var MOCK_PENDING_URL = "mock/pending-reviews.json";
  var MOCK_DECIDED_URL = "mock/decided-reviews.json";
  var ABOUT_URL = "about.html";

  var SCREENS = ["about", "connect", "workbench", "history"];

  var STATUS_LABEL = {
    pending: "Pending",
    accepted: "Accepted",
    correction_requested: "Correction requested",
    rejected: "Rejected"
  };

  // Mirrors _STATUS_BY_ACTION in review.py; used only to keep mock mode honest.
  var STATUS_BY_ACTION = {
    accept: "accepted",
    request_correction: "correction_requested",
    reject: "rejected"
  };

  var params = new URLSearchParams(window.location.search);

  function initialScreen() {
    var hash = (window.location.hash || "").replace(/^#/, "");
    if (SCREENS.indexOf(hash) !== -1) { return hash; }
    /* Default to the workbench rather than Connect: the demo gate in
       ROADMAP.md is "open /riff/ and see the pending packet within two
       seconds", which a landing screen would put behind an extra click. */
    return "workbench";
  }

  var state = {
    screen: initialScreen(),
    mock: params.get("mock") === "1",

    reviews: [],          // pending packets currently shown
    history: [],          // decided packets, newest decision first
    historyFilter: "all",

    selectedId: null,
    noteForId: null,      // packet the text in the note box was written for
    decided: {},          // packet_id -> true, hides packets we have decided
    loadedOnce: false,
    historyLoadedOnce: false,
    submitting: false,

    // Repaint guards.
    queueSig: null,
    historySig: null,
    renderedDetailId: null,

    polling: false,       // a poll is in flight
    pollSeq: 0,           // increments per poll
    appliedSeq: 0,        // highest poll already applied to the DOM

    aboutProbed: false
  };

  // Queue buttons by packet_id, so selection and focus survive a quiet poll.
  var queueButtons = {};

  // ---------- element handles ----------

  var el = {
    tabs:          document.getElementById("tabs"),

    screenAbout:   document.getElementById("screenAbout"),
    screenConnect: document.getElementById("screenConnect"),
    screenWork:    document.getElementById("screenWorkbench"),
    screenHistory: document.getElementById("screenHistory"),

    aboutFrame:    document.getElementById("aboutFrame"),
    aboutMissing:  document.getElementById("aboutMissing"),

    serviceOrigin:   document.getElementById("serviceOrigin"),
    connectionHint:  document.getElementById("connectionHint"),
    connectionLabel: document.getElementById("connectionLabel"),
    connectionDot:   document.getElementById("connectionDot"),
    mockToggle:      document.getElementById("mockToggle"),
    enterWorkbench:  document.getElementById("enterWorkbench"),

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

    historyFilters: document.getElementById("historyFilters"),
    historyList:    document.getElementById("historyList"),
    historyLoading: document.getElementById("historyLoading"),
    historyEmpty:   document.getElementById("historyEmpty"),
    historyError:   document.getElementById("historyError"),

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

    // The Connect screen mirrors the same state in its own card.
    el.connectionLabel.textContent =
      kind === "live" ? "Live" : kind === "mock" ? "Mock" : kind === "error" ? "Offline" : "Idle";
    el.connectionHint.textContent =
      kind === "mock" ? "Serving mock review data"
        : kind === "live" ? "Connected to the Chirp review API"
        : kind === "error" ? "No live Chirp service detected"
        : "Not connected yet";
    el.connectionDot.style.background =
      kind === "error" ? "oklch(0.72 0.18 25)"
        : kind === "idle" ? "oklch(0.55 0.012 255)"
        : "oklch(0.75 0.13 205)";
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

  function statusLabel(status) {
    return STATUS_LABEL[status] || status || "Unknown";
  }

  /* Build an element with text content. Using textContent throughout means
     packet strings from the model are never parsed as markup. */
  function elem(tag, className, text) {
    var n = document.createElement(tag);
    if (className) { n.className = className; }
    if (text !== undefined && text !== null) { n.textContent = String(text); }
    return n;
  }

  function statusPill(status) {
    var pill = elem("span", "status-pill", statusLabel(status));
    pill.setAttribute("data-status", status || "pending");
    return pill;
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

  function metaCell(key, value) {
    var cell = elem("div", "meta-cell");
    cell.appendChild(elem("div", "meta-key", key));
    cell.appendChild(elem("div", "meta-val", value));
    return cell;
  }

  // ---------- screen routing ----------

  function setScreen(name) {
    if (SCREENS.indexOf(name) === -1) { name = "workbench"; }
    state.screen = name;

    show(el.screenAbout,   name === "about");
    show(el.screenConnect, name === "connect");
    show(el.screenWork,    name === "workbench");
    show(el.screenHistory, name === "history");

    var tabs = el.tabs.querySelectorAll("button[data-screen]");
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute("data-screen") === name) {
        tabs[i].setAttribute("aria-current", "true");
      } else {
        tabs[i].removeAttribute("aria-current");
      }
    }

    if (window.location.hash.replace(/^#/, "") !== name) {
      try { history.replaceState(null, "", "#" + name); } catch (e) { /* file:// */ }
    }

    if (name === "about") { probeAbout(); }

    // The two data screens poll different endpoints, so refresh immediately
    // rather than leaving a stale pane visible for up to two seconds.
    load();
  }

  function probeAbout() {
    if (state.aboutProbed) { return; }
    state.aboutProbed = true;

    fetch(ABOUT_URL, { method: "HEAD", cache: "no-store" })
      .then(function (res) {
        if (!res.ok) { throw new Error("absent"); }
        el.aboutFrame.src = ABOUT_URL;
        show(el.aboutFrame, true);
        show(el.aboutMissing, false);
      })
      .catch(function () {
        show(el.aboutFrame, false);
        show(el.aboutMissing, true);
      });
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
    el.queueCount.textContent = items.length + " pending";

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
    var prov = p.provenance || {};
    el.detail.textContent = "";

    // header: role, status, proposal, contributor
    var head = elem("div", "detail-head");
    var roleRow = elem("div", "detail-role");
    roleRow.appendChild(elem("span", "role", p.role || "unknown role"));
    if (p.stage) { roleRow.appendChild(elem("span", "q-stage", p.stage)); }
    roleRow.appendChild(statusPill(r.status));
    head.appendChild(roleRow);
    head.appendChild(elem("p", "proposal", p.proposal || ""));
    head.appendChild(elem("div", "detail-contributor",
      (p.contributor || "unknown contributor") + "  ·  submitted " + fmtTime(r.created_at)));
    el.detail.appendChild(head);

    // provenance at a glance
    var meta = elem("div", "meta-row");
    meta.appendChild(metaCell("Contributor", p.contributor || "—"));
    meta.appendChild(metaCell("Component", prov.component_id || "—"));
    meta.appendChild(metaCell("Run", prov.run_id || "—"));
    meta.appendChild(metaCell("Parent packets",
      (prov.parent_packet_ids && prov.parent_packet_ids.length)
        ? prov.parent_packet_ids.join(", ")
        : "none"));
    meta.appendChild(metaCell("Packet", r.packet_id));
    el.detail.appendChild(meta);

    // inputs / assumptions
    el.detail.appendChild(listBlock("Inputs", p.inputs));
    el.detail.appendChild(listBlock("Assumptions", p.assumptions));

    // parameters table — unit and source are part of the reasoning record
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

    el.detail.appendChild(textBlock("Rationale", p.rationale || ""));
    el.detail.appendChild(listBlock("Uncertainties", p.uncertainties, "block-uncertain"));

    // payload
    if (p.payload && Object.keys(p.payload).length) {
      var payWrap = elem("div", "block");
      payWrap.appendChild(elem("h3", null, "Payload"));
      payWrap.appendChild(elem("pre", "payload", JSON.stringify(p.payload, null, 2)));
      el.detail.appendChild(payWrap);
    }
  }

  // ---------- history rendering ----------

  function filteredHistory() {
    if (state.historyFilter === "all") { return state.history; }
    return state.history.filter(function (r) { return r.status === state.historyFilter; });
  }

  function historySignature(items) {
    return JSON.stringify([state.historyFilter, items.map(function (r) {
      var d = r.decision || {};
      return [r.packet_id, r.status, d.reviewer, d.note, d.decided_at];
    })]);
  }

  function renderHistory() {
    var items = filteredHistory();

    show(el.historyLoading, !state.historyLoadedOnce);
    if (!state.historyLoadedOnce) {
      show(el.historyList, false);
      show(el.historyEmpty, false);
      return;
    }

    show(el.historyEmpty, items.length === 0);
    show(el.historyList, items.length > 0);

    // Same discipline as the queue: no rebuild unless the content changed.
    var sig = historySignature(items);
    if (sig === state.historySig) { return; }
    state.historySig = sig;

    el.historyList.textContent = "";

    items.forEach(function (r) {
      var p = r.packet || {};
      var d = r.decision || {};
      var li = document.createElement("li");

      var top = elem("div", "h-top");
      top.appendChild(elem("span", "h-id", shortId(r.packet_id)));
      top.appendChild(statusPill(r.status));
      if (p.stage) { top.appendChild(elem("span", "q-stage", p.stage)); }
      li.appendChild(top);

      li.appendChild(elem("p", "h-proposal", p.proposal || ""));

      var who = (p.contributor || "unknown contributor")
        + "  ·  reviewed by " + (d.reviewer || "unknown")
        + "  ·  " + fmtTime(d.decided_at);
      li.appendChild(elem("div", "h-meta", who));

      if (d.note) {
        li.appendChild(elem("p", "h-note", "“" + d.note + "”"));
      }

      el.historyList.appendChild(li);
    });
  }

  function markHistoryFilter() {
    var btns = el.historyFilters.querySelectorAll("button[data-filter]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-pressed",
        btns[i].getAttribute("data-filter") === state.historyFilter ? "true" : "false");
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

  function applyHistory(list) {
    var decided = (Array.isArray(list) ? list : []).filter(function (r) {
      return r && r.status && r.status !== "pending";
    });
    decided.sort(function (a, b) {
      var da = a.decision && a.decision.decided_at ? new Date(a.decision.decided_at) : 0;
      var db = b.decision && b.decision.decided_at ? new Date(b.decision.decided_at) : 0;
      return db - da;
    });
    state.history = decided;
    state.historyLoadedOnce = true;
    renderHistory();
  }

  /* True when this response is the newest one seen. An older response that
     arrives late must be dropped, not applied, or it reverts the queue. */
  function isFreshest(seq) {
    if (seq <= state.appliedSeq) { return false; }
    state.appliedSeq = seq;
    return true;
  }

  function getJSON(url) {
    return fetch(url, {
      headers: { "Accept": "application/json" },
      cache: "no-store"
    }).then(function (res) {
      if (!res.ok) { throw new Error("API returned " + res.status); }
      return res.json();
    });
  }

  function queueFailed(message) {
    state.loadedOnce = true;
    el.queueError.textContent = message;
    show(el.queueError, true);
    renderQueue();
  }

  function historyFailed(message) {
    state.historyLoadedOnce = true;
    el.historyError.textContent = message;
    show(el.historyError, true);
    show(el.historyList, false);
    show(el.historyEmpty, false);
  }

  function loadMock(seq) {
    // History needs the decided fixture; every other screen needs pending.
    var wantHistory = state.screen === "history";
    var url = wantHistory ? MOCK_DECIDED_URL : MOCK_PENDING_URL;

    return getJSON(url)
      .then(function (data) {
        if (!isFreshest(seq)) { return; }
        setConn("mock", "Mock fixture");
        if (wantHistory) {
          show(el.historyError, false);
          applyHistory(data.reviews);
        } else {
          show(el.queueError, false);
          applyReviews(data.reviews);
        }
      })
      .catch(function (err) {
        if (!isFreshest(seq)) { return; }
        setConn("error", "Mock failed");
        var msg = "Could not load the mock fixture: " + err.message;
        if (wantHistory) { historyFailed(msg); } else { queueFailed(msg); }
      });
  }

  function loadLive(seq) {
    /* History needs terminal packets, which the frozen contract exposes by
       omitting the status filter. Every other screen polls the pending
       filter, which is the behavior the lane requires. */
    var wantHistory = state.screen === "history";
    var url = wantHistory ? API_REVIEWS : API_REVIEWS + "?status=pending";

    return getJSON(url)
      .then(function (data) {
        if (!isFreshest(seq)) { return; }
        setConn("live", "Live · polling every 2s");
        if (wantHistory) {
          show(el.historyError, false);
          applyHistory(data.reviews);
        } else {
          show(el.queueError, false);
          applyReviews(data.reviews);
        }
      })
      .catch(function (err) {
        if (!isFreshest(seq)) { return; }
        setConn("error", "Disconnected");
        var msg = "Cannot reach the review API (" + err.message +
          "). Retrying every 2s. Start Chirp on port 9900, or turn on " +
          "Mock mode from the Connect screen to work offline.";
        if (wantHistory) { historyFailed(msg); } else { queueFailed(msg); }
      });
  }

  /* One poll in flight at a time. A slow backend must not let requests stack
     up behind each other and land out of order. Always resolves. */
  function load() {
    if (state.polling) { return Promise.resolve(); }
    state.polling = true;
    var fetcher = state.mock ? loadMock : loadLive;
    return fetcher(++state.pollSeq).then(function () {
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

  function setMock(on) {
    if (state.mock === on) { return; }
    state.mock = on;

    // Different source of truth, so drop everything derived from the old one.
    state.reviews = [];
    state.history = [];
    state.decided = {};
    state.loadedOnce = false;
    state.historyLoadedOnce = false;
    state.queueSig = null;
    state.historySig = null;
    state.renderedDetailId = null;
    setSelection(null);

    show(el.queueError, false);
    show(el.historyError, false);
    show(el.mockBadge, on);
    el.mockToggle.setAttribute("aria-checked", on ? "true" : "false");
    setConn(on ? "mock" : "idle", on ? "Mock fixture" : "Connecting…");

    renderQueue();
    renderDetail();
    renderDecision();
    renderHistory();
    load();
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
    if (state.mock) {
      var target = findReview(id);
      setTimeout(function () {
        state.decided[id] = true;
        if (target) {
          // Keep the mock coherent: a decided packet shows up under History.
          state.history = [{
            packet_id: target.packet_id,
            created_at: target.created_at,
            status: STATUS_BY_ACTION[action],
            packet: target.packet,
            decision: {
              action: action,
              reviewer: reviewer,
              note: note || null,
              decided_at: new Date().toISOString()
            }
          }].concat(state.history);
          state.historySig = null;
          renderHistory();
        }
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

  el.tabs.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-screen]");
    if (btn) { setScreen(btn.getAttribute("data-screen")); }
  });

  window.addEventListener("hashchange", function () {
    var hash = (window.location.hash || "").replace(/^#/, "");
    if (SCREENS.indexOf(hash) !== -1 && hash !== state.screen) { setScreen(hash); }
  });

  el.historyFilters.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-filter]");
    if (!btn) { return; }
    state.historyFilter = btn.getAttribute("data-filter");
    markHistoryFilter();
    renderHistory();
  });

  el.mockToggle.addEventListener("click", function () {
    setMock(el.mockToggle.getAttribute("aria-checked") !== "true");
  });

  el.enterWorkbench.addEventListener("click", function () { setScreen("workbench"); });

  el.decisionForm.addEventListener("submit", function (e) { e.preventDefault(); });

  el.decisionForm.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-action]");
    if (btn) { submitDecision(btn.getAttribute("data-action")); }
  });

  // Surface the note requirement as soon as the reviewer starts typing one.
  el.note.addEventListener("input", clearFormError);
  el.reviewer.addEventListener("input", clearFormError);
  show(el.noteReq, true);

  // ---------- boot ----------

  el.serviceOrigin.textContent = window.location.origin || "(same origin)";
  el.mockToggle.setAttribute("aria-checked", state.mock ? "true" : "false");
  show(el.mockBadge, state.mock);
  setConn(state.mock ? "mock" : "idle", state.mock ? "Mock fixture" : "Connecting…");

  markHistoryFilter();
  setScreen(state.screen);

  renderQueue();
  renderDetail();
  renderDecision();
  renderHistory();
  pollLoop();
})();
