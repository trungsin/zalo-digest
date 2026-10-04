import fs from "node:fs";
import { Zalo, LoginQRCallbackEventType, ThreadType, type API, type Credentials } from "zca-js";
import { config } from "./config.js";
import { assertLocalAccount, bindLocalAccount } from "./account-binding.js";

// Zalo text messages have a length limit; keep chunks comfortably below it.
const MAX_CHUNK = 2500;

/**
 * Log in with saved credentials, or fall back to a QR code written to data/qr.png.
 * Credentials from a QR login are saved so later restarts don't need a rescan.
 */
export async function login(verifyAccount?: (api: API) => Promise<void>): Promise<API> {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const zalo = new Zalo({ selfListen: true, logging: false });

  if (fs.existsSync(config.credentialsPath)) {
    let credentials: Credentials | undefined;
    try {
      credentials = JSON.parse(fs.readFileSync(config.credentialsPath, "utf8")) as Credentials;
    } catch (err) {
      console.error("[zalo] Saved credentials unreadable, falling back to QR login:", err);
    }
    let api: API | undefined;
    if (credentials) {
      try {
        api = await zalo.login(credentials);
      } catch (err) {
        console.error("[zalo] Saved credentials rejected, falling back to QR login:", err);
      }
    }
    if (api) {
      assertLocalAccount(config.dataDir, api.getOwnId(), config.expectedZaloUid);
      await verifyAccount?.(api);
      bindLocalAccount(config.dataDir, api.getOwnId(), config.expectedZaloUid);
      return api;
    }
  }

  let newCredentials: Credentials | undefined;
  const api = await zalo.loginQR({ qrPath: config.qrPath }, async (event) => {
    switch (event.type) {
      case LoginQRCallbackEventType.QRCodeGenerated:
        await event.actions.saveToFile(config.qrPath);
        console.log(`[zalo] Scan the QR code at ${config.qrPath} with the Zalo app`);
        break;
      case LoginQRCallbackEventType.QRCodeExpired:
        console.log("[zalo] QR expired, generating a new one");
        event.actions.retry();
        break;
      case LoginQRCallbackEventType.QRCodeScanned:
        console.log(`[zalo] Scanned by ${event.data.display_name}, confirm on your phone`);
        break;
      case LoginQRCallbackEventType.QRCodeDeclined:
        console.error("[zalo] Login declined on phone");
        break;
      case LoginQRCallbackEventType.GotLoginInfo: {
        newCredentials = {
          imei: event.data.imei,
          cookie: event.data.cookie,
          userAgent: event.data.userAgent,
        };
        fs.rmSync(config.qrPath, { force: true });
        break;
      }
    }
  });
  assertLocalAccount(config.dataDir, api.getOwnId(), config.expectedZaloUid);
  await verifyAccount?.(api);
  bindLocalAccount(config.dataDir, api.getOwnId(), config.expectedZaloUid);
  if (newCredentials) {
    fs.writeFileSync(config.credentialsPath, JSON.stringify(newCredentials), { mode: 0o600 });
    console.log(`[zalo] Logged in, credentials saved to ${config.credentialsPath}`);
  }
  return api;
}

/** Zalo assigns Cloud a separate recipient ID in the authenticated login response. */
export function selfThreadId(api: Pick<API, "getContext">): string {
  const id = api.getContext().loginInfo?.send2me_id;
  if (typeof id !== "string" || !/^[1-9]\d*$/.test(id)) {
    throw new Error("Phiên Zalo chưa có ID Cloud của tôi. Vui lòng kết nối lại Zalo.");
  }
  return id;
}

/** Send text to "Cloud của tôi", split into chunks. Never use the account UID as recipient. */
export async function sendToSelf(api: API, text: string): Promise<void> {
  const threadId = selfThreadId(api);
  for (const chunk of splitText(text, MAX_CHUNK)) {
    const result = await api.sendMessage(chunk, threadId, ThreadType.User);
    if (!result.message?.msgId) throw new Error("Zalo chưa xác nhận ID tin nhắn đã gửi.");
  }
}

function splitText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + line.length + 1 > max) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
    while (current.length > max) {
      chunks.push(current.slice(0, max));
      current = current.slice(max);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
