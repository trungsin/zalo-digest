import fs from "node:fs";
import path from "node:path";

export class AccountBindingError extends Error {}

export function assertLocalAccount(dataDir: string, uid: string, expectedUid?: string): void {
  if (!/^[1-9]\d*$/.test(uid)) throw new Error("Không xác minh được Zalo UID.");
  if (expectedUid && expectedUid !== uid) throw new AccountBindingError("Vui lòng đăng nhập đúng tài khoản Zalo đã kết nối ban đầu.");
  const file = path.join(dataDir, "account.json");
  if (!fs.existsSync(file)) return;
  const bound = JSON.parse(fs.readFileSync(file, "utf8")) as { zalo_uid?: string };
  if (bound.zalo_uid !== uid) throw new AccountBindingError("Thư mục dữ liệu này thuộc tài khoản Zalo khác. Vui lòng đăng nhập đúng tài khoản ban đầu.");
}

/** One data directory belongs permanently to one Zalo UID, including manual deployments. */
export function bindLocalAccount(dataDir: string, uid: string, expectedUid?: string): void {
  assertLocalAccount(dataDir, uid, expectedUid);
  const file = path.join(dataDir, "account.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ zalo_uid: uid }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    assertLocalAccount(dataDir, uid, expectedUid);
  }
}
