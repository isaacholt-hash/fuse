import assert from "node:assert/strict";
import { test } from "node:test";
import { report } from "../src/report.js";

test("the report gives the height in metres, to one decimal", () => {
  assert.equal(report(0), "Tide: 2.0 m");
  assert.equal(report(3), "Tide: 3.0 m");
});
