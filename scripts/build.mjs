import { build } from "esbuild";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { metafile, outputFiles: [output] } = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  platform: "browser",
  format: "cjs",
  target: "es2020",
  outfile: "main.js",
  metafile: true,
  write: false,
});

const bundle = metafile.outputs["main.js"];
const packages = new Set();
for (const [input, { bytesInOutput }] of Object.entries(bundle.inputs)) {
  const match = input.match(/^((?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match && bytesInOutput > 0) packages.add(match[1]);
}

const notices = [await readFile("LICENSE", "utf8")];
for (const path of [...packages].sort()) {
  const { name, version } = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  const files = (await readdir(path)).sort();
  const isLicense = (file) => /^licen[cs]e(?:[.-]|$)/i.test(file);
  if (!files.some(isLicense)) throw new Error(`No license file in ${name}@${version}`);

  notices.push(`${name}@${version}`);
  for (const file of files) {
    if (isLicense(file) || /^notice(?:[.-]|$)/i.test(file)) {
      notices.push(await readFile(join(path, file), "utf8"));
    }
  }
}

const header = notices.map((notice) => notice.trimEnd()).join("\n\n")
  .split(/\r?\n/).map((line) => line ? `// ${line}` : "//").join("\n");
await writeFile(output.path, `// Study Cards and bundled dependency licenses\n${header}\n\n${output.text}`);
console.log("Built main.js with bundled dependency licenses.");
