#!/usr/bin/env python3
"""Load the demo in a real headless browser and report what it rendered.

verify.mjs proves the engine executes SQL/PGQ under Node. This proves the thing
issue #28 actually asks for: the same bundle running in a browser, in a Web
Worker, rendering rows. The two are not the same path — the browser adds module
workers, fetch, and browser WebAssembly instantiation.

Chrome's --dump-dom is no use here: it fires on the load event, long before the
worker has booted Postgres, so it reports an empty page. This drives the
DevTools Protocol instead and polls until the page reaches a verdict.

Usage:  python3 browser-check.py <url> [--chrome /path/to/chrome]
Exits non-zero if any statement card failed, if the page never reached a
verdict, or if the reported server is not PostgreSQL 19.

Pure standard library on purpose: CI should not need a browser automation
framework to run this.
"""
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

DEFAULT_CHROME_CANDIDATES = [
    os.environ.get("CHROME_PATH", ""),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
]


def find_chrome(explicit=None):
    for cand in ([explicit] if explicit else []) + DEFAULT_CHROME_CANDIDATES:
        if not cand:
            continue
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
        found = shutil.which(cand)
        if found:
            return found
    return None


class WebSocket:
    """Just enough RFC 6455 client to speak CDP: text frames, client masking."""

    def __init__(self, url):
        _, rest = url.split("://", 1)
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\n"
            f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise IOError("handshake failed")
            buf += chunk
        self.buf = buf.split(b"\r\n\r\n", 1)[1]

    def send(self, obj):
        data = json.dumps(obj).encode()
        header = bytearray([0x81])
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        self.sock.sendall(
            bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        )

    def _read_exactly(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        while True:
            b0, b1 = self._read_exactly(2)
            opcode = b0 & 0x0F
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read_exactly(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read_exactly(8))[0]
            payload = self._read_exactly(length)
            if opcode == 1:
                return json.loads(payload)
            if opcode == 8:
                raise EOFError("websocket closed by peer")


CARD_SUMMARY_JS = """
[...document.querySelectorAll('#statements .card')].map(c => {
  const tag  = c.querySelector('.tag')?.textContent || '';
  const cls  = c.className.replace('card ', '');
  const meta = c.querySelector('.meta')?.textContent || '';
  const err  = c.querySelector('.error')?.textContent || '';
  const heads = [...c.querySelectorAll('thead th')].map(t => t.textContent);
  const rows  = [...c.querySelectorAll('tbody tr')]
                  .map(r => [...r.querySelectorAll('td')].map(t => t.textContent).join(' | '));
  return `[${cls}] ${tag} ${meta}${err ? ' ERROR: ' + err : ''}` +
         (heads.length ? '\\n    ' + heads.join(' | ') + '\\n    ' + rows.join('\\n    ') : '');
}).join('\\n')
"""


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8899/"
    explicit = None
    if "--chrome" in sys.argv:
        explicit = sys.argv[sys.argv.index("--chrome") + 1]

    chrome = find_chrome(explicit)
    if not chrome:
        print("browser-check: FAIL - no Chrome/Chromium found", file=sys.stderr)
        return 2

    port = 9223
    profile = tempfile.mkdtemp(prefix="browser-check-")
    proc = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
         "--no-first-run", "--no-default-browser-check",
         f"--remote-debugging-port={port}", f"--user-data-dir={profile}", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    try:
        ws_url = None
        for _ in range(60):
            try:
                targets = json.load(
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/json")
                )
                for t in targets:
                    if t.get("type") == "page" and "devtools" not in t.get("url", ""):
                        ws_url = t["webSocketDebuggerUrl"]
                        break
                if ws_url:
                    break
            except Exception:
                pass
            time.sleep(1)

        if not ws_url:
            print("browser-check: FAIL - browser never exposed a page target", file=sys.stderr)
            return 3

        ws = WebSocket(ws_url)
        counter = {"id": 0}

        def evaluate(expression):
            counter["id"] += 1
            mid = counter["id"]
            ws.send({"id": mid, "method": "Runtime.evaluate",
                     "params": {"expression": expression, "returnByValue": True}})
            while True:
                msg = ws.recv()
                if msg.get("id") == mid:
                    return msg.get("result", {}).get("result", {}).get("value")

        deadline = time.time() + 300
        verdict = ""
        while time.time() < deadline:
            verdict = evaluate(
                "document.getElementById('verdict')?.textContent || ''") or ""
            if verdict and not verdict.startswith("Running"):
                break
            time.sleep(2)

        version = evaluate("document.getElementById('fact-version')?.textContent || ''") or ""
        boot = evaluate(
            "[...document.querySelectorAll('#boot-steps li')]"
            ".map(l => l.className + ' | ' + l.textContent).join('\\n')") or ""
        cards = evaluate(CARD_SUMMARY_JS) or ""
        failed = evaluate("document.querySelectorAll('#statements .card.failed').length")
        total = evaluate("document.querySelectorAll('#statements .card').length")

        print(f"browser-check: {chrome}")
        print(f"browser-check: server reports: {version}")
        print(boot)
        print(cards)
        print(f"browser-check: verdict: {verdict}")

        if not verdict or verdict.startswith("Running"):
            print("browser-check: FAIL - page never reached a verdict", file=sys.stderr)
            return 4
        if "PostgreSQL 19" not in version:
            print(f"browser-check: FAIL - expected PostgreSQL 19, got: {version}", file=sys.stderr)
            return 5
        if not total:
            print("browser-check: FAIL - no statements rendered", file=sys.stderr)
            return 6
        if failed:
            print(f"browser-check: FAIL - {failed} of {total} statements failed in the browser",
                  file=sys.stderr)
            return 7

        print(f"browser-check: OK - {total} statements executed in the browser")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
