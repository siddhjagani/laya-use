"""DevTools Protocol transport. Browser Harness by default; a direct WebSocket when JEV_CDP_WS is set.

Jev Browser (Electron) sets JEV_CDP_WS: Electron does not support every browser-level command the Harness daemon
uses, and the agent should talk only to its own browser, without a shared daemon in between."""

import itertools
import json
import os
import threading

DIRECT = os.environ.get("JEV_CDP_WS")
TIMEOUT = 15


class DirectCDP:
    """One flattened-session WebSocket; requests are serialized, events are ignored."""

    def __init__(self, url):
        from websockets.sync.client import connect

        self.socket = connect(url, max_size=None, open_timeout=TIMEOUT)
        self.ids = itertools.count(1)
        self.lock = threading.Lock()

    def send(self, method, session_id=None, **params):
        with self.lock:
            request = {"id": next(self.ids), "method": method, "params": params}
            if session_id:
                request["sessionId"] = session_id
            self.socket.send(json.dumps(request))
            while True:
                message = json.loads(self.socket.recv(timeout=TIMEOUT))
                if message.get("id") == request["id"]:
                    if "error" in message:
                        raise RuntimeError(f"{method}: {message['error'].get('message')}")
                    return message.get("result", {})


_client = None


def cdp(method, session_id=None, **params):
    global _client
    if not DIRECT:
        from browser_harness.helpers import cdp as harness

        return harness(method, session_id=session_id, **params)
    if _client is None:
        _client = DirectCDP(DIRECT)
    return _client.send(method, session_id=session_id, **params)


def ensure_daemon():
    if not DIRECT:
        from browser_harness.admin import ensure_daemon as harness

        harness()
