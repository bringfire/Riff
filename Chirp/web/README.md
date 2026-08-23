# Riff web workbench

Static review workbench for the Chirp review API. No build step, no
dependencies, no bundler — the four source files are served as-is.

```text
index.html                    markup and the four screens
app.js                        polling, rendering, decision submission
styles.css                    dark theme
about.html                    workflow overview (copied artifact, see below)
mock/pending-reviews.json     fixture: pending queue
mock/decided-reviews.json     fixture: History
```

## Running it

Served by Chirp at `/riff/`. From `Chirp/`:

```text
# Windows PowerShell
$env:CHIRP_PORT="9900"; python -m chirp

# macOS / Linux
CHIRP_PORT=9900 python -m chirp
```

Then open <http://127.0.0.1:9900/riff/>.

**Start with `/riff/?mock=1`.** `GET /reviews` does not exist in
`chirp/review.py` yet — it implements `POST /reviews`,
`GET /reviews/{packet_id}`, and the decision endpoint only. Until the
review-queue lane lands, live mode shows a connection error and mock mode
is the only working path. Mock is also toggleable at runtime from the
Connect screen.

Screens are deep-linkable: `#about`, `#connect`, `#workbench`, `#history`.

## Verifying changes without a runtime

Some machines that touch this lane have no Python and no Node. Nothing below
proves behaviour — only a running browser does that — but each check has
caught a real defect here, and they cost seconds.

### JavaScript syntax

Windows ships a JScript engine. `Function()` compiles a body without running
it, which makes it a usable syntax checker.

```js
// jscheck.js — run OUTSIDE this directory; it is a tool, not a source file
var fso = new ActiveXObject("Scripting.FileSystemObject");
var args = WScript.Arguments;
for (var i = 0; i < args.length; i++) {
  var path = args(i), src = "";
  try {
    var f = fso.OpenTextFile(path, 1, false, 0);
    src = f.AtEndOfStream ? "" : f.ReadAll();
    f.Close();
  } catch (readErr) {
    WScript.Echo("READ ERROR " + path + ": " + readErr.message);
    continue;
  }
  try {
    new Function(src);
    WScript.Echo("PARSE OK    " + path + "  (" + src.length + " chars)");
  } catch (e) {
    WScript.Echo("PARSE ERROR " + path + ": " + e.message);
  }
}
```

```text
cscript //Nologo //E:JScript jscheck.js probe.js
```

**Two gotchas, both of which will bite you.**

1. **JScript is ES3, so it rejects reserved words used as property names.**
   `app.js` uses `.catch(` and `.delete(`, which are valid ES5+ but parse as
   `Expected identifier` here. Rewrite them in a throwaway copy first:

   ```text
   sed -e 's/\.catch(/.kAtCh(/g' -e 's/\.delete(/.dElEtE(/g' app.js > probe.js
   ```

   Re-scan for new ones after any edit rather than trusting a stale list —
   `.delete` was introduced by a later change and turned a clean pass into a
   confusing failure. `for w in catch delete finally default in new class
   throw typeof; do grep -cE "\.$w\b" app.js; done` finds them.

2. **Validate the checker before trusting a pass.** Run it against a
   known-good file and a known-broken one (`var a = ;`) in the same
   invocation. A misconfigured checker reports success for everything, and a
   green result you did not earn is worse than no check.

This only catches syntax. It cannot see a null element, a bad selector, or
wrong logic.

### Element ids, selectors, CSS classes

The likeliest runtime crash is `getElementById` returning null after a
rename. These greps catch it:

```text
# ids app.js resolves that index.html does not define
grep -oE 'getElementById\("[^"]+"\)' app.js | sed 's/.*("\(.*\)")/\1/' | sort -u > /tmp/a
grep -oE 'id="[^"]+"' index.html | sed 's/id="\(.*\)"/\1/' | sort -u > /tmp/b
comm -23 /tmp/a /tmp/b

# CSS classes used but never defined
grep -oE '\.[a-zA-Z][a-zA-Z0-9_-]*' styles.css | sed 's/^\.//' | sort -u > /tmp/c
```

### JSON fixtures

Fixtures must match the Pydantic models in `chirp/review.py`, not the design
canvas — the canvas flattens `provenance`, drops `stage` and `payload`, and
models `parameters` without `unit` or `source`. Each review needs
`packet_id`, `created_at`, `status`, `packet`, `decision`; each `packet`
needs all eleven keys; each parameter needs `name`, `value`, `unit`,
`source`; `provenance.parent_packet_ids` must be an array.

With no runtime, a browser console (`JSON.parse` on the pasted text) or any
JSON validator works. Balanced-brace counting alone will not catch a missing
comma between array entries.

## Things a reader should know

**`about.html` is a copied build artifact.** It is a byte-identical copy of
`Design workflow_R1/RIFF-Workflow-share.html`, ~300 KB, self-unpacking: the
page content sits inside a `<script type="__bundler/template">` that is
parsed and swapped in at runtime, with React and all fonts embedded. It
needs no network at render time.

Two consequences. It goes **stale** when the design canvas is revised —
re-copy it. And its `cdnScriptFor` falls back to a live `unpkg.com` URL for
Babel when `window.__resources` lacks an entry; that path is dead today
(nothing in the template needs Babel), but a future canvas revision
introducing a `.jsx` import would turn this into a page that phones out and
silently breaks an offline demo.

The copy exists because `/riff/` is a static mount of this directory, so an
iframe cannot reach outside it. Mounting the design directory in `server.py`
would be cleaner, but that file belongs to the integration owner. If that
happens, delete `about.html` and repoint the iframe — the About screen
already falls back to an explanatory empty state when the file is absent.

**Two open contract deviations, deferred rather than resolved.** The theme is
dark; `ARCHITECTURE.md` and `ROADMAP.md` specify light mode in five places.
And `about.html` is a build artifact embedding a framework, which
`ARCHITECTURE.md`'s no-build-step rule arguably forbids. Both were directed
by the repo owner and both are currently out of scope — but neither has
coordinator sign-off, so both will still fail the ROADMAP merge gate when
someone checks. Silence here is not approval.

## Rendering discipline

The poll runs every two seconds while a reviewer is reading and typing, so
**no pane is rebuilt unless its content actually changed.** Rebuilding under
a reader destroys scroll position, text selection, and keyboard focus. If you
add a pane, give it the same treatment:

- The detail pane repaints only when the selected `packet_id` changes.
  Packets are immutable server-side, so identity is sufficient.
- The queue repaints only when its visible set changes, and restores keyboard
  focus to the same packet when it must rebuild.
- History repaints only when its rows or filter change.
- A pane in a failed state owns its own presentation until the next success
  (`queueErrored` / `historyErrored`), so no later repaint can re-show
  "Queue is empty" beside a connection error.
- Every selection change goes through `setSelection()`, which clears the note
  and records which packet it belongs to. `submitDecision` independently
  refuses if the two disagree. Decisions are terminal and immutable, so a
  note attached to the wrong packet cannot be taken back.
- Polls are single-flight with a hard timeout, and stale responses are
  dropped by sequence number. `markApplied` runs only after rendering
  finishes, so a render error cannot be swallowed by its own catch handler.
