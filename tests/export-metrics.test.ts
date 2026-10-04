import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("CSV cells are quoted, escaped, and protected from formula injection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-metrics-test-"));
  const originalUserDir = process.env.USER_DIR;
  process.env.USER_DIR = dir;
  try {
    const moduleUrl = new URL("../src/cli/export-metrics.ts", import.meta.url);
    moduleUrl.search = `test=${Date.now()}`;
    const { escapeCsvCell } = await import(moduleUrl.href);

    assert.equal(escapeCsvCell("=SUM(A1:A2)"), '"\'=SUM(A1:A2)"');
    assert.equal(escapeCsvCell("+SUM(A1:A2)"), '"\'+SUM(A1:A2)"');
    assert.equal(escapeCsvCell("-SUM(A1:A2)"), '"\'-SUM(A1:A2)"');
    assert.equal(escapeCsvCell(-5), '"-5"');
    assert.equal(escapeCsvCell("@SUM(A1:A2)"), '"\'@SUM(A1:A2)"');
    assert.equal(escapeCsvCell("\tSUM(A1:A2)"), '"\'\tSUM(A1:A2)"');
    assert.equal(escapeCsvCell("\rSUM(A1:A2)"), '"\'\rSUM(A1:A2)"');
    assert.equal(escapeCsvCell('safe "quote"'), '"safe ""quote"""');
    assert.equal(escapeCsvCell(null), '""');
  } finally {
    if (originalUserDir === undefined) delete process.env.USER_DIR;
    else process.env.USER_DIR = originalUserDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
