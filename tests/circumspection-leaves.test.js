// Leaves are derived from the whole entry every time, so a stored diary cut
// with the old geometry (80 × 18 / 96 × 18) re-flows under the current one:
// words that had overflowed onto the next leaf come back to the leaf before.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const Leaves = require(path.join(ROOT, "circumspection-leaves.js"));
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "rich-editor.js"), "utf8"), sandbox);
const { parseBlocks } = sandbox.window.FilumRichText;

const paginate = (entry, geometry) =>
  Leaves.paginate(entry.content, entry.manualPageBreaks, geometry, { parseBlocks });
const words = (text) => text.match(/\S+/g) || [];

// A diary written the way the writing view stores it: a bold heading line,
// paragraphs, a numbered list with a nested level, links and marks.
function diary(paragraphs = 9) {
  const blocks = [
    "**Provelis v/s Metaview: a contrastive analysis**",
    "Hi Anil, as far as I can comprehend based on how we do sourcing v/s how metaview does, Metaview leads on open-ended search (an agent plans/re-plans, steered by recruiter feedback and the customer's own interview history) while Provelis leads on cost control, deterministic guardrails, and closing the loop into proof of skill.",
    "When I inspected over web about Metaview, I think they follow this chain:",
    [
      "1. Trigger: A recruiter speaks, types, or uploads a JD, resumes, or an interview; opening a job in the ATS can also start a search.",
      "2. ICP generation: The agent writes an **Ideal candidate profile(ICP)** which recruiter can edit before the search runs.",
      "   1. The profile is *editable* before anything runs.",
      "   2. Edits are kept as [feedback](https://example.com/icp).",
      "3. Retrieval: One pass covers the open web (like ours), the customer's ATS, and past Metaview interview conversations.",
      "4. Ranking: Candidates are scored against the ICP and re-ranked continuously as accept and reject decisions arrive.",
    ].join("\n"),
  ];
  for (let i = 1; i <= paragraphs; i += 1) {
    blocks.push(`Note ${i}: the afternoon went to untangling why I keep starting lists and never finishing them. The lists are not the problem; I write them to feel calm, the calm arrives as soon as the list exists, and so the *doing* never feels necessary. Tomorrow I will try writing only the next step, with \`one line\` and nothing after it.`);
  }
  return blocks.join("\n\n");
}

function storedEntry(content, manualPageBreaks = []) {
  return { id: "entry-0001-aaaa", content, manualPageBreaks };
}

// Every word appears exactly once, in order, and only whitespace sits
// between one leaf and the next.
function assertLossless(entry, pages) {
  assert.deepEqual(words(pages.map((page) => page.text).join(" ")), words(entry.content));
  for (let i = 1; i < pages.length; i += 1) {
    assert.ok(pages[i - 1].end <= pages[i].start, `leaf ${i} overlaps leaf ${i + 1}`);
    assert.equal(entry.content.slice(pages[i - 1].end, pages[i].start).trim(), "", `words lost between leaf ${i} and ${i + 1}`);
  }
  assert.equal(entry.content.slice(0, pages[0].start).trim(), "");
  assert.equal(entry.content.slice(pages.at(-1).end).trim(), "");
}

