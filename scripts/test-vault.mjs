import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const [, , target, assets = repo, ...extra] = process.argv;
if (!target || extra.length) {
  throw new Error('Usage: npm run test-vault -- "new vault path" ["plugin files directory"]');
}

const files = ["main.js", "manifest.json", "styles.css"];
const contents = await Promise.all(files.map((file) => readFile(resolve(assets, file))));
if (JSON.parse(contents[1].toString()).id !== "study-cards") {
  throw new Error("The supplied manifest must have the study-cards plugin ID.");
}

const vault = resolve(target);
await mkdir(vault);
await cp(join(repo, "fixtures", "test-vault"), vault, { recursive: true });
const plugin = join(vault, ".obsidian", "plugins", "study-cards");
await mkdir(plugin, { recursive: true });
await Promise.all(files.map((file, index) => writeFile(join(plugin, file), contents[index])));
console.log(vault);
