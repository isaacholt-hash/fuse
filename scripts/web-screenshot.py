#!/usr/bin/env python3
"""Screenshot a web page at a given size with WebKitGTK (M10 step 5): HULK has no browser.

Loads URL in a WebKit2 WebView of WIDTHxHEIGHT, runs the steps in the order given, waits for
the page to settle, and saves a PNG of what's visible.

Usage:
  xvfb-run -a python3 scripts/web-screenshot.py URL OUT.png [--size 1280x800] [steps...]

Steps, run in order after the page has loaded:
  --wait-text TEXT   wait until the page's text contains TEXT
  --js CODE          run JavaScript in the page (fill() and click() below are defined)
  --sleep SECS       wait a while
  --click TEXT       click the first button or link whose text is TEXT

In --js code, fill(selector, value) sets a React-controlled input and click(text) clicks a
button by its text. Every step times out after --timeout seconds (default 30), and the shot
is taken --settle seconds (default 1.5) after the last step.

Run it under Xvfb with WebKit's software rendering, as scripts/screenshot.sh does:
  WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 \\
    xvfb-run -a python3 scripts/web-screenshot.py http://localhost:4197/ shot.png --size 390x844

Each run is a fresh, private browser: nothing (cookies, storage) is kept between runs.
To start signed in, pass --cookies with a curl cookie jar (`curl -c jar`) from a sign-in.
"""

import argparse
import json
import sys
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

HELPERS = r"""
window.fill = (selector, value) => {
  const el = document.querySelector(selector);
  if (!el) throw new Error("No element " + selector);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
window.click = (text) => {
  const all = [...document.querySelectorAll("button, a, [role=button], [role=radio]")];
  // Its whole text or label, else text that starts with it (a button with a shortcut hint).
  const el =
    all.find((b) => b.textContent.trim() === text || b.getAttribute("aria-label") === text) ??
    all.find((b) => b.textContent.trim().startsWith(text));
  if (!el) throw new Error("No button " + text);
  el.click();
};
"""


def read_cookie_jar(path):
    """The cookies in a curl (Netscape format) cookie jar, as Soup cookies.

    They're added without their Secure flag: WebKitGTK keeps no Secure cookie from a plain
    http:// page, and a throwaway fuse-server on localhost has no TLS (on the tailnet,
    `tailscale serve` adds it).
    """
    gi.require_version("Soup", "3.0")
    from gi.repository import Soup

    cookies = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            http_only = line.startswith("#HttpOnly_")
            if http_only:
                line = line[len("#HttpOnly_") :]
            elif line.startswith("#") or not line.strip():
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 7:
                continue
            domain, _sub, path_, _secure, _expires, name, value = parts
            cookie = Soup.Cookie.new(name, value, domain, path_, -1)
            cookie.set_http_only(http_only)
            cookies.append(cookie)
    return cookies


class StepAction(argparse.Action):
    """Keeps every step flag, in the order given, in one list."""

    def __call__(self, parser, namespace, values, option_string=None):
        steps = getattr(namespace, "steps", None) or []
        steps.append((self.dest, values))
        namespace.steps = steps


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("url")
    p.add_argument("out")
    p.add_argument("--size", default="1280x800", help="WIDTHxHEIGHT (default 1280x800)")
    p.add_argument("--timeout", type=float, default=30.0)
    p.add_argument("--settle", type=float, default=1.5)
    p.add_argument(
        "--cookies",
        help="a curl cookie jar (curl -c FILE) to start with, e.g. a session signed in by curl",
    )
    for flag in ("wait-text", "js", "sleep", "click"):
        p.add_argument(f"--{flag}", dest=flag.replace("-", "_"), action=StepAction)
    p.set_defaults(steps=[])
    args = p.parse_args(argv)
    try:
        w, h = (int(n) for n in args.size.lower().split("x"))
    except ValueError:
        p.error("--size must look like 1280x800")
    args.width, args.height = w, h
    return args


