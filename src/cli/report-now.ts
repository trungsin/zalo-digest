// Build the report right now. Prints it by default; `--send` also sends it to "Cloud của tôi"
// and advances the report window (the next scheduled report starts from here).
import { buildReport } from "../report.js";
import { login, sendToSelf } from "../zalo.js";

const send = process.argv.includes("--send");
const report = await buildReport();
console.log(report.text);

if (send) {
  await sendToSelf(await login(), report.text);
  report.markReported();
  console.log("\n[report] sent to Cloud của tôi");
}
process.exit(0);
