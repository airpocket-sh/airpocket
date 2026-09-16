"use strict";
// A sent message on the phone: the path of a photo the Mac typed never comes back
// in the conversation, and the app's bubble for a message on its way says what
// the conversation will say once it arrives.
const os0 = require("os"), fs0 = require("fs"), path0 = require("path");
process.env.AIRPOCKET_DIR = fs0.mkdtempSync(path0.join(os0.tmpdir(), "airpocket-nodata-"));
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { claudeItems, codexStep, sentPhotos, cleanText } = require("../src/server");

const UPLOADS = "/Users/you/Library/Application Support/Airpocket/uploads";
const shot = (name) => `"${path.join(UPLOADS, name)}"`;
const A = "20260916-171555-14dafd.png", B = "20260916-171601-0a9b3c.jpg";

const claudeUser = (text, uuid = "u1") => JSON.stringify({ type: "user", uuid, timestamp: "2026-09-16T17:16:00Z", message: { role: "user", content: text } });
const claudeText = (text) => claudeItems([claudeUser(text)], {}, { uploads: UPLOADS })[0].text;
const codexText = (text) => codexStep({ id: "c1", type: "UserMessage", content: [{ type: "text", text }] }, "f", { uploads: UPLOADS }).text;

test("a photo this Mac sent reads as a count, in both conversations, and its path never shows", () => {
  for (const [name, read] of [["claude", claudeText], ["codex", codexText]]) {
    assert.equal(read(`what is wrong here? ${shot(A)}`), "what is wrong here?\n[1 photo]", name);
    assert.equal(read(`compare these ${shot(A)} ${shot(B)}`), "compare these\n[2 photos]", name);
    // A message of photos alone is typed with a line of its own, so it still reads as something.
    assert.equal(read(`Look at this photo: ${shot(A)}`), "Look at this photo:\n[1 photo]", name);
    assert.equal(read(shot(A)), "[1 photo]", name);
    for (const t of [read(`see ${shot(A)}`), read(shot(B))]) assert.equal(t.includes(UPLOADS), false, name);
  }
});

test("only Airpocket's own uploads folder is taken out, and nothing else in the message", () => {
  const elsewhere = `look at "/Users/you/Desktop/20260916-171555-14dafd.png" please`;
  assert.equal(claudeText(elsewhere), elsewhere, "a path outside the uploads folder is the user's own words");
  assert.equal(codexText(elsewhere), elsewhere);
  const sibling = `"${UPLOADS}-old/${A}"`;
  assert.equal(sentPhotos(sibling, UPLOADS), sibling, "a folder that only starts the same");
  const deeper = `"${UPLOADS}/x/${A}"`;
  assert.equal(sentPhotos(deeper, UPLOADS), deeper, "a folder inside it");
  const other = `"${UPLOADS}/notes.txt"`;
  assert.equal(sentPhotos(other, UPLOADS), other, "a name uploads.js never gives");
  const bare = `${UPLOADS}/${A}`;
  assert.equal(sentPhotos(bare, UPLOADS), bare, "unquoted: not how the Mac types it");
  const mixed = `keep "/tmp/a.png" and ${shot(A)}  and the  spacing`;
  assert.equal(sentPhotos(mixed, UPLOADS), `keep "/tmp/a.png" and  and the  spacing\n[1 photo]`);
  assert.equal(sentPhotos("no photos here", UPLOADS), "no photos here");
  assert.equal(sentPhotos(`see ${shot(A)}`, ""), `see ${shot(A)}`, "without an uploads folder nothing changes");
  assert.equal(claudeItems([claudeUser(`see ${shot(A)}`)])[0].text, `see ${shot(A)}`, "the builders default to leaving text alone");
});

test("the list's note, a prompt the hook cut short, loses a path it ends part way through", () => {
  const full = `what is wrong here? ${shot(A)}`;
  const cutAt = (n) => full.slice(0, n) + "…";
  assert.equal(sentPhotos(cutAt(full.length - 6), UPLOADS, { clipped: true }), "what is wrong here?\n[1 photo]", "cut in the name");
  assert.equal(sentPhotos(cutAt(40), UPLOADS, { clipped: true }), "what is wrong here?\n[1 photo]", "cut in the folder");
  assert.equal(sentPhotos(cutAt(40), UPLOADS), cutAt(40), "only when the caller says it was clipped");
  const own = `copy it to "/Users/you/Documents/rep…`;
  assert.equal(sentPhotos(own, UPLOADS, { clipped: true }), own, "a path of the user's own stays");
  const short = `open "/Us…`;
  assert.equal(sentPhotos(short, UPLOADS, { clipped: true }), short, "too little to say whose it is");
  assert.equal(sentPhotos(`${full} and then…`, UPLOADS, { clipped: true }), "what is wrong here? and then…\n[1 photo]");
});

