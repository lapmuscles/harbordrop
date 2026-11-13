// 將 src/db/migrations/*.sql 內嵌成 TS 模組，讓 Workers 與 Node 執行期都能自動遷移
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/db/migrations");
const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const items = files.map((f) => `  { name: ${JSON.stringify(f)}, sql: ${JSON.stringify(readFileSync(join(dir, f), "utf8"))} },`);
writeFileSync(join(dir, "index.gen.ts"), `// 自動產生：npm run gen:migrations（勿手動修改）\nexport const MIGRATIONS: { name: string; sql: string }[] = [\n${items.join("\n")}\n];\n`);
console.log(`migrations: ${files.length}`);
