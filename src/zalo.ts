import fs from "node:fs";
import { Zalo, LoginQRCallbackEventType, ThreadType, type API, type Credentials } from "zca-js";
import { config } from "./config.js";

// Zalo text messages have a length limit; keep chunks comfortably below it.
const MAX_CHUNK = 2500;

/**
 * Log in with saved credentials, or fall back to a QR code written to data/qr.png.
 * Credentials from a QR login are saved so later restarts don't need a rescan.
 */
export async function login(): Promise<API> {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const zalo = new Zalo({ selfListen: true, logging: false });

  if (fs.existsSync(config.credentialsPath)) {
    const credentials = JSON.parse(fs.readFileSync(config.credentialsPath, "utf8")) as Credentials;
    try {
      return await zalo.login(credentials);
    } catch (err) {
      console.error("[zalo] Saved credentials rejected, falling back to QR login:", err);
    }
  }

  return zalo.loginQR({ qrPath: config.qrPath }, async (event) => {
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
        const credentials: Credentials = {
          imei: event.data.imei,
          cookie: event.data.cookie,
          userAgent: event.data.userAgent,
        };
        fs.writeFileSync(config.credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
        fs.rmSync(config.qrPath, { force: true });
        console.log(`[zalo] Logged in, credentials saved to ${config.credentialsPath}`);
        break;
      }
    }
  });
}

/** Send text to "Cloud của tôi" (the account's own thread), split into chunks. */
export async function sendToSelf(api: API, text: string): Promise<void> {
  for (const chunk of splitText(text, MAX_CHUNK)) {
    await api.sendMessage(chunk, api.getOwnId(), ThreadType.User);
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