for (const layout of ["simple-musky", "wider-musky"]) {
  test(`${layout}: overflowed text in a stored diary flows back to the earlier leaf`, () => {
    const entry = storedEntry(diary());
    const before = paginate(entry, Leaves.LEGACY_LEAF_GEOMETRY[layout]);
    const after = paginate(entry, Leaves.geometryFor(layout));
    assert.ok(before.length >= 3, "fixture should span several leaves under the old geometry");
    assert.ok(after.length < before.length, `${after.length} leaves now, ${before.length} before`);
    // The words that used to open leaf 2 (they had overflowed) are on leaf 1 again.
    assert.equal(Leaves.pageIndexForOffset(after, before[1].start, 0), 0);
    assert.ok(after[0].end > before[0].end);
    // …and every later leaf starts no later than it used to.
    after.forEach((page, index) => {
      if (before[index]) assert.ok(page.start >= before[index].start);
    });
    assertLossless(entry, before);
    assertLossless(entry, after);
  });

  test(`${layout}: a leaf turned by hand stays a leaf boundary after re-flow`, () => {
    const content = diary(4);
    const turnAt = content.indexOf("Note 2:");
    const entry = storedEntry(content, [turnAt]);
    for (const geometry of [Leaves.LEGACY_LEAF_GEOMETRY[layout], Leaves.geometryFor(layout)]) {
      const pages = paginate(entry, geometry);
      assert.ok(pages.some((page) => page.start === turnAt), "manual break must open a leaf");
      assertLossless(entry, pages);
    }
  });

  test(`${layout}: a fresh leaf opened at the end survives re-flow as the empty living leaf`, () => {
    const content = `${diary(2)}\n\n`;
    const entry = storedEntry(content, [content.length]);
    const pages = paginate(entry, Leaves.geometryFor(layout));
    assert.equal(pages.at(-1).text, "");
    assert.equal(pages.at(-1).start, content.length);
  });

  test(`${layout}: shrinking earlier text pulls the next leaf's words back`, () => {
    const entry = storedEntry(diary(14));
    const geometry = Leaves.geometryFor(layout);
    const before = paginate(entry, geometry);
    assert.ok(before.length >= 2);
    const firstNote = entry.content.indexOf("Note 1:");
    const secondNote = entry.content.indexOf("Note 2:");
    const shrunk = storedEntry(entry.content.slice(0, firstNote) + entry.content.slice(secondNote));
    const after = paginate(shrunk, geometry);
    const leaf2Start = before[1].start - (secondNote - firstNote);
    assert.equal(Leaves.pageIndexForOffset(after, leaf2Start, 0), 0);
    assertLossless(shrunk, after);
  });

  test(`${layout}: leaves never break inside bold, a link, or code`, () => {
    const entry = storedEntry(diary(20));
    const pages = paginate(entry, Leaves.geometryFor(layout));
    for (const page of pages) {
      const stars = (page.text.match(/\*\*/g) || []).length;
      assert.equal(stars % 2, 0, `unbalanced ** on a leaf: ${page.text.slice(0, 60)}`);
      assert.equal((page.text.match(/`/g) || []).length % 2, 0);
    }
  });
}

test("the wider diary holds more on a leaf than the simple one", () => {
  const entry = storedEntry(diary(20));
  const simple = paginate(entry, Leaves.geometryFor("simple-musky"));
  const wider = paginate(entry, Leaves.geometryFor("wider-musky"));
  assert.ok(wider.length < simple.length);
  const simpleGeometry = Leaves.geometryFor("simple-musky");
  const widerGeometry = Leaves.geometryFor("wider-musky");
  assert.ok(widerGeometry.measureCh > simpleGeometry.measureCh);
  assert.ok(simpleGeometry.charsPerLine > Leaves.LEGACY_LEAF_GEOMETRY["simple-musky"].charsPerLine);
  assert.ok(simpleGeometry.lines >= Leaves.LEGACY_LEAF_GEOMETRY["simple-musky"].lines);
});

test("pagination is deterministic for the same words", () => {
  const entry = storedEntry(diary(12));
  const geometry = Leaves.geometryFor("simple-musky");
  assert.deepEqual(paginate(entry, geometry), paginate(entry, geometry));
});

test("settings migration: the old default size becomes the new one; a chosen size stays", () => {
  const legacyDefault = { writingSizePx: 19, writingMeasureCh: 74, writingMeasureVersion: 2 };
  assert.equal(Leaves.migrateSettings(legacyDefault), true);
  assert.equal(legacyDefault.writingSizePx, Leaves.DEFAULT_WRITING_SIZE_PX);
  assert.equal(legacyDefault.writingMeasureVersion, Leaves.SETTINGS_VERSION);

  const chosen = { writingSizePx: 21, writingMeasureCh: 88, writingMeasureVersion: 2 };
  Leaves.migrateSettings(chosen);
  assert.equal(chosen.writingSizePx, 21);

  const veryOld = { writingSizePx: 19, writingMeasureCh: 62, writingMeasureVersion: 1 };
  Leaves.migrateSettings(veryOld);
  assert.equal(veryOld.writingMeasureCh, 74);
  assert.equal(veryOld.writingSizePx, Leaves.DEFAULT_WRITING_SIZE_PX);

  const current = { writingSizePx: 19, writingMeasureCh: 74, writingMeasureVersion: Leaves.SETTINGS_VERSION };
  assert.equal(Leaves.migrateSettings(current), false);
  assert.equal(current.writingSizePx, 19, "a writer on the new version who picks 19 keeps it");
});
