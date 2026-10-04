import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadType, type API, type Message } from "zca-js";

test("Cloud sends and commands use login send2me_id, never the account UID", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-cloud-test-"));
  process.env.USER_DIR = dir;
  const { sendToSelf, selfThreadId } = await import("../src/zalo.js");
  const { handleCommand } = await import("../src/tasks.js");
  const { db } = await import("../src/db.js");
  const calls: { text: string; recipient: string; type: ThreadType }[] = [];
  let cloud: unknown = "9876543210987654321";
  let failAt = Infinity;
  let acknowledge = true;
  const api = {
    getOwnId: () => "1234567890123456789",
    getContext: () => ({ loginInfo: { send2me_id: cloud } }),
    sendMessage: async (text: string, recipient: string, type: ThreadType) => {
      calls.push({ text, recipient, type });
      if (calls.length === failAt) throw Object.assign(new Error("Rejected"), { code: 114 });
      return { message: acknowledge ? { msgId: calls.length } : null, attachment: [] };
    },
  } as unknown as API;
  const message = (idTo: string, isSelf = true, type = ThreadType.User): Message => ({
    type, isSelf, threadId: idTo, data: { idTo, content: "viec" },
  } as Message);
  try {
    await sendToSelf(api, "Xin chào Cloud");
    assert.deepEqual(calls, [{ text: "Xin chào Cloud", recipient: cloud, type: ThreadType.User }]);
    calls.length = 0;
    const text = "a".repeat(2500) + "\n" + "b".repeat(2500) + "\nC";
    await sendToSelf(api, text);
    assert.deepEqual(calls.map(c => c.text), ["a".repeat(2500), "b".repeat(2500), "C"]);
    assert.ok(calls.every(c => c.recipient === cloud && c.type === ThreadType.User));
    calls.length = 0;
    failAt = 2;
    await assert.rejects(sendToSelf(api, text), { code: 114 });
    assert.equal(calls.length, 2, "stop at failed chunk without retry or continuing");
    failAt = Infinity;
    calls.length = 0;
    for (const invalid of [undefined, "", "-1", "abc", 123]) {
      cloud = invalid;
      await assert.rejects(sendToSelf(api, "Do not send"), /ID Cloud/);
    }
    assert.equal(calls.length, 0, "missing Cloud ID must never fall back to own UID");
    cloud = "9876543210987654321";
    acknowledge = false;
    await assert.rejects(sendToSelf(api, "Require confirmation"), /xác nhận ID/);
    acknowledge = true;
    calls.length = 0;
    assert.equal(await handleCommand(api, message(api.getOwnId())), false);
    assert.equal(await handleCommand(api, message(selfThreadId(api), false)), false);
    assert.equal(await handleCommand(api, message(selfThreadId(api), true, ThreadType.Group)), false);
    assert.equal(calls.length, 0);
    assert.equal(await handleCommand(api, message(selfThreadId(api))), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.recipient, cloud);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
