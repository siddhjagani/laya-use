"""TypeSafe makes choices; an optional small OpenAI-compatible model writes field values."""

import json
import math
import os
import time

import httpx

from .questions import NEXT_ACTION, TARGET, TEXT_VALUE

CLIENT = httpx.Client(http2=True, timeout=25)


def post_json(url, key, body):
    for attempt in range(3):
        try:
            response = CLIENT.post(url, json=body, headers={"Authorization": f"Bearer {key}"} if key else {})
        except httpx.HTTPError:
            raise RuntimeError("Model connection failed; no action executed.") from None
        if response.status_code in {429, 529, 503} and attempt < 2:
            time.sleep(0.5 * 2**attempt)
            continue
        if response.is_error:
            raise RuntimeError(f"Model provider returned HTTP {response.status_code}; no action executed.")
        return response.json()
    raise RuntimeError("Model unavailable")


def credential(base, name, consequence="no action executed"):
    """Hosted providers need a key. A loopback server (Kev, llama-server) runs on this machine and may have none."""
    key = os.environ.get(name, "")
    if not key and httpx.URL(base).host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError(f"{base} needs {name}; {consequence}.")
    return key


def validate_choice(answer, ids):
    try:
        probabilities = answer["probabilities"]
        numbers = [*probabilities.values(), answer["confidence"]]
        valid = (
            answer["choice"] in ids
            and set(probabilities) == set(ids)
            and all(type(n) in (int, float) and math.isfinite(n) and 0 <= n <= 1 for n in numbers)
            and abs(sum(probabilities.values()) - 1) < 0.02
            and probabilities[answer["choice"]] >= max(probabilities.values()) - 1e-6
        )
    except (KeyError, TypeError, ValueError):
        valid = False
    if not valid:
        raise ValueError("Invalid TypeSafe response; no action executed.")
    return answer


def action_space(actions):
    """One index per observed element; each operation has its own valid target choices."""
    elements, indices, targets, controls = [], {}, {}, {}
    operations = {"click": "CLICK", "fill": "TYPE_TEXT", "select": "SELECT"}
    for action in actions:
        kind = action["kind"]
        if kind not in operations:
            controls[action["id"].upper()] = action
            continue
        node = action["node"]
        if node not in indices:
            index = str(len(elements) + 1)
            indices[node] = index
            element = {k: action[k] for k in ("role", "value", "checked", "selected", "expanded") if k in action}
            element.update(index=index, label=action["label"].split(" → ")[0], operations=[])
            if kind == "select":
                element["value"] = action.get("current_value", "")
                element["options"] = []
            elements.append(element)
        index = indices[node]
        operation = operations[kind]
        group = targets.setdefault(operation, {})
        element = elements[int(index) - 1]
        if operation not in element["operations"]:
            element["operations"].append(operation)
        target = index
        if kind == "select":
            target = f"{index}:{len(element['options']) + 1}"
            element["options"].append({"index": target, "label": action["label"], "value": action["value"]})
        group[target] = action
    return elements, targets, controls


LABELS = [chr(c) for c in range(65, 91)] + [chr(c) for c in range(97, 123)]
NO_THINKING = {"chat_template_kwargs": {"enable_thinking": False}}  # hybrid-thinking templates answer directly
MONTHS = "january february march april may june july august september october november december".split()
VALUES = {}  # goal -> [(value, phrase)] it asks for, extracted once
OUTCOMES = {}  # goal -> the final visible outcome it asks for, extracted with the values
SEEN = {}  # goal -> values observed as set during the current run
DEFERRED = {}  # goal -> times the current run held DONE back while goal values were missing
HOLDS = 3
REFUSED = {}  # goal -> (page fingerprint, actions taken, choices the executor did not run on that page)
VALUES_PROMPT = """List the concrete values the user's goal asks to enter, select, or switch on: places, dates,
categories, filters, ticket types, counts. For each, copy the value exactly as the goal writes it, and copy the few goal
words around it that say where it belongs (for example "from Zurich"). Do not list the result to open, the final
outcome, or the goal as a whole. Separately, state the final visible outcome that shows the goal is complete.
Return JSON: {"values": [{"value": "...", "phrase": "..."}], "outcome": "..."}"""


