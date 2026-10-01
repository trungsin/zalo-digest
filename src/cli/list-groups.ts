// Prints all groups of the account with their IDs, to pick values for TRACKED_GROUP_IDS.
import { login } from "../zalo.js";

const api = await login();
const ids = Object.keys((await api.getAllGroups()).gridVerMap);

const BATCH = 50;
const rows: { id: string; name: string; members: number }[] = [];
for (let i = 0; i < ids.length; i += BATCH) {
  const info = await api.getGroupInfo(ids.slice(i, i + BATCH));
  for (const [id, group] of Object.entries(info.gridInfoMap)) {
    rows.push({ id, name: group.name, members: group.totalMember });
  }
}

rows.sort((a, b) => a.name.localeCompare(b.name, "vi"));
for (const r of rows) console.log(`${r.id}\t${r.members} tv\t${r.name}`);
console.log(`\n${rows.length} nhóm. Chép ID cần theo dõi vào TRACKED_GROUP_IDS trong .env (cách nhau bằng dấu phẩy).`);
process.exit(0);
