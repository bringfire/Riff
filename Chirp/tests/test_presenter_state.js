"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const presenterPath = path.resolve(__dirname, "..", "web", "presenter.js");
let source = fs.readFileSync(presenterPath, "utf8");
source = source.replace(/\}\(\)\);\s*$/, `
  globalThis.__riffTest = {
    state: state,
    reviewsComplete: reviewsComplete,
    beginMatrixRefresh: beginMatrixRefresh,
    applyReviewDecision: applyReviewDecision,
    applyMatrixRefresh: applyMatrixRefresh
  };
}());
`);

const fakeElement = {
  value: "",
  addEventListener: function () {},
  setAttribute: function () {},
  classList: { toggle: function () {} }
};
const context = {
  console: console,
  document: {
    addEventListener: function () {},
    getElementById: function () { return fakeElement; },
    querySelectorAll: function () { return []; }
  },
  window: { location: { origin: "http://localhost", search: "" } }
};
vm.runInNewContext(source, context, { filename: presenterPath });

const api = context.__riffTest;
const pending = { packet_id: "packet-1", status: "pending", decision: null };
const accepted = {
  packet_id: "packet-1",
  status: "accepted",
  decision: {
    action: "accept",
    reviewer: "Ada",
    note: null,
    decided_at: "2026-08-23T12:00:00Z"
  }
};

api.state.presentation = {
  snapshot: { nodes: [{ node_id: "node-1" }, { node_id: "node-2" }] }
};
api.state.reviewByNodeId = {
  "node-1": accepted,
  "node-2": pending
};
assert.equal(api.reviewsComplete(), false);

api.applyReviewDecision("node-2", {
  packet_id: "packet-2",
  status: "rejected",
  decision: {
    action: "reject",
    reviewer: "Lin",
    note: "Revise the premise.",
    decided_at: "2026-08-23T12:01:00Z"
  }
});
assert.equal(
  api.reviewsComplete(),
  true,
  "the last successful decision must immediately complete the visible review state"
);

api.state.reviewByNodeId = { "node-1": pending, "node-2": pending };
const staleRefresh = api.beginMatrixRefresh();
api.applyReviewDecision("node-1", accepted);
assert.equal(
  api.applyMatrixRefresh(staleRefresh, { review_complete: false }, {
    "node-1": pending,
    "node-2": pending
  }),
  false,
  "a refresh started before a terminal decision must not overwrite that decision"
);
assert.equal(api.state.reviewByNodeId["node-1"].status, "accepted");

const olderRefresh = api.beginMatrixRefresh();
const newerRefresh = api.beginMatrixRefresh();
assert.equal(
  api.applyMatrixRefresh(olderRefresh, { review_complete: false }, {
    "node-1": pending,
    "node-2": pending
  }),
  false,
  "an older overlapping refresh must not overwrite a newer request"
);
assert.equal(
  api.applyMatrixRefresh(newerRefresh, { review_complete: true }, {
    "node-1": accepted,
    "node-2": accepted
  }),
  true
);

console.log("presenter state tests passed");