def describe(action):
    """One observed action as plain text, with the state a small model needs to avoid redoing it."""
    kind, label, role = action["kind"], action["label"], action.get("role", "element")
    if kind == "fill":
        return f"type text into {role} '{label}' (current: {action.get('value') or 'empty'})"
    if kind == "select":
        field, option = label.split(" → ", 1)
        return f"select '{option}' in '{field}' (current: {action.get('current_value') or 'unset'})"
    if role in ("checkbox", "switch", "radio"):
        return f"click {role} '{label}' ({'checked' if str(action.get('checked')) == 'true' else 'unchecked'})"
    return f"click {role} '{label}'"


def words(text):
    return " ".join("".join(c if c.isalnum() else " " for c in str(text).lower()).split())


def goal_values(goal):
    """Values copied from the goal by the text model. A value the goal does not contain verbatim is dropped."""
    if goal not in VALUES:
        base = os.environ.get("TEXT_MODEL_BASE_URL", "").rstrip("/")
        values = []
        if base:
            key = credential(base, "TEXT_MODEL_API_KEY", "no goal values extracted")
            result = post_json(base + "/chat/completions", key, {
                "model": os.environ.get("TEXT_MODEL", "local"), "temperature": 0, "max_tokens": 200,
                "response_format": {"type": "json_schema", "json_schema": {"name": "values", "schema": {
                    "type": "object", "required": ["values", "outcome"], "additionalProperties": False,
                    "properties": {"outcome": {"type": "string", "maxLength": 160},
                                   "values": {"type": "array", "maxItems": 12, "items": {
                        "type": "object", "required": ["value", "phrase"], "additionalProperties": False,
                        "properties": {"value": {"type": "string", "maxLength": 80},
                                       "phrase": {"type": "string", "maxLength": 120}}}}}}}},
                "messages": [{"role": "system", "content": VALUES_PROMPT}, {"role": "user", "content": goal}],
                **NO_THINKING,
            })
            try:
                answer = json.loads(result["choices"][0]["message"]["content"])
                values, outcome = answer["values"], answer.get("outcome")
                if isinstance(outcome, str) and words(outcome):
                    OUTCOMES[goal] = outcome
            except (KeyError, IndexError, TypeError, ValueError):
                values = []
        kept = {}
        for item in values if isinstance(values, list) else []:
            value, phrase = (item.get("value"), item.get("phrase")) if isinstance(item, dict) else (None, None)
            if not isinstance(value, str) or not words(value) or words(value) not in words(goal):
                continue
            ok = (isinstance(phrase, str) and words(value) in words(phrase) and words(phrase) in words(goal)
                  and len(words(phrase).split()) <= len(words(value).split()) + 4)
            kept.setdefault(value, phrase if ok else value)
        VALUES[goal] = list(kept.items())
    return VALUES[goal]


def settings(actions):
    """What the page currently has set: field values, chosen options, checked toggles, selected tabs."""
    found = []
    for a in actions:
        if a["kind"] == "fill" or (a.get("role") == "combobox" and a.get("value")):
            found.append(a.get("value") or "")
        elif a["kind"] == "select":
            found.append(a.get("current_value") or "")
        elif str(a.get("checked")) == "true" or a.get("selected") is True or str(a.get("selected")) == "true":
            found.append(a["label"])
    return [words(f) for f in found if words(f)]


def is_set(value, current):
    """Whether a goal value already appears in a current setting; dates also match their short forms."""
    v = words(value)
    if any(v in s or s in v for s in current):
        return True
    month = next((m for m in MONTHS if m in v.split()), None)
    day = next((t for t in v.split() if t.isdigit() and len(t) <= 2), None)
    return bool(month and day) and any(month[:3] in s and day in s.split() for s in current)


def fits(action, missing):
    """Point a missing goal value at the input whose label shares the goal's words for it ("from" in "from Zurich")."""
    if action["kind"] not in ("fill", "select"):
        return ""
    label = set(words(action["label"].split(" → ")[0]).split())
    for phrase in missing:
        if label & set(words(phrase).split()):
            return f" - fits goal value '{phrase}'"
    return ""


def shortlist(options, goal, missing, limit):
    """At most `limit` options: inputs, toggles, controls and DONE first, then clicks that share words with the goal."""
    if len(options) <= limit:
        return options
    wanted = set(words(goal + " " + " ".join(missing)).split())

    def score(option):
        _, operation, _, text = option
        overlap = len(wanted & set(words(text).split()))
        always = operation not in ("CLICK",) or any(r in text for r in ("checkbox", "switch", "radio", "combobox"))
        return (always, overlap)

    keep = set(id(o) for o in sorted(options, key=score, reverse=True)[:limit])
    return [o for o in options if id(o) in keep]


