import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindLocalAccount } from "../src/account-binding.js";

test("each directory remains bound to its original Zalo account", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-bind-test-"));
  try {
    const a = path.join(root, "a"); const b = path.join(root, "b");
    fs.mkdirSync(a); fs.mkdirSync(b);
    bindLocalAccount(a, "1111"); bindLocalAccount(b, "2222");
    bindLocalAccount(a, "1111", "1111");
    assert.throws(() => bindLocalAccount(a, "2222"), /Zalo khác/);
    assert.throws(() => bindLocalAccount(b, "3333", "2222"), /ban đầu/);
    assert.throws(() => bindLocalAccount(a, ""), /UID/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(a, "account.json"), "utf8")).zalo_uid, "1111");
    assert.equal(JSON.parse(fs.readFileSync(path.join(b, "account.json"), "utf8")).zalo_uid, "2222");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