class Shot:
    def __init__(self, args):
        self.args = args
        self.steps = list(args.steps)
        self.error = None
        # A private, throwaway session: no cookies or storage from anywhere else.
        context = WebKit2.WebContext.new_ephemeral()
        self.view = WebKit2.WebView.new_with_context(context)
        settings = self.view.get_settings()
        settings.set_enable_developer_extras(False)
        settings.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
        self.window = Gtk.OffscreenWindow()
        self.window.set_default_size(args.width, args.height)
        self.window.add(self.view)
        self.window.show_all()
        self.view.connect("load-changed", self.on_load)
        self.view.connect("load-failed", self.on_load_failed)
        self.started = False
        self.deadline = time.monotonic() + args.timeout
        total = args.timeout * (len(self.steps) + 2) + args.settle + 5
        GLib.timeout_add(int(total * 1000), self.on_overall_timeout)
        cookies = read_cookie_jar(args.cookies) if args.cookies else []
        self.add_cookies(context.get_cookie_manager(), cookies)

    def add_cookies(self, manager, cookies):
        """Adds the cookies one by one (each add is async), then loads the page."""
        if not cookies:
            self.view.load_uri(self.args.url)
            return

        def added(m, result):
            try:
                m.add_cookie_finish(result)
            except GLib.Error as e:
                self.fail(f"Couldn't add a cookie: {e.message}")
                return
            self.add_cookies(m, cookies[1:])

        manager.add_cookie(cookies[0], None, added)

    # -- helpers --------------------------------------------------------------------------

    def fail(self, message):
        self.error = message
        Gtk.main_quit()

    def run_js(self, code, done):
        """Runs `code` in the page; `done(value_as_string_or_None, error_or_None)`."""

        def finished(view, result):
            try:
                if hasattr(view, "evaluate_javascript_finish"):
                    value = view.evaluate_javascript_finish(result)
                    text = value.to_string() if value is not None else None
                else:
                    value = view.run_javascript_finish(result)
                    text = value.get_js_value().to_string() if value is not None else None
                done(text, None)
            except GLib.Error as e:
                done(None, e.message)

        if hasattr(self.view, "evaluate_javascript"):
            self.view.evaluate_javascript(code, -1, None, None, None, finished)
        else:
            self.view.run_javascript(code, None, finished)

    # -- the sequence ---------------------------------------------------------------------

    def on_load_failed(self, _view, _event, uri, error):
        self.fail(f"Couldn't load {uri}: {error.message}")
        return True

    def on_load(self, _view, event):
        if event == WebKit2.LoadEvent.FINISHED and not self.started:
            self.started = True
            self.run_js(HELPERS + "true", lambda _v, e: self.fail(e) if e else self.ready())

    def ready(self):
        # Wait for the document itself, then go through the steps.
        self.poll("document.readyState === 'complete'", self.next_step, "the page to load")

    def poll(self, condition, then, what):
        self.deadline = time.monotonic() + self.args.timeout

        def check():
            self.run_js(f"Boolean({condition})", answered)
            return False

        def answered(value, error):
            if error:
                self.fail(f"Waiting for {what}: {error}")
            elif value == "true":
                then()
            elif time.monotonic() > self.deadline:
                # Say what the page shows instead, to see why.
                self.run_js(
                    "document.body ? document.body.innerText.slice(0, 400) : ''",
                    lambda text, _e: self.fail(
                        f"Timed out waiting for {what}. The page says: {text!r}"
                    ),
                )
            else:
                GLib.timeout_add(200, check)

        check()

    def next_step(self):
        if not self.steps:
            GLib.timeout_add(int(self.args.settle * 1000), self.snapshot)
            return
        kind, value = self.steps.pop(0)
        if kind == "wait_text":
            self.poll(
                f"document.body && document.body.innerText.includes({json.dumps(value)})",
                self.next_step,
                f"the text {value!r}",
            )
        elif kind == "sleep":

            def later():
                self.next_step()
                return False

            GLib.timeout_add(int(float(value) * 1000), later)
        elif kind in ("js", "click"):
            code = value if kind == "js" else f"click({json.dumps(value)})"
            wrapped = f"(() => {{ {code}; return true; }})()"
            self.run_js(wrapped, lambda _v, e: self.fail(f"{kind} {value!r}: {e}") if e else self.next_step())

    def snapshot(self):
        # The offscreen window's own pixels: no pycairo needed (HULK's python3 has none, so
        # WebView.get_snapshot's cairo surface can't reach Python).
        pixbuf = self.window.get_pixbuf()
        if pixbuf is None:
            self.fail("The window has nothing to save.")
            return False
        pixbuf.savev(self.args.out, "png", [], [])
        print(f"Screenshot: {self.args.out} ({pixbuf.get_width()}x{pixbuf.get_height()})")
        Gtk.main_quit()
        return False

    def on_overall_timeout(self):
        # Every wait has its own timeout; this catches a page that never finishes loading.
        if self.error is None:
            self.fail("Timed out.")
        return False


def main(argv):
    args = parse_args(argv)
    shot = Shot(args)
    Gtk.main()
    if shot.error:
        print(f"web-screenshot: {shot.error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
