<img src="docs/banner.svg" alt="Jev Ultrafast · Browser Use × TypeSafe" width="100%" />

# Jev Ultrafast ⚡

> [!IMPORTANT]
> **The Browser Use Cloud waitlist is open.** Get early access to ultrafast browser agents in the cloud.
> **[Join the waitlist →](https://browser-use.com/ultrafast?utm_source=github&utm_medium=readme&utm_campaign=jev-ultrafast)**

**A browser agent with a dynamic, indexed action space.**

Give it one goal. [TypeSafe's Jev](https://docs.typesafe.ai/introduction) picks an operation and an element. A small LLM writes text only when the operation is `TYPE_TEXT`.

**Zürich → London on Google Flights in 7.1 seconds.** One natural-language goal, actual text generation, and loading waits included.

<a href="docs/demo.mp4"><img src="docs/demo.gif" alt="A real Google Flights search at 1× speed, with generated city names and dynamic operation/target decisions" width="100%" /></a>

[Watch the MP4](docs/demo.mp4) · [Measurements](docs/performance.md) · [Read the loop](jev_ultrafast/agent.py)

## The action space

Every observation produces a new element table:

```text
[1] button    Change ticket type · Round trip
[2] combobox  Where from?        · San Francisco
[3] combobox  Where to?          · empty
[4] textbox   Departure          · empty
...
```

The operations are `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, and `BLOCKED`. Only supported operations and targets are offered.

```text
                      one TypeSafe request
                     ┌───────────────────────────┐
page → element table → operation                 │
                     │ click_target              │
                     │ type_text_target          │
                     │ select_target, if present │
                     └─────────────┬─────────────┘
                         use the matching target
                                   │
                    CLICK [7] ─────┤──→ browser
                TYPE_TEXT [3] ─────┘
                          ↓
                   small LLM → text → browser
```

Target questions are speculative. If the operation is `CLICK`, only `click_target` can execute. Two decisions, **one network round trip**. Each target head contains only compatible elements. Native dropdown choices carry an observed element/option index.

There are no site-specific action scripts or prepared field strings in the policy. The Flights example supplies a goal and independently verifies the outcome. The screenshot renderer adds labels afterward; it does not drive the browser.

## Try it

```bash
git clone https://github.com/browser-use/jev-ultrafast.git
cd jev-ultrafast
uv sync
cp .env.example .env
# Add TYPESAFE_API_KEY and TEXT_MODEL_API_KEY.
uv run jev
```

Open **http://127.0.0.1:8766** and click **Start demo → Run automatically**. The inspector shows numbered elements, operation probabilities, target probabilities, and executed actions. **Choose next** pauses before execution.

Chrome connects through [Browser Harness](https://github.com/browser-use/browser-harness), installed by `uv sync`. Run `uv run browser-harness --doctor` if it needs connecting. Allow remote debugging in Chrome when prompted.

`TEXT_MODEL_API_KEY` is an OpenRouter key in the example configuration. The current demo uses `inception/mercury-2.5` with reasoning disabled. Gemini, GLM, and DeepSeek can also use the OpenAI-compatible text helper; configure the appropriate model, endpoint, and reasoning setting.

## Run locally

One small model can make both model calls on this machine, under a fixed memory budget. It is not fine-tuned for this agent. [GUI-Owl-1.5-2B-Instruct](https://huggingface.co/mPLUG/GUI-Owl-1.5-2B-Instruct) (Q4_K_M, text only) runs through `llama-server` (Metal, CUDA, ROCm/HIP, Vulkan):

```bash
uv run jev-local   # prints the .env lines to use
```

It runs on the GPU when llama.cpp has one (Metal, CUDA, ROCm, Vulkan) and falls back to the CPU otherwise; use
`--device gpu|cpu` to choose. `jev-local` pins every setting that can grow memory: one slot, 4,096-token context, 8-bit KV cache, no host prompt cache. It stops the server if its resident memory passes 1,792 MB, leaving 256 MB of the 2 GB budget for the agent. On an M4 the warm server measured 1,393 MB.

With `DECISION_MODEL_BASE_URL` set, each step asks one question over every observed action. The answer is read from the model's next-token probabilities in two option orders, and the two readings are averaged to reduce position bias. The model still only chooses among observed actions. Code tracks which goal values are already set or typed. `DONE` is held back while values are missing, unless a yes/no readout says the page shows the goal's outcome. Repeated actions are made less likely, and actions the executor refused are excluded on the same page. In local mode, `TYPE_TEXT` first lets the model pick among goal values not yet set elsewhere, then falls back to free text.

Local mode is experimental. On an M4 it passed the local hotel fixture in every repeat (5.2–6.0 s) and opened the Wikipedia Gödel article 5/5 (about 18 s). Two newer checks passed less often: a second hotel goal (Nature stays, Serra Lodge) passed 2/2, and a reading-room article passed 1/2. It failed a second Wikipedia search (Eiffel Tower) 0/2: it opens "Search for pages containing" instead of the article. It failed Google Flights in every run: it sets both cities, then searches before setting one-way and the date. Qwen3.5-0.8B and Qwen3.5-2B scored lower in the same tests.

## Watch it run

```bash
uv run jev-window   # opens a visible browser with its own profile; prints BU_CDP_WS and JEV_SHOW=1
```

Add the two printed lines to `.env`, then run any example. The agent's tab opens in the foreground. A cursor glides to each target, the target is outlined, clicks show a ripple, and text is typed character by character. The overlay is display only: it holds no text or controls, ignores the pointer, and input still goes through the same hit-tested CDP path. The 21 browser guard checks pass with it on. Animation adds about 0.3 s per action (hotel fixture: 7.1 s headed against 5.3 s headless), so leave `JEV_SHOW` unset for timed runs. Your own browser profile is never used.

## Jev Browser

[`browser/`](browser/) is a Chromium-based desktop browser (Electron) with the agent built in. It has tabs, private
tabs, bookmarks, history and downloads; settings; first-run onboarding with a system check and model download; and an
agent side panel that works on the current tab. The panel asks before using a new site and before risky clicks. Run
`cd browser && npm install && npm start`, or build a macOS installer with `npm run dist`. See
[browser/README.md](browser/README.md).

## Chat in the browser

The [extension](extension/) adds a side panel. You type a goal, and the local agent works on the tab you are viewing, posting each step as it happens.

```bash
uv run jev-local     # model server under 2 GB; copy its lines into .env
uv run jev-chat      # prints a pairing token; reads .env
```

1. In Chrome or Brave, open `chrome://extensions`, turn on Developer mode, and **Load unpacked** the `extension/` folder.
2. Allow remote debugging once at `chrome://inspect/#remote-debugging` so the agent can reach your tabs. Or run `uv run jev-window`, which opens a separate window with its own profile and the extension already loaded.
3. Click the toolbar icon, paste the pairing token, and send a goal. **Stop** ends the run before the next action.

The agent acts on your logged-in tab with your accounts, so watch it and use Stop if needed. It never navigates, resizes or closes that tab on its own; it only detaches when finished. The chat server accepts only loopback requests that come from an extension and carry the pairing token. Page and model text are shown as plain text, never as HTML. A final "done" is the agent's own claim; check the page.

## Use the library

```python
from jev_ultrafast import Agent

with Agent(
    "https://www.google.com/travel/flights?hl=en",
    "Find one-way flights from Zurich to London on September 20, 2026, "
    "for one adult in economy. Stop when matching flight options are visible.",
) as agent:
    for state in agent.run():
        print(state["elapsed_ms"], state["status"])
```

Run with `uv run --env-file .env python your_script.py`. The same policy can run a different task:

```bash
uv run --env-file .env python examples/run.py \
  --url https://en.wikipedia.org/wiki/Main_Page \
  --goal 'Find and open the Wikipedia article about Gödel’s incompleteness theorems.'
```

`uv run --env-file .env python examples/flights.py --keep-open` performs the flight search, checks the actual route/date/results, and saves its trace. It does not select or book a flight.

## Why it moves

- **One request per decision cycle.** Operation and target heads share the same observed state.
- **No screenshots in the default agent loop.** Jev consumes structured state. The inspector opts into screenshots; the video uses a separate continuous screencast.
- **One browser call per snapshot.** Read visible controls, their names, values, and text atomically. Keep references to the actual DOM nodes.
- **Validate the selected target.** Clicks check the document, form values, target, and nearby context. Animation alone does not force another prediction. Resolve current geometry and reject covered controls before input.
- **Wait for useful state.** After typing into a combobox, wait for visible suggestions, capped at 200 ms. Other interactions get at most two animation frames or 50 ms. These reads happen after execution is logged.
- **Keep hidden tabs rendering.** Focus emulation prevents background animation throttling without switching Chrome's visible tab.
- **Send visible text.** Offscreen article bodies and footers do not fill the model context.
- **Reuse an interrupted text request.** A generated value survives a stale-page retry only if the entire text-helper input is unchanged.

Every executed target is resolved from an observed node. The executor rechecks page freshness and click occlusion. Model output never becomes selectors, coordinates, shell commands, or executable JavaScript. Text-helper output must parse as a small JSON object before typing.

## Small enough to read

| File | Job |
| --- | --- |
| [agent.py](jev_ultrafast/agent.py) | The complete loop and text-helper handoff |
| [snapshot.js](jev_ultrafast/snapshot.js) | Atomic DOM snapshot, indexed controls, freshness guards |
| [browser.py](jev_ultrafast/browser.py) | Browser connection, current geometry, execution |
| [model.py](jev_ultrafast/model.py) | Dynamic operation/target heads and text generation |
| [questions.py](jev_ultrafast/questions.py) | Model instructions |
| [demo.py](jev_ultrafast/demo.py) | Local inspector |

## Evidence and limits

The current video is a **7,073 ms** Google Flights run. Timing starts after initial page observation and includes model calls, generated text, browser work, stale decisions, and loading waits. A fresh independent check verifies the one-way setting, Zürich, London, September 20, 2026, and visible flight options. The video plays at 1×, with no opening hold and a 0.5-second final hold.

In six alternating runs with identical models and settings, both versions passed **3/3**. Median task time went from **9.450 s → 7.092 s**, a **25% reduction**; median browser protocol calls went from **1,092 → 101**. This is three repeats of one task on one browser profile, not a general reliability benchmark.

The same policy opened the requested Wikipedia article in **2.798 s** and passed a local hotel search/filter task in **1.896 s**. Runs, failures, source hashes, and measurement boundaries are in [performance.md](docs/performance.md).

A `DONE` choice still requires independent outcome verification. The DOM reader handles common HTML and ARIA controls, not the full accessible-name specification. Shadow roots, frames, canvas, uploads, pop-up tabs, nested scrolling, and arbitrary keyboard widgets remain outside this MVP. Owned tabs share the existing Chrome profile.

## Development

```bash
uv run ruff check .
uv run pytest
node --check jev_ultrafast/static/app.js
node --check jev_ultrafast/snapshot.js
uv build
```

Tests are offline. `uv run python scripts/check_guards.py` checks real controls in a local browser without model calls. Live examples and recording scripts make paid API calls. `scripts/record_flights.py <new-folder>` captures original browser timestamps; `scripts/render_demo.py <recording-folder>` renders that verified run at 1× and crops out the Google account strip. Credentials and raw traces stay ignored.

---

[Browser Use](https://github.com/browser-use/browser-use) · [Browser Harness](https://github.com/browser-use/browser-harness) · [TypeSafe speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)
