"""Observed actions through Browser Harness; one CDP session, no per-step subprocess."""

import hashlib
import json
import os
import sys
import time
from pathlib import Path

from .cdp import cdp, ensure_daemon

# Atomically read visible content and controls, preserving actual DOM node identity.
READ_STATE = Path(__file__).with_name("snapshot.js").read_text()
MARKER = f"(() => {{ const state={READ_STATE}; return state?.marker ?? null; }})()"
# Headed demos (JEV_SHOW=1): a pointer-transparent, aria-hidden cursor glides to the target and outlines it. It holds no
# text and no controls, so observations, fingerprints and the covered-target check are unchanged.
CURSOR = """((x, y, w, h, ms) => new Promise(done => {
  let c = document.getElementById('__jev_cursor'), box = document.getElementById('__jev_box');
  if (!c) {
    c = document.createElement('div'); c.id = '__jev_cursor'; c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;' +
      'background:no-repeat url("data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 ' +
      'viewBox=%220 0 22 22%22>' +
      '<path d=%22M2 1l17 9-7 2-3 7z%22 fill=%22%23111%22 stroke=%22white%22 stroke-width=%221.5%22/></svg>");' +
      'transform:translate(-40px,-40px);transition:none';
    box = document.createElement('div'); box.id = '__jev_box'; box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #f59e0b;' +
      'border-radius:6px;opacity:0;transition:opacity .15s';
    document.documentElement.append(c, box);
  }
  Object.assign(box.style, {left: (x - w / 2 - 4) + 'px', top: (y - h / 2 - 4) + 'px', width: (w + 8) + 'px',
                            height: (h + 8) + 'px', opacity: w ? '1' : '0'});
  const from = getComputedStyle(c).transform, to = `translate(${x - 2}px, ${y - 1}px)`;
  c.animate([{transform: from}, {transform: to}], {duration: ms, easing: 'cubic-bezier(.2,.7,.2,1)'})
    .finished.then(() => { c.style.transform = to; done(true); });
}))"""
RIPPLE = """((x, y) => { const r = document.createElement('div'); r.setAttribute('aria-hidden', 'true');
  r.style.cssText = `position:fixed;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border-radius:50%;` +
    'border:2px solid #f59e0b;z-index:2147483646;pointer-events:none';
  document.documentElement.append(r);
  r.animate([{transform: 'scale(.4)', opacity: 1}, {transform: 'scale(1.6)', opacity: 0}], {duration: 380})
    .finished.then(() => { r.remove(); document.getElementById('__jev_box')?.style.setProperty('opacity', '0'); });
})"""
SHOW_MOVE_MS = 220
SHOW_KEY_MS = 0.03

class StalePage(ValueError):
    """A decision no longer refers to the observed page."""


class Browser:
    def __init__(self, url, attach=False):
        ensure_daemon()
        self.show = os.environ.get("JEV_SHOW") == "1"
        self.owned = not attach
        if attach:
            # The user's own open tab: attach to it as it is. Never navigate, resize or close it.
            pages = [t for t in cdp("Target.getTargets")["targetInfos"] if t["type"] == "page" and t["url"] == url]
            if not pages:
                raise ValueError("That tab is not visible to the browser connection; reload it and try again.")
            self.target = pages[0]["targetId"]
            self.session = cdp("Target.attachToTarget", targetId=self.target, flatten=True)["sessionId"]
            self.call("Emulation.setFocusEmulationEnabled", enabled=True)  # keep rendering; nothing is resized
            return
        self.target = cdp("Target.createTarget", url="about:blank", background=not self.show)["targetId"]
        self.session = cdp("Target.attachToTarget", targetId=self.target, flatten=True)["sessionId"]
        self.call("Emulation.setDeviceMetricsOverride", width=1120, height=780, deviceScaleFactor=1, mobile=False)
        # Keep rAF/menus rendering in an owned background tab, without activating the user's Chrome tab.
        self.call("Emulation.setFocusEmulationEnabled", enabled=True)
        self.call("Page.navigate", url=url)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.evaluate("document.readyState") == "complete":
                break
            time.sleep(0.02)

    def call(self, method, **params):
        return cdp(method, session_id=self.session, **params)

    def evaluate(self, expression):
        response = self.call("Runtime.evaluate", expression=expression, returnByValue=True)
        if response.get("exceptionDetails"):
            raise StalePage("Document changed during evaluation")
        return response.get("result", {}).get("value")

    def observe(self, screenshot=True):
        if getattr(self, "after_input", None):
            action, self.after_input = self.after_input, None
            # This is read-only and happens after execution was logged, even if navigation interrupts it.
            try:
                self.call(
                    "Runtime.evaluate",
                    expression="""(action => new Promise(resolve => {
                      const field=window.__jevFast?.nodes.get(action.node);
                      const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
                      let frames=0, stopped=false;
                      const finish=()=>{stopped=true;resolve()};
                      setTimeout(finish,autocomplete ? 200 : 50);
                      const ready=()=>{
                        if (stopped) return;
                        const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
                          .split(/\\s+/).filter(Boolean);
                        const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
                        const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
                        if (++frames>=2 && (!autocomplete || options.some(e=>{
                          const r=e.getBoundingClientRect();
                          return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
                            e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
                        }))) finish();
                        else requestAnimationFrame(ready);
                      };
                      requestAnimationFrame(ready);
                    }))(""" + json.dumps(action) + ")",
                    awaitPromise=True,
                    returnByValue=True,
                )
            except RuntimeError:
                pass
        for attempt in range(10):
            try:
                return browser_operation(
                    {"operation": "observe", "session": self.session, "screenshot": screenshot}
                )
            except StalePage:
                if attempt == 9:
                    raise
                time.sleep(0.02)
        raise StalePage("Page did not settle")

    def fresh(self, page, action=None):
        if action is not None and action["kind"] in {"click", "select"}:
            node = action["node"]
            if type(node) is not int:
                return False
            current = self.evaluate(
                "(() => { const c=window.__jevFast; "
                f"return c ? [c.pageKey(),c.guard(c.nodes.get({node}))] : null; }})()"
            )
            return current == [page["page_key"], page["guards"].get(str(node))]
        return self.evaluate(MARKER) == page["marker"]

    def act(self, action, page, text=None):
        if not self.fresh(page, action):
            raise StalePage("Page changed since this decision. Observe again.")
        if action["kind"] == "wait":
            time.sleep(0.1)
        result = browser_operation({"operation": "act", "session": self.session, "action": action, "text": text,
                                    "show": self.show})
        self.after_input = action if action["kind"] != "wait" else None
        return result

    def close(self):
        if self.target:
            if self.owned:
                cdp("Target.closeTarget", targetId=self.target)
            else:
                cdp("Target.detachFromTarget", sessionId=self.session)
            self.target = None