test("a photo Claude also took in as an image, and a message queued while it worked", () => {
  const withImage = JSON.stringify({ type: "user", uuid: "u2", message: { content: [{ type: "text", text: `this ${shot(A)}` }, { type: "image", source: {} }] } });
  assert.equal(claudeItems([withImage], {}, { uploads: UPLOADS })[0].text, "this\n[1 photo]\n[1 image]");
  const queued = JSON.stringify({ type: "attachment", uuid: "q1", attachment: { type: "queued_command", prompt: `later ${shot(B)}` } });
  const it = claudeItems([queued], {}, { uploads: UPLOADS })[0];
  assert.equal(it.text, "later\n[1 photo]");
  assert.equal(it.queued, true);
  const codexImage = codexStep({ id: "c2", type: "UserMessage", content: [{ type: "text", text: shot(A) }, { type: "image" }] }, "f", { uploads: UPLOADS });
  assert.equal(codexImage.text, "[1 photo]\n[1 image]");
});

// ---- the phone app: the pieces that decide what a message on its way says, taken out of app.js as written.
const APP = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.js"), "utf8");
function fromApp(...names) {
  const src = names.map((name) => {
    const m = new RegExp(`\\n( *)function ${name}\\([\\s\\S]*?\\n\\1\\}\\n`).exec(APP);
    assert.ok(m, `app.js has ${name}`);
    return m[0];
  }).join("\n");
  return new Function(`${src}; return { ${names.join(", ")} };`)();
}
const { echoText, sameMessage, stillPending } = fromApp("echoText", "sameMessage", "stillPending");

test("the bubble says what the Mac will show: its spacing, its line for photos alone, the count", () => {
  assert.equal(echoText("  hello  "), "hello");
  const NL = String.fromCharCode(10), TAB = String.fromCharCode(9), ESC = String.fromCharCode(27);
  const typed = `first${NL}second${TAB}tab${ESC}[31m`;
  assert.equal(echoText(typed), cleanText(typed).trim(), "the same cleaning the Mac does before typing");
  assert.equal(echoText("look", 1), "look\n[1 photo]");
  assert.equal(echoText("", 1), "Look at this photo:\n[1 photo]");
  assert.equal(echoText("", 3), "Look at these photos:\n[3 photos]");
  // What the server builds from what it typed is the bubble, word for word, so the swap doesn't move a line.
  assert.equal(sentPhotos(`Look at these photos: ${shot(A)} ${shot(B)}`, UPLOADS), echoText("", 2));
  assert.equal(sentPhotos(`look ${shot(A)}`, UPLOADS), echoText("look", 1));
});

test("a message on its way is matched by its text, once, and only by something new", () => {
  assert.ok(sameMessage("a  b\nc", "a b c"));
  assert.ok(sameMessage("look\n[1 photo]\n[1 image]", "look\n[1 photo]"), "an agent that took the photo in as an image");
  assert.ok(sameMessage("look [Image #1]\n[1 image]", "look\n[1 photo]"));
  assert.ok(!sameMessage("look again", "look"));

  const now = 1_000_000;
  const p = (text, before = [], at = now) => ({ key: "pending:" + text, text, at, before: new Set(before) });
  const hi = { type: "user", id: "u1", text: "hi" };
  const one = p("hi", ["u1"]);
  assert.deepEqual(stillPending([one], [hi], now, 30000), [one], "the same words said before the send are not this message");
  assert.deepEqual(stillPending([one], [hi, { type: "agent", id: "a1", text: "hi" }], now, 30000), [one], "an agent's words never count");
  assert.deepEqual(stillPending([one], [hi, { type: "user", id: "u2", text: "hi" }], now, 30000), [], "a new one does");
  const two = [p("hi", ["u1"]), p("hi", ["u1"])];
  assert.equal(stillPending(two, [hi, { type: "user", id: "u2", text: "hi" }], now, 30000).length, 1, "one arrival settles one send");
  assert.deepEqual(stillPending([p("hi", [], now - 30001)], [], now, 30000), [], "after half a minute it goes whatever the chat says");
  assert.equal(stillPending([p("hi", [], now - 29000)], [], now, 30000).length, 1);
});
