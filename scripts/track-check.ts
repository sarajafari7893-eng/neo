const { Database } = require("bun:sqlite");
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
const id = (db.prepare("SELECT id FROM Signal WHERE serial=188").all() as any[])[0]?.id;
console.log("signal 188 id:", id);
for (const r of db.prepare("SELECT type, substr(message,1,100) m, substr(createdAt/1000,'unixepoch') c FROM SignalEvent WHERE signalId=? ORDER BY createdAt DESC LIMIT 8").all(id) as any[]) console.log(JSON.stringify(r));
db.close();
