import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const OUT_DIR = "public/data";

const SOURCES = [
  {
    name: "empire-item-version",
    url: "https://empire-html5.goodgamestudios.com/default/items/ItemsVersion.properties",
    out: "empire/ItemsVersion.properties",
    type: "text"
  },
  {
    name: "language-metadata",
    url: "https://langserv.public.ggs-ep.com/12/fr/@metadata",
    out: "lang/metadata.json",
    type: "json"
  },
  {
    name: "e4k-appstore",
    url: "https://itunes.apple.com/lookup?id=585661281",
    out: "e4k/appstore.json",
    type: "json"
  }
];

async function fetchText(url) {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status}: ${url}`);
  }

  return await res.text();
}

async function writeIfChanged(filePath, content) {
  if (existsSync(filePath)) {
    const oldContent = await readFile(filePath, "utf8");

    if (oldContent === content) {
      console.log(`No change: ${filePath}`);
      return false;
    }
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  console.log(`Updated: ${filePath}`);
  return true;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const manifest = {
    updatedAt: new Date().toISOString(),
    files: {}
  };

  for (const source of SOURCES) {
    console.log(`Checking ${source.name}`);

    let content = await fetchText(source.url);

    if (source.type === "json") {
      content = JSON.stringify(JSON.parse(content), null, 2) + "\n";
    }

    const outputPath = path.join(OUT_DIR, source.out);
    await writeIfChanged(outputPath, content);

    manifest.files[source.name] = {
      sourceUrl: source.url,
      path: `/data/${source.out}`
    };
  }

  await writeIfChanged(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
