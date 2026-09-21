import fs from "node:fs";
for (const line of fs.readFileSync(".env","utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
}
