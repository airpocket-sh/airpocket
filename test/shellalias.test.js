"use strict";
// The shell aliases setup offers: which file, the merge, the user's own
// definitions left alone, and add-then-remove giving back the original bytes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const sa = require("../src/shellalias");

const want = (runner = "airpocket") => ["claude", "codex"].map((agent) => ({ agent, line: sa.aliasLine(agent, runner) }));

test("which profile: zsh (and ZDOTDIR), bash, nothing for other shells", () => {
  assert.deepEqual(sa.profileFor({ SHELL: "/bin/zsh" }, "/Users/me"), { shell: "zsh", file: "/Users/me/.zshrc" });
  assert.deepEqual(sa.profileFor({ SHELL: "/bin/zsh", ZDOTDIR: "/Users/me/.config/zsh" }, "/Users/me"), { shell: "zsh", file: "/Users/me/.config/zsh/.zshrc" });
  assert.deepEqual(sa.profileFor({ SHELL: "/bin/zsh", ZDOTDIR: "relative" }, "/Users/me"), { shell: "zsh", file: "/Users/me/.zshrc" });
  assert.deepEqual(sa.profileFor({ SHELL: "/opt/homebrew/bin/bash" }, "/Users/me"), { shell: "bash", file: "/Users/me/.bash_profile" });
  assert.deepEqual(sa.profileFor({ SHELL: "/opt/homebrew/bin/fish" }, "/Users/me"), { shell: "fish", file: "" });
  assert.deepEqual(sa.profileFor({}, "/Users/me"), { shell: "unknown", file: "" });
});

test("the lines, and what zsh and bash make of them", () => {
  assert.equal(sa.aliasLine("claude", "airpocket"), "alias claude='airpocket run claude' # airpocket-alias");
  const tricky = `"/Users/o'neil/node" "/Users/o'neil/Library/Application Support/Airpocket/app/src/cli.js"`;
  const line = sa.aliasLine("codex", tricky);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-alias-"));
  const file = path.join(dir, "rc");
  fs.writeFileSync(file, line + "\n");
  const zsh = spawnSync("/bin/zsh", ["-f", "-c", `source ${JSON.stringify(file)}; alias codex`], { encoding: "utf8" });
  const bash = spawnSync("/bin/bash", ["-c", `shopt -s expand_aliases; source ${JSON.stringify(file)}; alias codex`], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(zsh.stdout, /Application Support\/Airpocket\/app\/src\/cli\.js" run codex/);
  assert.equal(bash.status, 0);
  assert.match(bash.stdout, /o'\\''neil/, "a quote in the path survives");
});

test("add then remove gives back the original, byte for byte", () => {
  const shapes = [
    "",
    "\n",
    "export X=1",
    "export X=1\n",
    "# comment only\n\n\n",
    "export A=1\r\nexport B=2\r\n",
    "alias ll='ls -l'\nsource ~/.aliases\n",
    "ünïcödé='ok'\n# no newline at the end",
  ];
  for (const text of shapes) {
    const added = sa.addAliases(text, want());
    assert.deepEqual(added.added, ["claude", "codex"], JSON.stringify(text));
    assert.ok(added.text.startsWith(text.endsWith("\n") || !text ? text : text + "\n"), "the original stays at the start");
    assert.ok(added.text.endsWith("alias codex='airpocket run codex' # airpocket-alias\n"));
    assert.equal(added.newlineAdded, !!text && !text.endsWith("\n"));
    assert.deepEqual(sa.addAliases(added.text, want()), { text: added.text, added: [], updated: [], same: ["claude", "codex"], skipped: [], newlineAdded: false }, "twice adds nothing");
    const removed = sa.removeAliases(added.text, { newlineAdded: added.newlineAdded });
    assert.equal(removed.text, text, JSON.stringify(text));
    assert.deepEqual(removed.removed, ["claude", "codex"]);
  }
});

test("a moved Airpocket updates its lines in place; lines the user added after ours stay, and so does the newline", () => {
  const first = sa.addAliases("export X=1", want("airpocket"));
  const moved = sa.addAliases(first.text + "export Y=2\n", want(`"/opt/node" "/x/cli.js"`));
  assert.deepEqual([moved.added, moved.updated], [[], ["claude", "codex"]]);
  assert.equal(moved.text, `export X=1\nalias claude='"/opt/node" "/x/cli.js" run claude' # airpocket-alias\nalias codex='"/opt/node" "/x/cli.js" run codex' # airpocket-alias\nexport Y=2\n`);
  // The user wrote after our lines, so the newline setup added ends their line now and stays.
  assert.equal(sa.removeAliases(moved.text, { newlineAdded: first.newlineAdded }).text, "export X=1\nexport Y=2\n");
});

test("an alias or function the user already has is left alone, and noted", () => {
  const own = [
    ["alias claude='claude --dangerously-skip-permissions'\n", "claude"],
    ["alias -g codex='codex --yolo'\n", "codex"],
    ["alias ll=ls claude=foo\n", "claude"],
    ["claude() { command claude \"$@\"; }\n", "claude"],
    ["  function codex {\n    command codex\n  }\n", "codex"],
    ["function claude() {}\n", "claude"],
  ];
  for (const [text, agent] of own) {
    const r = sa.addAliases(text, want());
    assert.deepEqual(r.skipped.map((s) => s.agent), [agent], text);
    assert.deepEqual(r.added, ["claude", "codex"].filter((a) => a !== agent));
  }
  const not = ["# alias claude='x'\n", "alias claudette='x'\n", "export CLAUDE=1\n", "myclaude() { }\n", "echo claude\n"];
  for (const text of not) assert.deepEqual(sa.addAliases(text, want()).skipped, [], text);
});

test("only exact lines of ours are removed", () => {
  const text = "alias claude='airpocket run claude'\n# alias codex='airpocket run codex' # airpocket-alias\nalias codex='airpocket run codex' # airpocket-alias\n";
  const r = sa.removeAliases(text);
  assert.deepEqual(r.removed, ["codex"]);
  assert.equal(r.text, "alias claude='airpocket run claude'\n# alias codex='airpocket run codex' # airpocket-alias\n");
  assert.deepEqual(sa.oursIn(text), ["codex"]);
});
