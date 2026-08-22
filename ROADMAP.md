# Riff Hackathon Roadmap

**Prototype window:** 6:00–8:00 PM, 2026-08-22

**Architecture contract:** [ARCHITECTURE.md](ARCHITECTURE.md)

## Decision summary

- One colleague and their agent own the web-interface lane.
- The core Riff team and its agents own the review API, Grasshopper bridge, and final integration.
- The HTTP review API is frozen as the seam between the two sides.
- The prototype uses polling, same-origin static files, in-memory state, and light mode.
- Work stops at a human-reviewed vertical demo; generalized loops and platform refactors are deferred.

## Definition of done

Before the demo, all of the following must work:

1. Start Chirp locally on port `9900`.
2. Open the Riff workbench at `/riff/`.
3. Submit an Alpine-hut review packet from Grasshopper.
4. See the pending packet appear in the browser within two seconds.
5. Accept it and see Grasshopper release approved geometry.
6. Submit another packet, request correction or reject it, and see the note on the Grasshopper canvas.
7. Run the Python test suite without regressions.

## Safe seams

There are four core lanes: three implementation lanes plus one integration lane. A fifth content lane is optional. More lanes are not recommended in the two-hour window.

| Lane | Owner | Exclusive files | Required result |
|---|---|---|---|
| Web workbench | Colleague + agent | `Chirp/web/**` | Pending queue, packet inspection, decisions, mock mode |
| Review API | Core-team backend agent | `Chirp/src/chirp/review.py`, `Chirp/tests/test_review.py` | Filterable queue endpoint with tests |
| Grasshopper bridge | Core-team Grasshopper agent | `GH/**`, optional `Chirp/templates/riff_review_client.cs` | Submit/poll client and accepted-geometry gate |
| Integration and demo | Core-team coordinator agent | `Chirp/src/chirp/server.py` | Serve `/riff/`, integrate lanes, verify demo |
| Optional demo content | One designated owner | `examples/alpine-hut/**` | Known-good packet, instructions, fallback data |

Only the named owner may modify a lane's files. `server.py` belongs exclusively to the integration owner. `.gh` files belong exclusively to the Grasshopper owner. Nobody commits `traces/`.

The coordinator's current checkout contains an untracked `GH/Example-01.gh`; a fresh clone will not contain it. Before parallel work begins, the coordinator must hand that file to the designated Grasshopper owner. That owner alone decides when to add it to Git. Other agents must not create or overwrite the same path.

## Branches

After these documents are merged to `main`, every lane branches from the same updated commit:

```text
hackathon/web-workbench
hackathon/review-queue
hackathon/grasshopper-bridge
hackathon/demo-integration
hackathon/alpine-hut-demo        # optional
```

Each PR must stay inside its assigned files. If an agent discovers that another file must change, it reports the need to the coordinator rather than editing it.

## Agent assignment: web workbench

**Mission:** Build the approved full review workbench in light mode.

**May edit:** `Chirp/web/**` only.

**Must not edit:** Python, tests, Grasshopper files, package configuration, or architecture contracts.

Required files:

```text
Chirp/web/index.html
Chirp/web/app.js
Chirp/web/styles.css
Chirp/web/mock/pending-reviews.json
```

Required behavior:

- Left: pending queue.
- Center: role, contributor, proposal, inputs, assumptions, parameters, rationale, uncertainties, and provenance.
- Right: reviewer, note, Accept, Request correction, and Reject.
- Poll `GET /reviews?status=pending` every two seconds.
- Send decisions to `POST /reviews/{packet_id}/decision`.
- Require reviewer name; require a nonblank note for correction and rejection.
- Remove decided packets from the visible pending queue.
- Show loading, empty, success, and error states.
- Support `?mock=1` without a live backend.
- Use relative API URLs and no build tooling or external dependencies.

Completion report: screenshot, files changed, mock launch instructions, live API assumptions, and limitations. Stop without integration changes.

## Agent assignment: review API

**Mission:** Add the frozen queue contract without changing existing endpoint behavior.

**May edit:** `review.py` and `test_review.py` only.

Required behavior:

- Add `ReviewListResponse` containing `reviews: list[ReviewResponse]`.
- Add `GET /reviews` with optional typed `status` filtering.
- Return oldest-first defensive snapshots while holding the existing lock.
- Return all reviews when status is omitted.
- Preserve terminal-state, immutability, strict-validation, and concurrency rules.
- Add focused tests for unfiltered listing, pending filtering, terminal filtering, ordering, and invalid status `422`.
- Run focused and complete Chirp test suites.