def fingerprint(state):
    content = {k: state[k] for k in ("url", "text", "actions", "scroll")}
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


def browser_operation(request):
    operation = request["operation"]
    session = request["session"]

    def call(method, **params):
        return cdp(method, session_id=session, **params)

    def evaluate(expression):
        result = call("Runtime.evaluate", expression=expression, returnByValue=True)
        if result.get("exceptionDetails"):
            if operation == "act" and request["action"]["kind"] == "select":
                raise RuntimeError("Dropdown execution was interrupted; inspect before retrying.")
            raise StalePage("Document changed during evaluation")
        return result.get("result", {}).get("value")

    def show(x, y, w=0, h=0):
        # Display only: the target was resolved and hit-tested above, and input still goes through CDP below.
        if request.get("show"):
            try:
                call("Runtime.evaluate", expression=f"{CURSOR}({x},{y},{w},{h},{SHOW_MOVE_MS})", awaitPromise=True)
            except RuntimeError:
                pass

    if operation == "act":
        action = request["action"]
        kind = action["kind"]
        if kind == "scroll":
            show(550, 650)
            call("Input.dispatchMouseEvent", type="mouseWheel", x=550, y=650, deltaX=0, deltaY=action["delta"])
        elif kind != "wait":
            if type(action["node"]) is not int:
                raise ValueError("Invalid observed node")
            # Code-owned node IDs refer to actual observed elements, never model-generated selectors.
            target = evaluate("""(action => {
              const e=window.__jevFast?.nodes.get(action.node);
              if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
                  !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
              if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
              const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
              if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
              if (!e.contains(document.elementFromPoint(x,y))) return null;
              if (action.kind==='select') {
                if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
                    !o.disabled && !o.closest('optgroup[disabled]'))) return null;
                e.value=action.value;
                e.dispatchEvent(new Event('input',{bubbles:true}));
                e.dispatchEvent(new Event('change',{bubbles:true}));
              }
              return {x,y,w:r.width,h:r.height};
            })(""" + json.dumps(action) + ")")
            if target is None:
                if kind == "select":
                    raise RuntimeError("Dropdown execution was not confirmed; inspect before retrying.")
                raise StalePage("Target changed or is covered. Observe again.")
            show(target["x"], target["y"], target["w"], target["h"])
            if kind != "select":
                x, y = target["x"], target["y"]
                for event in ("mousePressed", "mouseReleased"):
                    call("Input.dispatchMouseEvent", type=event, x=x, y=y, button="left", clickCount=1)
                if request.get("show"):
                    call("Runtime.evaluate", expression=f"{RIPPLE}({x},{y})")
                if kind == "fill":
                    call(
                        "Input.dispatchKeyEvent",
                        type="keyDown",
                        key="a",
                        code="KeyA",
                        modifiers=4 if sys.platform == "darwin" else 2,
                        commands=["selectAll"],
                    )
                    call(
                        "Input.dispatchKeyEvent",
                        type="keyUp",
                        key="a",
                        code="KeyA",
                        modifiers=4 if sys.platform == "darwin" else 2,
                    )
                    if request.get("show"):
                        for character in request["text"]:
                            call("Input.insertText", text=character)
                            time.sleep(SHOW_KEY_MS)
                    else:
                        call("Input.insertText", text=request["text"])
        return {"executed": action["id"]}

    info = evaluate(READ_STATE)
    if info is None:
        raise StalePage("Document is navigating")
    info["fingerprint"] = fingerprint(info)
    if request.get("screenshot", True):
        info["screenshot"] = call("Page.captureScreenshot", format="jpeg", quality=72)["data"]
    return info