def readout(base, key, prompt, count):
    """Next-token probabilities over the first `count` option letters, from one prefill of a local llama-server."""
    result = post_json(base + "/completion", key, {
        "prompt": prompt + "Best answer: [", "n_predict": 1, "n_probs": 100, "temperature": 0, "cache_prompt": True,
    })
    letters = {label: i for i, label in enumerate(LABELS[:count])}
    mass = [0.0] * count
    for token in result["completion_probabilities"][0]["top_logprobs"]:
        if token["token"].strip() in letters:
            mass[letters[token["token"].strip()]] += math.exp(token["logprob"])
    total = sum(mass)
    if not total:
        raise ValueError("Local decision model offered no observed option; no action executed.")
    return [m / total for m in mass], result


def ask(base, key, system, context, choices, question):
    """Lettered choice read from next-token probabilities, averaged over the given and the reversed option order.
    Small models favour some positions and letters; averaging the two orders cancels much of that bias."""
    passes, result, prompt = [], {}, ""
    for order in (list(range(len(choices))), list(reversed(range(len(choices))))):
        menu = "\n".join(f"[{LABELS[n]}] {choices[i]}" for n, i in enumerate(order))
        user = f"{context}\n\nOptions:\n{menu}\n\n{question}"
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        rendered = post_json(base + "/apply-template", key, {"messages": messages, **NO_THINKING})["prompt"]
        probabilities, answer = readout(base, key, rendered, len(choices))
        passes.append({i: probabilities[n] for n, i in enumerate(order)})
        if not prompt:
            prompt, result = rendered, answer
    return [sum(p[i] for p in passes) / len(passes) for i in range(len(choices))], result, prompt


def choose_local(state, goal, history):
    """One joint operation/target choice over observed actions, read from a small local model's next token.
    Code tracks which goal values are already set, so the model only has to pick the next step."""
    base = os.environ["DECISION_MODEL_BASE_URL"].rstrip("/")
    key = credential(base, "DECISION_MODEL_API_KEY")
    started = time.perf_counter()
    if not history:
        DEFERRED.pop(goal, None)
        SEEN.pop(goal, None)
    # Asked again on the same page with no new action: the last choice was refused (covered, moved, stale).
    page_key = (state.get("fingerprint"), len(history))
    last = REFUSED.get(goal)
    refused = last[2] if last and last[:2] == page_key else set()
    values = goal_values(goal)
    current = settings(state["actions"])
    seen = SEEN.setdefault(goal, set())
    typed = [words(h["text"]) for h in history if h.get("kind") == "fill" and h.get("text")]
    seen.update(v for v, _ in values if is_set(v, current) or is_set(v, typed))
    missing = [phrase for v, phrase in values if v not in seen]
    _, targets, controls = action_space(state["actions"])
    options = [(a["id"], operation, target, describe(a) + fits(a, missing)) for operation, group in targets.items()
               for target, a in group.items()]
    options += [(a["id"], operation, None, a["label"]) for operation, a in controls.items()]
    options.append(("DONE", "DONE", None, "done: every requirement of the goal is visibly satisfied"))
    options = shortlist([o for o in options if o[0] not in refused] or options, goal, missing, len(LABELS))
    lines = [f"Goal: {goal}", f"Page: {state['title']} ({state['url']})", "Visible text:", state["text"][:3000]]
    lines.append("Actions taken so far:" if history else "Actions taken so far: none")
    for h in history[-10:]:
        done = f"- {h.get('kind')} '{h.get('action')}'" + (f" with '{h['text']}'" if h.get("text") else "")
        lines.append(done + ("; the page did not change" if h.get("page_changed") is False else ""))
    if values:
        lines.append("Goal values already set: " + (", ".join(p for v, p in values if v in seen) or "none"))
        lines.append("Goal values not set yet: " + (", ".join(missing) or "none"))
    system = "You control a web browser. Choose the single next action that advances the user's entire goal."
    probabilities, result, prompt = ask(base, key, system, "\n".join(lines), [o[3] for o in options],
                                        "Which action should be taken next?")
    # Small models loop. An action already taken twice in the last six steps keeps a quarter of its weight.
    recent = [(h.get("kind"), h.get("action")) for h in history[-6:]]
    labels = {a["id"]: (a["kind"], a["label"]) for a in state["actions"]}
    probabilities = [p * (0.25 if recent.count(labels.get(o[0])) >= 2 else 1) for o, p in zip(options, probabilities)]
    total = sum(probabilities)
    probabilities = [p / total for p in probabilities]
    ranked = list(zip(options, probabilities))
    order = sorted(ranked, key=lambda pair: pair[1], reverse=True)
    # DONE while goal values are still unset is held back, at most HOLDS times a run, so a value the page never shows
    # cannot trap the agent; the runner-up acts instead. Text just typed is not submitted, so DONE never follows typing.
    just_typed = bool(history) and history[-1].get("kind") == "fill"
    held = DEFERRED.get(goal, 0)
    if order[0][0][0] == "DONE" and missing and not just_typed and OUTCOMES.get(goal):
        # The page can show the outcome even when a value is not visible in any field (a search that navigated).
        shown, _, _ = ask(base, key, "Answer about the current browser page.", "\n".join(lines),
                          ["yes", "no"], f"Does the current page visibly show this: {OUTCOMES[goal]}?")
        if shown[0] > 0.5:
            missing = []
    # Holding only helps when an input on this page can still take a missing value; otherwise leaving is worse.
    settable = any(o[1] in ("TYPE_TEXT", "SELECT") for o in options)
    if order[0][0][0] == "DONE" and len(order) > 1 and (just_typed or (missing and settable and held < HOLDS)):
        if not just_typed:
            DEFERRED[goal] = held + 1
        order = order[1:] + order[:1]
    (choice, operation, target, _), best = order[0]
    REFUSED[goal] = (*page_key, refused | {choice})
    operation_probabilities = {}
    for (_, op, _, _), p in ranked:
        operation_probabilities[op] = operation_probabilities.get(op, 0) + p
    chosen = [(o, p) for o, p in ranked if o[1] == operation]
    count = len(ranked)
    return {
        "choice": choice,
        "operation": operation,
        "target": target,
        "confidence": 1.0 if count == 1 else max(0.0, (best - 1 / count) / (1 - 1 / count)),
        "probabilities": {o[0]: p for o, p in chosen},
        "operation_probabilities": operation_probabilities,
        "target_probabilities": {o[2]: p for o, p in chosen if o[2] is not None},
        "target_confidence": None,
        "raw_answers": {"next": {o[0]: p for o, p in ranked}, "goal_values": [v for v, _ in values],
                        "missing": missing},
        "model": os.environ.get("DECISION_MODEL", "local"),
        "usage": {"input_tokens": result.get("tokens_evaluated"), "cached_tokens": result.get("tokens_cached")},
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "request": {"prompt": prompt},
    }


