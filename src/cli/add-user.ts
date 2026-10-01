// Create users/<name>/.env from the template. Usage: npm run add-user -- <name>
import fs from "node:fs";
import path from "node:path";

const name = process.argv[2];
if (!name || !/^[a-z0-9_-]+$/.test(name)) {
  console.error("Usage: npm run add-user -- <name>   (chữ thường, số, - hoặc _)");
  process.exit(1);
}

const dir = path.resolve("users", name);
const envPath = path.join(dir, ".env");
if (fs.existsSync(envPath)) {
  console.error(`${envPath} đã tồn tại`);
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.copyFileSync(".env.example", envPath);
fs.chmodSync(envPath, 0o600);

console.log(`Đã tạo ${envPath}. Tiếp theo:
  1. Điền GEMINI_API_KEY (hoặc ANTHROPIC_API_KEY), USER_PROFILE trong file trên
  2. USER_DIR=users/${name} npm run groups    → ${name} quét QR ở users/${name}/data/qr.png
  3. Điền TRACKED_GROUP_IDS
  4. pm2 start ecosystem.config.cjs --only zalo-${name} && pm2 save`);
