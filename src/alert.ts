import nodemailer from "nodemailer";
import { config } from "./config.js";

/** Email alert for when Zalo itself can't be used (session lost, login needed). */
export async function alertByEmail(subject: string, body: string): Promise<void> {
  console.error(`[alert] ${subject}: ${body}`);
  if (!config.smtpUrl || !config.alertEmail) return;
  try {
    await nodemailer.createTransport(config.smtpUrl).sendMail({
      to: config.alertEmail,
      from: config.alertEmail,
      subject: `[zalo-digest:${config.userName}] ${subject}`,
      text: body,
    });
  } catch (err) {
    console.error("[alert] failed to send email:", err);
  }
}
