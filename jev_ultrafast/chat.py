"""Loopback chat server for the browser extension: one goal at a time, run on the user's current tab."""

import json
import os
import re
import secrets
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .agent import Agent
from .demo import load_environment

PORT = int(os.environ.get("JEV_CHAT_PORT", "8767"))
TOKEN = os.environ.get("JEV_CHAT_TOKEN") or secrets.token_urlsafe(16)
LOCK = threading.Lock()
RUN = {"id": 0, "events": [], "stop": False, "busy": False, "pending": None, "answer": None}
ANSWERED = threading.Condition(LOCK)
CONFIRM_SECONDS = 120
# Clicks that can spend money, send something, or delete something wait for the user's approval.
RISKY = re.compile(r"\b(buy|pay|payment|purchase|order|checkout|check out|send|transfer|delete|remove|donate|"
                   r"subscribe|book now|confirm|place|sign up)\b", re.I)


def risky(action):
    return action.get("kind") in {"click", "select"} and bool(RISKY.search(action.get("label", "")))


def confirm(action):
    """Pause before a risky action until the user allows or denies it in the chat (denied on timeout or Stop)."""
    if not risky(action) or os.environ.get("JEV_CONFIRM") == "0":
        return True
    label = action["label"].split(" → ")[-1]
    with LOCK:
        RUN.update(pending=label, answer=None)
        RUN["events"].append({"n": len(RUN["events"]), "kind": "confirm", "at": time.time(), "label": label,
                              "text": f"The next step clicks “{label}”. Allow it?"})
        deadline = time.time() + CONFIRM_SECONDS
        while RUN["answer"] is None and not RUN["stop"] and time.time() < deadline:
            ANSWERED.wait(timeout=0.5)
        allowed = RUN["answer"] is True and not RUN["stop"]
        RUN.update(pending=None, answer=None)
    emit("status", f"Allowed: {label}" if allowed else f"Not allowed: {label}. Stopped before clicking it.")
    return allowed


def describe(step):
    """One executed action as a chat line."""
    action, kind = step.get("action", ""), step.get("kind")
    if kind == "fill":
        return f"Typed “{step.get('text')}” into {action}"
    if kind == "select":
        return f"Selected {action}"
    if kind == "scroll":
        return "Scrolled the page"
    if kind == "wait":
        return "Waited for the page to update"
    return f"Clicked {action}"


def emit(kind, text, **extra):
    with LOCK:
        RUN["events"].append({"n": len(RUN["events"]), "kind": kind, "text": text, "at": time.time(), **extra})


def run(goal, url):
    emit("status", "Working on your current tab…")
    seen = 0
    try:
        with Agent(url, goal, attach=True, confirm=confirm) as agent:
            for state in agent.run():
                for step in state["history"][seen:]:
                    emit("step", describe(step), ms=step.get("elapsed_ms"))
                seen = len(state["history"])
                if RUN["stop"]:
                    emit("final", "Stopped. Nothing else will be done.")
                    return
                if len(state["history"]) >= 40:
                    emit("final", "Stopped after 40 actions without finishing.")
                    return
            state = agent.snapshot()
            for step in state["history"][seen:]:
                emit("step", describe(step), ms=step.get("elapsed_ms"))
            seconds = state["elapsed_ms"] / 1000
            if state["status"] == "done":
                emit("final", f"Done in {seconds:.1f} s. Please check the page: the agent's own “done” is not proof.")
            elif state["status"] == "stopped":
                emit("final", "Stopped without doing that step.")
            else:
                emit("final", f"I could not make progress after {seconds:.1f} s and stopped.")
    except Exception as error:  # every failure is reported to the panel; nothing is retried
        emit("error", str(error) or error.__class__.__name__)
        traceback.print_exc()
    finally:
        with LOCK:
            RUN["busy"] = False


class Handler(BaseHTTPRequestHandler):
    def allowed(self):
        # Extensions send their own origin; the Jev Browser main process sends none. Web pages always send an
        # Origin on these requests, so a page cannot drive the agent even if it guessed the port.
        origin = self.headers.get("Origin")
        return (self.headers.get("Host") == f"127.0.0.1:{PORT}"
                and (origin is None or origin.startswith(("chrome-extension://", "moz-extension://")))
                and secrets.compare_digest(self.headers.get("X-Jev-Token", ""), TOKEN))

    def send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self.allowed():
            return self.send(403, {"error": "Pair the extension with the token printed by jev-chat."})
        if self.path.startswith("/api/events"):
            since = int(self.path.partition("since=")[2] or 0)
            with LOCK:
                return self.send(200, {"run": RUN["id"], "busy": RUN["busy"], "pending": RUN["pending"],
                                       "events": RUN["events"][since:]})
        self.send(404, {"error": "Not found"})

    def do_POST(self):
        if not self.allowed():
            return self.send(403, {"error": "Pair the extension with the token printed by jev-chat."})
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 65536)) or b"{}")
        except ValueError:
            return self.send(400, {"error": "Invalid JSON"})
        if self.path == "/api/run":
            goal, url = str(body.get("goal", "")).strip(), str(body.get("url", ""))
            if not goal or not url.startswith(("http://", "https://")):
                return self.send(400, {"error": "Open a web page and type a goal."})
            with LOCK:
                if RUN["busy"]:
                    return self.send(409, {"error": "Already working on a goal. Stop it first."})
                RUN.update(id=RUN["id"] + 1, events=[], stop=False, busy=True, pending=None, answer=None)
            threading.Thread(target=run, args=(goal[:2000], url), daemon=True).start()
            return self.send(200, {"run": RUN["id"]})
        if self.path == "/api/stop":
            with LOCK:
                RUN["stop"] = True
                ANSWERED.notify_all()
            return self.send(200, {"stopping": RUN["busy"]})
        if self.path == "/api/confirm":
            with LOCK:
                if RUN["pending"] is None:
                    return self.send(409, {"error": "Nothing is waiting for approval."})
                RUN["answer"] = body.get("allow") is True
                ANSWERED.notify_all()
            return self.send(200, {"ok": True})
        if self.path == "/api/ping":
            return self.send(200, {"ok": True})
        self.send(404, {"error": "Not found"})

    def log_message(self, *_args):
        pass


def watch_parent():
    from .local import parent_gone

    while not parent_gone():
        time.sleep(1)
    os._exit(0)  # the app that started this server is gone; never keep driving its browser


def main():
    load_environment()
    threading.Thread(target=watch_parent, daemon=True).start()
    os.environ.setdefault("JEV_SHOW", "1")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Jev chat on http://127.0.0.1:{PORT}\nPairing token: {TOKEN}\n", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
