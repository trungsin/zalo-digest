import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Zalo, LoginQRCallbackEventType, type API } from "zca-js";

test("rejected login cannot bind storage or replace the original account credentials", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-login-test-"));
  process.env.USER_DIR = dir;
  const { login } = await import("../src/zalo.js");
  const { config } = await import("../src/config.js");
  const originalLogin = Zalo.prototype.login;
  const originalQR = Zalo.prototype.loginQR;
  const originalConsoleError = console.error;
  let uid = "1111";
  const api = { getOwnId: () => uid } as API;
  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    console.error = () => {};
    fs.writeFileSync(config.credentialsPath, "{not-json");
    let savedLogins = 0;
    let qrLogins = 0;
    Zalo.prototype.login = async () => { savedLogins++; return api; };
    Zalo.prototype.loginQR = async (_options, callback) => {
      qrLogins++;
      await callback?.({ type: LoginQRCallbackEventType.GotLoginInfo, data: { imei: "qr-account", cookie: [], userAgent: "test" }, actions: {} } as Parameters<NonNullable<typeof callback>>[0]);
      return api;
    };
    await login(async authenticated => { assert.equal(authenticated.getOwnId(), "1111"); });
    assert.equal(savedLogins, 0);
    assert.equal(qrLogins, 1);
    assert.equal(JSON.parse(fs.readFileSync(config.credentialsPath, "utf8")).imei, "qr-account");
    fs.rmSync(path.join(config.dataDir, "account.json"), { force: true });

    const originalCredentials = JSON.stringify({ imei: "original", cookie: [], userAgent: "test" });
    fs.writeFileSync(config.credentialsPath, originalCredentials);
    Zalo.prototype.loginQR = originalQR;
    Zalo.prototype.login = async () => api;
    await assert.rejects(login(async () => { throw new Error("Duplicate Zalo binding"); }), /Duplicate/);
    assert.ok(!fs.existsSync(path.join(config.dataDir, "account.json")));
    await login(async authenticated => { assert.equal(authenticated.getOwnId(), "1111"); });
    uid = "2222";
    let verificationCalled = false;
    await assert.rejects(login(async () => { verificationCalled = true; }), /Zalo khác/);
    assert.equal(verificationCalled, false);
    Zalo.prototype.login = async () => { throw new Error("Expired credentials"); };
    Zalo.prototype.loginQR = async (_options, callback) => {
      await callback?.({ type: LoginQRCallbackEventType.GotLoginInfo, data: { imei: "wrong-account", cookie: [], userAgent: "test" }, actions: {} } as Parameters<NonNullable<typeof callback>>[0]);
      return api;
    };
    await assert.rejects(login(), /Zalo khác/);
    assert.equal(fs.readFileSync(config.credentialsPath, "utf8"), originalCredentials);
    assert.equal(JSON.parse(fs.readFileSync(path.join(config.dataDir, "account.json"), "utf8")).zalo_uid, "1111");
  } finally {
    Zalo.prototype.login = originalLogin; Zalo.prototype.loginQR = originalQR; console.error = originalConsoleError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