def choose(state, goal, history):
    if os.environ.get("DECISION_MODEL_BASE_URL"):
        return choose_local(state, goal, history)
    elements, targets, controls = action_space(state["actions"])
    labels = {
        "CLICK": "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
        "TYPE_TEXT": "Enter or replace text in an editable field. A small LLM will supply the value from the goal.",
        "SELECT": "Select an observed dropdown value.",
    }
    operations = {key: labels[key] for key in targets}
    operations.update({key: value["label"] for key, value in controls.items()})
    operations.update(DONE="Every requirement is visibly satisfied.", BLOCKED="No supported operation can progress.")
    questions = {
        "operation": {"type": "choice", "criteria": operations, "instructions": {"goal": goal, "rules": NEXT_ACTION}}
    }
    for operation, candidates in targets.items():
        questions[operation.lower() + "_target"] = {
            "type": "choice",
            "criteria": {
                index: {
                    "element": f"[{index}] {a['label']}",
                    "current_value": a.get("current_value", a.get("value", "")),
                    **{k: a[k] for k in ("role", "checked", "selected", "expanded") if k in a},
                }
                for index, a in candidates.items()
            },
            "instructions": {"goal": goal, "operation": operation, "rules": [NEXT_ACTION, TARGET]},
        }
    body = {
        "model": os.environ.get("TYPESAFE_MODEL", "jev-latest"),
        "state": {
            "page": {k: state[k] for k in ("url", "title", "text")},
            "elements": elements,
            "recent_actions": [
                {k: h.get(k) for k in ("action", "kind", "text", "page_changed")} for h in history[-10:]
            ],
        },
        "questions": questions,
    }
    # Any System One server: TypeSafe's hosted Jev, or a local Kev (`python -m kev.serve`), which serves the same API.
    base = os.environ.get("TYPESAFE_BASE_URL", "https://api.typesafe.ai").rstrip("/")
    key = credential(base, "TYPESAFE_API_KEY")
    started = time.perf_counter()
    result = post_json(base + "/v1/systemone", key, body)
    operation_answer = validate_choice(result["answers"].get("operation", {}), operations)
    operation = operation_answer["choice"]
    target = None
    target_answer = None
    probabilities = {}
    if operation in targets:
        # Unused target heads cannot cause an action. Validate the head selected by the operation.
        target_answer = validate_choice(result["answers"].get(operation.lower() + "_target", {}), targets[operation])
        target = target_answer["choice"]
        choice = targets[operation][target]["id"]
        probabilities = {a["id"]: target_answer["probabilities"][index] for index, a in targets[operation].items()}
    else:
        choice = controls[operation]["id"] if operation in controls else operation
        probabilities[choice] = operation_answer["probabilities"][operation]
    return {
        "choice": choice,
        "operation": operation,
        "target": target,
        "confidence": operation_answer["confidence"],
        "probabilities": probabilities,
        "operation_probabilities": operation_answer["probabilities"],
        "target_probabilities": target_answer["probabilities"] if target_answer else {},
        "target_confidence": target_answer["confidence"] if target_answer else None,
        "raw_answers": result["answers"],
        "model": result["model"],
        "usage": result.get("usage", {}),
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "request": body,
    }


