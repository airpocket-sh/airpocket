#!/usr/bin/env python3
"""Try the hook end to end with a real, throwaway Claude Code session.

A throwaway Airpocket (try-hook-driver.js) runs in a temp folder. Claude runs
in a hidden terminal (pty + pyte) with only this hook: --setting-sources
project skips the user's own settings and hooks, --settings adds ours, so
nothing else on the Mac hears of this session and no settings file is edited.
It runs in the repo folder (already trusted), with a small model, and:

  starts -> appears; a prompt -> finished (waits); idle -> waiting for you;
  a command needing permission -> needs permission; Esc; a prompt -> clears,
  finished; /exit -> gone.

Needs pyte (pip install pyte) and a logged-in `claude`. It types only into
the session it started.

  python3 docs/reference/try-hook.py [path to claude]
"""
import json, os, pty, re, select, shutil, signal, subprocess, sys, tempfile, threading, time

import pyte

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLAUDE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.local/bin/claude")
NODE = shutil.which("node")
ESC, CR = chr(27), chr(13)

data = tempfile.mkdtemp(prefix="airpocket-try-")
probe = os.path.join(data, "probe")
states, t0 = [], time.time()

driver = subprocess.Popen([NODE, os.path.join(REPO, "docs", "reference", "try-hook-driver.js"), data], stdout=subprocess.PIPE, text=True)
def read_driver():
    for line in driver.stdout:
        try: states.append(json.loads(line))
        except ValueError: pass
threading.Thread(target=read_driver, daemon=True).start()
for _ in range(100):
    if os.path.exists(os.path.join(data, "hook.json")): break
    time.sleep(0.1)

hook = f"AIRPOCKET_DIR='{data}' '{NODE}' '{os.path.join(REPO, 'src', 'hook.js')}' claude"
events = ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd"]
settings = {"remoteControlAtStartup": False,
            "hooks": {e: [{"hooks": [{"type": "command", "command": hook, "timeout": 5}]}] for e in events}}
env = {k: v for k, v in os.environ.items()
       if not (k.startswith(("SUPERSET_", "CLAUDE", "CODEX_", "TMUX")) or k in ("CLAUDECODE",))}
env.update(TERM="xterm-256color", COLUMNS="120", LINES="40")
args = [CLAUDE, "--setting-sources", "project", "--settings", json.dumps(settings), "--model", "haiku"]

class Screen(pyte.Screen):
    # Claude asks the terminal who it is and where the cursor is; unanswered,
    # the first keys typed are taken for the answer.
    def write_process_input(self, data): os.write(fd, data.encode())

screen = Screen(120, 40)
stream = pyte.ByteStream(screen)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(REPO)
    os.execve(CLAUDE, args, env)

def pump(secs):
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: stream.feed(os.read(fd, 65536))
            except OSError: return
def text(): return "\n".join(screen.display)
def wait_screen(pattern, secs):
    end = time.time() + secs
    while time.time() < end:
        pump(0.3)
        if re.search(pattern, text()): return True
    return False
def now():
    s = states[-1]["sessions"] if states else []
    return s[0] if s else None
def wait_state(pred, secs, what):
    end = time.time() + secs
    while time.time() < end:
        pump(0.3)
        s = now()
        if pred(s):
            print(f"[{time.time() - t0:5.1f}s] {what}: " + (json.dumps(s["phone"]) if s else "no sessions"))
            return s
    print(f"[{time.time() - t0:5.1f}s] TIMED OUT waiting for: {what}; last: {json.dumps(s)}")
    return None
def say(msg):
    wait_screen(r"(?m)^❯ *$|^❯ Try ", 30)                  # an empty prompt box
    for ch in msg: os.write(fd, ch.encode()); pump(0.02)   # key by key, so it isn't taken for a paste
    pump(0.5); os.write(fd, CR.encode())

ok = {}
try:
    if not wait_screen(r"(?im)do you trust|^❯", 30): raise SystemExit("Claude didn't start")
    if re.search(r"(?i)do you trust", text()):
        os.write(fd, ESC.encode()); raise SystemExit("the folder isn't trusted; not answering the prompt")
    s = wait_state(lambda s: s and not s["phone"]["waiting"], 20, "started, on the list")
    ok["appears"] = bool(s)
    if s:
        print("   record:", json.dumps(s["record"]), " claude pid:", pid)
        ok["pid is the agent"] = s["record"]["pid"] == pid and s["record"]["started"] > 0

    say("Reply with just the word pong.")
    s = wait_state(lambda s: s and s["phone"]["reason"] == "finished", 90, "finished, waiting")
    ok["waits when finished"] = bool(s)
    ok["chat from the reported transcript"] = bool(s) and s["chat"]["kind"] == "chat" and "pong" in s["chat"]["lastReply"].lower()
    if s: print("   chat:", json.dumps(s["chat"]))

    s = wait_state(lambda s: s and s["phone"]["reason"] == "waiting for you", 100, "idle, waiting for you")
    ok["idle notification"] = bool(s)

    say(f"Use the Bash tool to run exactly: touch {probe}")
    s = wait_state(lambda s: s and s["phone"]["reason"] == "needs permission", 90, "needs permission")
    ok["asks permission"] = bool(s)
    if s: print("   note/message:", json.dumps(s["phone"]["note"]))
    wait_screen(r"(?i)do you want|proceed", 10)
    os.write(fd, ESC.encode()); pump(2)                    # deny: Esc, never Enter
    ok["nothing was run"] = not os.path.exists(probe)

    say("Reply with just the word ok.")
    s = wait_state(lambda s: s and not s["phone"]["waiting"], 30, "a prompt clears it")
    ok["a prompt clears it"] = bool(s)
    s = wait_state(lambda s: s and s["phone"]["reason"] == "finished", 90, "finished again")

    say("/exit")
    s = wait_state(lambda s: s is None, 30, "ended, gone")
    ok["gone at the end"] = s is None and bool(states)
finally:
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    driver.terminate(); driver.wait(5)
    shutil.rmtree(data, ignore_errors=True)

print()
for k, v in ok.items(): print(("PASS " if v else "FAIL ") + k)
sys.exit(0 if ok and all(ok.values()) else 1)
