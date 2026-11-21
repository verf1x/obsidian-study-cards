import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("разворачивает тестовый vault с исходным конспектом и выбранной сборкой", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-cards-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = join(root, "downloaded assets");
  const vault = join(root, "test vault");
  const files = {
    "main.js": "module.exports = {};\n",
    "manifest.json": '{"id":"study-cards","version":"1.2.3"}\n',
    "styles.css": "/* downloaded styles */\n",
  };
  await mkdir(artifacts);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(artifacts, name), contents);
  }

  const result = spawnSync(process.execPath, ["scripts/test-vault.mjs", vault, artifacts], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const plugin = join(vault, ".obsidian", "plugins", "study-cards");
  assert.deepEqual((await readdir(plugin)).sort(), Object.keys(files).sort());
  for (const [name, contents] of Object.entries(files)) {
    assert.equal(await readFile(join(plugin, name), "utf8"), contents);
  }
  const collection = await readFile(join(vault, "Материалы", "HTTP — 100 вопросов.md"), "utf8");
  assert.equal(collection.match(/^## /gm)?.length, 100);
  assert.doesNotMatch(collection, /<!--\s*qcards:id/);

  const progress = join(vault, "Study Cards", "data.json");
  await mkdir(join(vault, "Study Cards"));
  await writeFile(progress, "existing progress");
  await writeFile(join(artifacts, "main.js"), "new build");
  const retry = spawnSync(process.execPath, ["scripts/test-vault.mjs", vault, artifacts]);
  assert.notEqual(retry.status, 0);
  assert.equal(await readFile(progress, "utf8"), "existing progress");
  assert.equal(await readFile(join(plugin, "main.js"), "utf8"), files["main.js"]);
});
