#!/usr/bin/env python3
"""A hidden terminal window for the own-terminal trial (try-own-terminal.js).

It stands in for Terminal or iTerm2: a pty with a pyte screen, driven over
stdin and stdout with one JSON object per line.

  {"op": "spawn", "argv": [...], "env": {...}, "cwd": "...", "rows": 40, "cols": 120}
  {"op": "write", "b64": "..."}          bytes, as the terminal would send keys or a paste
  {"op": "resize", "rows": 30, "cols": 90}
  {"op": "screen"}                       -> {"screen": [lines], "raw": <bytes received so far, b64>}
  {"op": "close"}                        close the window: the pty hangs up
  {"op": "wait", "secs": 5}              -> {"exit": code or null}

Every request gets one reply line. Needs pyte (pip install pyte).
"""
import base64, fcntl, json, os, pty, select, signal, struct, sys, termios, threading, time
import pyte

lock = threading.Lock()
state = {"fd": None, "pid": None, "screen": None, "stream": None, "raw": bytearray(), "exit": None}


class Screen(pyte.Screen):
    # Answer the program's terminal queries, as a real terminal would.
    def write_process_input(self, data):
        if state["fd"] is not None:
            try: os.write(state["fd"], data.encode())
            except OSError: pass

    # tmux asks with private-mode queries (CSI ? 6 n) that pyte's own method refuses.
    def report_device_status(self, mode, **kwargs):
        super().report_device_status(mode)


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def pump():
    while True:
        fd = state["fd"]
        if fd is None: return
        try:
            r, _, _ = select.select([fd], [], [], 0.05)
        except (OSError, ValueError):
            return
        if not r: continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            return
        with lock:
            state["raw"].extend(data)
            try: state["stream"].feed(data)
            except Exception as err: sys.stderr.write("pyte: %r\n" % err)


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    req = json.loads(line)
    op = req["op"]
    if op == "spawn":
        rows, cols = req.get("rows", 40), req.get("cols", 120)
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(req["cwd"])
            os.execvpe(req["argv"][0], req["argv"], req["env"])
        set_size(fd, rows, cols)
        state.update(fd=fd, pid=pid)
        state["screen"] = Screen(cols, rows)
        state["stream"] = pyte.ByteStream(state["screen"])
        threading.Thread(target=pump, daemon=True).start()
        reply({"pid": pid})
    elif op == "write":
        os.write(state["fd"], base64.b64decode(req["b64"]))
        reply({"ok": True})
    elif op == "resize":
        with lock:
            state["screen"].resize(req["rows"], req["cols"])
        set_size(state["fd"], req["rows"], req["cols"])
        reply({"ok": True})
    elif op == "screen":
        with lock:
            reply({"screen": list(state["screen"].display), "raw": base64.b64encode(bytes(state["raw"])).decode()})
    elif op == "close":
        fd = state["fd"]
        state["fd"] = None
        try: os.close(fd)
        except OSError: pass
        reply({"ok": True})
    elif op == "wait":
        end = time.time() + req.get("secs", 5)
        while time.time() < end:
            p, status = os.waitpid(state["pid"], os.WNOHANG)
            if p:
                state["exit"] = os.waitstatus_to_exitcode(status)
                break
            time.sleep(0.05)
        reply({"exit": state["exit"]})
    else:
        reply({"error": "unknown op"})
