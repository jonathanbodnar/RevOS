/** The CRM picker and the "How to find …" guides behind each card. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CRM_PROVIDERS } from "./types";
import { CRM_LOGOS, guideFor, pickerHint } from "./guides";

test("every CRM has a logo file, a picker hint and a step-by-step guide", () => {
  for (const p of CRM_PROVIDERS) {
    const logo = CRM_LOGOS[p];
    assert.ok(fs.existsSync(path.join(process.cwd(), "public", logo.src)), `${p} logo missing`);
    for (const available of [true, false]) {
      assert.ok(pickerHint(p, available).length > 0);
      const g = guideFor(p, available);
      assert.match(g.button, /^How to /);
      assert.ok(g.steps.length >= 3, `${p} needs real steps`);
      assert.ok(g.steps.every((s) => s.text.trim().length > 0));
      if (g.source) assert.match(g.source.url, /^https:\/\//);
    }
  }
});

test("Mindbody shows how to export clients until it can be connected", () => {
  assert.equal(guideFor("mindbody", false).button, "How to export your clients");
  assert.equal(guideFor("mindbody", true).button, "How to find your Site ID");
  assert.match(pickerHint("mindbody", false), /Coming soon/);
});

test("the Zenoti guide ends where the card takes over", () => {
  const g = guideFor("zenoti", true);
  assert.equal(g.button, "How to find your API key");
  assert.match(g.steps.at(-1)!.text, /Connect Zenoti/);
  assert.deepEqual(g.steps[1].path, ["Configuration", "Integrations", "Apps"]);
});
