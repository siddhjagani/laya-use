"""Offline checks for the extension's chat server. No browser or model calls."""

import os
import threading
import time
from http.server import ThreadingHTTPServer

import httpx
import pytest

from jev_ultrafast import chat


@pytest.fixture
def server(monkeypatch):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), chat.Handler)
    monkeypatch.setattr(chat, "PORT", httpd.server_address[1])
    monkeypatch.setattr(chat, "TOKEN", "secret")
    monkeypatch.setattr(chat, "RUN", {"id": 0, "events": [], "stop": False, "busy": False, "pending": None,
                                      "answer": None})
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{chat.PORT}"
    httpd.shutdown()


EXT = {"Origin": "chrome-extension://abc", "X-Jev-Token": "secret"}


def test_requests_need_the_extension_origin_and_token(server):
    assert httpx.post(server + "/api/ping", json={}, headers={"X-Jev-Token": "secret"}).json() == {"ok": True}
    assert httpx.post(server + "/api/ping", json={}).status_code == 403
    assert httpx.post(server + "/api/ping", json={}, headers={**EXT, "X-Jev-Token": "wrong"}).status_code == 403
    assert httpx.post(server + "/api/ping", json={},
                      headers={**EXT, "Origin": "https://evil.example"}).status_code == 403
    assert httpx.post(server + "/api/ping", json={}, headers=EXT).json() == {"ok": True}


def test_one_goal_at_a_time_on_web_pages_only(server, monkeypatch):
    started = threading.Event()
    monkeypatch.setattr(chat, "run", lambda goal, url: started.set())
    page = httpx.post(server + "/api/run", json={"goal": "x", "url": "chrome://settings"}, headers=EXT)
    assert page.status_code == 400
    assert httpx.post(server + "/api/run", json={"goal": "Open it", "url": "https://a.test/"}, headers=EXT).is_success
    assert started.wait(2)
    busy = httpx.post(server + "/api/run", json={"goal": "Again", "url": "https://a.test/"}, headers=EXT)
    assert busy.status_code == 409


def test_steps_read_as_plain_chat_lines():
    typed = chat.describe({"kind": "fill", "action": "Where from?", "text": "Zurich"})
    assert typed == "Typed “Zurich” into Where from?"
    assert chat.describe({"kind": "click", "action": "Search"}) == "Clicked Search"


def test_risky_clicks_wait_for_the_user_and_deny_by_default(server, monkeypatch):
    assert chat.risky({"kind": "click", "label": "Place order"})
    assert chat.risky({"kind": "click", "label": "Send message"})
    assert not chat.risky({"kind": "click", "label": "Find stays"})
    assert not chat.risky({"kind": "fill", "label": "Delete reason"})
    assert chat.confirm({"kind": "click", "label": "Find stays"})

    results = []
    worker = threading.Thread(target=lambda: results.append(chat.confirm({"kind": "click", "label": "Pay now"})))
    worker.start()
    for _ in range(50):
        if chat.RUN["pending"]:
            break
        time.sleep(0.02)
    events = httpx.get(server + "/api/events?since=0", headers=EXT).json()
    assert events["pending"] == "Pay now" and events["events"][-1]["kind"] == "confirm"
    assert httpx.post(server + "/api/confirm", json={"allow": True}, headers=EXT).is_success
    worker.join(2)
    assert results == [True]

    monkeypatch.setattr(chat, "CONFIRM_SECONDS", 0.2)
    assert chat.confirm({"kind": "click", "label": "Delete account"}) is False
    assert httpx.post(server + "/api/confirm", json={"allow": True}, headers=EXT).status_code == 409


def test_sidecars_notice_when_their_app_is_gone(monkeypatch):
    import subprocess

    from jev_ultrafast import local

    monkeypatch.delenv("JEV_PARENT_PID", raising=False)
    assert local.parent_gone() is False
    child = subprocess.Popen(["sleep", "0"])
    child.wait()
    monkeypatch.setenv("JEV_PARENT_PID", str(child.pid))
    assert local.parent_gone() is True
    monkeypatch.setenv("JEV_PARENT_PID", str(os.getpid()))
    assert local.parent_gone() is False