Do not add pagination, deletion, persistence, assignment, authentication, or dependencies.

## Agent assignment: Grasshopper bridge

**Mission:** Demonstrate submission and human approval without moving geometry through HTTP.

**May edit:** `GH/**` and the optional client template only.

Required behavior:

- Inputs: service URL, submit trigger, refresh trigger, structured packet fields, and geometry.
- Outputs: review ID, status, accepted Boolean, correction/rejection note, and approved geometry.
- Submit once on a Boolean edge and retain the returned packet ID.
- Poll manually or using a Grasshopper Timer.
- Release geometry only when status is `accepted`.
- Display correction and rejection notes in a Panel.
- Preserve the existing `GH/Example-01.gh`; only its designated owner may modify it.

Do not create a Grasshopper cycle, serialize geometry, or automatically rerun Chirp from a correction.

## Agent assignment: integration and demo

**Mission:** Combine the lanes without redesigning them.

**May edit:** `server.py` and integration-only documentation or scripts approved by the coordinator.

Required behavior:

- Serve `Chirp/web/` at `/riff/` using the existing FastAPI app.
- Keep `/reviews` routes reachable before the static mount.
- Use same-origin relative requests; do not add CORS unless the frozen architecture changes.
- Merge work in the prescribed order.
- Run the complete Python suite and the manual end-to-end demo.
- Record exact startup and demo instructions.

## Timeline

### 6:00–6:10 — Freeze and branch

- Review and merge these two documents.
- Assign one human owner per lane.
- Sync everyone to `bringfire/Riff` and branch from the same `main` commit.
- No contract changes after this point without coordinator approval.

### 6:10–6:55 — Parallel implementation

- Web teammate builds entirely against the frozen contract and mock file.
- Backend agent implements and tests the queue endpoint.
- Grasshopper agent builds the submit/poll/gate definition.
- Integration owner prepares the static mount and demo checklist without touching other lanes.

### 6:55–7:15 — Review and merge

Merge in this order:

1. Review API
2. Web workbench
3. Grasshopper bridge
4. Integration wiring

Each lane receives a brief scope-and-behavior review. Fix blockers only.

### 7:15–7:40 — End-to-end verification

- Start Chirp with `CHIRP_PORT=9900`.
- On Windows PowerShell, use `$env:CHIRP_PORT="9900"; python -m chirp`.
- On macOS, use `CHIRP_PORT=9900 python -m chirp`.
- Open `/riff/` and verify the live pending queue.
- Exercise accept and correction/rejection from Grasshopper.
- Run from `Chirp/`:

  ```text
  python -m pytest tests/test_review.py -q
  python -m pytest tests -q
  ```

### 7:40–8:00 — Freeze and rehearse

- Stop feature work.
- Fix only demo-blocking defects.
- Capture a screenshot or short recording.
- Preserve one known-good Alpine-hut packet.
- Rehearse the exact click path once.

## Fallbacks

- If Grasshopper submission is blocked, submit the same packet through FastAPI `/docs` and continue the browser review demo.
- If the live queue is blocked, use `/riff/?mock=1` to demonstrate the structured workbench.
- If automatic polling is unstable, use a manual Refresh trigger.
- Never replace a working partial demo with an unverified late feature.

## Merge gates

Before merging any lane:

- The diff contains only owned files.
- No dependency or package-name change was introduced.
- The API contract in `ARCHITECTURE.md` was followed exactly.
- Existing untracked `GH/` and `traces/` data was not overwritten by another lane.
- Tests or manual acceptance evidence is included in the PR.
- The integration owner confirms the merge order.

## After the prototype

### Next

- Persist reviews and audit history.
- Define revision/replacement packet relationships.
- Improve provenance navigation and contributor attribution.
- Add Windows/macOS CI and package the workbench assets.

### Later

- Authentication and reviewer permissions.
- Multi-reviewer policies and consensus.
- Objective functions and bounded recursive critique.
- Multi-user synchronization and WebSockets.
- Deliberate Chirp-to-Riff internal naming migration.

These items must not enter the two-hour prototype unless the coordinator explicitly replaces an existing deliverable.