def field_context(goal, action, page, history):
    return {
        "goal": goal,
        "field": {k: action.get(k) for k in ("label", "role", "value")},
        "page": {"title": page["title"], "text": page["text"][:6000]},
        "recent_actions": [{k: h.get(k) for k in ("action", "text")} for h in history[-6:]],
    }


def choose_value(context):
    """Local mode: the model picks the field's value among goal values not yet set elsewhere, in one averaged readout.
    "Something else" hands the field to free generation, so values outside the list still work."""
    base = os.environ["DECISION_MODEL_BASE_URL"].rstrip("/")
    key = credential(base, "DECISION_MODEL_API_KEY")
    field = context["field"]
    seen = SEEN.get(context["goal"], set())
    label = set(words(field.get("label") or "").split())
    values = [(v, p) for v, p in VALUES.get(context["goal"]) or [] if v not in seen]
    if not values:
        return None
    started = time.perf_counter()
    choices = [f"{v} (goal: {p}{'; fits this field' if label & set(words(p).split()) else ''})" for v, p in values]
    choices.append("something else: none of these values belongs in this field")
    probabilities, result, _ = ask(
        base, key, "Choose the value from the user's goal that belongs in this field.",
        f"Goal: {context['goal']}\nField: {field.get('role') or 'field'} '{field.get('label')}' "
        f"(current: {field.get('value') or 'empty'})", choices, "Which value should be typed into this field?")
    best = max(range(len(choices)), key=probabilities.__getitem__)
    if best == len(values):
        return None
    return values[best][0], {
        "model": os.environ.get("TEXT_MODEL", "local") + " (goal-value readout)",
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "usage": {"input_tokens": result.get("tokens_evaluated")},
        "probability": probabilities[best],
    }


def field_text(context):
    if os.environ.get("DECISION_MODEL_BASE_URL") and (picked := choose_value(context)):
        return picked
    base = os.environ.get("TEXT_MODEL_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
    key = credential(base, "TEXT_MODEL_API_KEY", "no text is hardcoded or guessed by the executor")
    model = os.environ.get("TEXT_MODEL", "deepseek-chat")
    reasoning = {"thinking": {"type": "disabled"}} if "api.deepseek.com/" in base else {"reasoning": {"effort": "low"}}
    if os.environ.get("TEXT_MODEL_REASONING") == "none":
        reasoning = {"reasoning": {"enabled": False}}
    started = time.perf_counter()
    result = post_json(
        base + "/chat/completions",
        key,
        {
            "model": model,
            "max_tokens": 1024,
            "response_format": {"type": "json_object"},
            **reasoning,
            "messages": [
                {"role": "system", "content": TEXT_VALUE},
                {
                    "role": "user",
                    "content": json.dumps(context),
                },
            ],
        },
    )
    try:
        output = json.loads(result["choices"][0]["message"]["content"])
        value = output["text"]
        if set(output) != {"text"} or not isinstance(value, str) or not value.strip() or len(value) > 2000:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise ValueError("Text helper returned no valid field value; nothing typed.") from None
    return value, {
        "model": model,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "usage": result.get("usage", {}),
    }
