import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

const OUT_DIR = "public/data";

const LANGUAGES = [
    "en",
    "ar",
    "es",
    "bg",
    "pt",
    "cs",
    "de",
    "da",
    "fi",
    "fr",
    "el",
    "hu",
    "it",
    "ja",
    "ko",
    "lt",
    "nl",
    "no",
    "pl",
    "ro",
    "ru",
    "sv",
    "sk",
    "tr"
];

const APP_LOOKUP_URL =
    "https://itunes.apple.com/lookup?id=585661281";

const EMPIRE_ITEMS_VERSION_URL =
    "https://empire-html5.goodgamestudios.com/default/items/ItemsVersion.properties";

const EMPIRE_ITEMS_BASE_URL =
    "https://empire-html5.goodgamestudios.com/default/items";

const LANGUAGE_VERSION_URL =
    "https://langserv.public.ggs-ep.com/12/fr/@metadata";

const LANGUAGE_BASE_URL =
    "https://langserv.public.ggs-ep.com";

const EMPIRE_DLL_BASE_URL =
    "https://empire-html5.goodgamestudios.com/default/dll";

const EMPIRE_DLL_VERSION_CANDIDATES = [
    `${EMPIRE_DLL_BASE_URL}/DLLVersion.properties`,
    `${EMPIRE_DLL_BASE_URL}/DllVersion.properties`,
    `${EMPIRE_DLL_BASE_URL}/dllVersion.properties`,
    `${EMPIRE_DLL_BASE_URL}/Version.properties`,
    `${EMPIRE_DLL_BASE_URL}/version.properties`
];

function dataPath(relativePath) {
    return `/data/${relativePath.replaceAll("\\", "/")}`;
}

function outputPath(relativePath) {
    return path.join(OUT_DIR, relativePath);
}

function slug(value) {
    return String(value)
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

async function ensureDir(dirPath) {
    await mkdir(dirPath, { recursive: true });
}

async function fetchText(url, timeout = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                "User-Agent": "ggempire-data-cache/1.0"
            }
        });

        if (!res.ok) {
            throw new Error(`Fetch failed ${res.status}: ${url}`);
        }

        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

async function fetchBuffer(url, timeout = 60000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                "User-Agent": "ggempire-data-cache/1.0"
            }
        });

        if (!res.ok) {
            throw new Error(`Fetch failed ${res.status}: ${url}`);
        }

        return Buffer.from(await res.arrayBuffer());
    } finally {
        clearTimeout(timer);
    }
}

async function readJsonIfExists(filePath, fallback) {
    if (!existsSync(filePath)) {
        return fallback;
    }

    try {
        const text = await readFile(filePath, "utf8");
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

async function writeTextIfChanged(filePath, content) {
    await ensureDir(path.dirname(filePath));

    if (existsSync(filePath)) {
        const oldContent = await readFile(filePath, "utf8");

        if (oldContent === content) {
            console.log(`No change: ${filePath}`);
            return false;
        }
    }

    await writeFile(filePath, content, "utf8");
    console.log(`Updated: ${filePath}`);
    return true;
}

async function writeBufferIfChanged(filePath, content) {
    await ensureDir(path.dirname(filePath));

    if (existsSync(filePath)) {
        const oldContent = await readFile(filePath);

        if (Buffer.compare(oldContent, content) === 0) {
            console.log(`No change: ${filePath}`);
            return false;
        }
    }

    await writeFile(filePath, content);
    console.log(`Updated: ${filePath}`);
    return true;
}

async function copyIfMissingOrChanged(fromPath, toPath) {
    await ensureDir(path.dirname(toPath));

    if (existsSync(fromPath) && existsSync(toPath)) {
        const from = await readFile(fromPath);
        const to = await readFile(toPath);

        if (Buffer.compare(from, to) === 0) {
            console.log(`No change: ${toPath}`);
            return false;
        }
    }

    await copyFile(fromPath, toPath);
    console.log(`Copied: ${toPath}`);
    return true;
}

function ensureHistoryShape(history) {
    return {
        empireItems: Array.isArray(history.empireItems) ? history.empireItems : [],
        e4kItems: Array.isArray(history.e4kItems) ? history.e4kItems : [],
        language: Array.isArray(history.language) ? history.language : [],
        empireDll: Array.isArray(history.empireDll) ? history.empireDll : []
    };
}

function addHistoryEntry(list, predicate, entry) {
    if (!list.some(predicate)) {
        list.push(entry);
    }
}

function parseEmpireItemVersion(text) {
    const match = text.match(/CastleItemXMLVersion=([^\s]+)/);

    if (!match) {
        throw new Error("CastleItemXMLVersion not found in ItemsVersion.properties.");
    }

    return match[1];
}

function parseLangVersion(metadata) {
    const version = metadata?.["@metadata"]?.versionNo;

    if (!version) {
        throw new Error("Language versionNo not found in metadata.");
    }

    return String(version);
}

function parseE4kLoaderVersionFromAppStore(appstoreJson) {
    const version = appstoreJson?.results?.[0]?.version;

    if (!version) {
        throw new Error("Could not resolve E4K App Store version.");
    }

    const parts = String(version).split(".");

    if (parts.length < 2) {
        throw new Error(`Unexpected E4K App Store version format: ${version}`);
    }

    const major = parts[0];
    const minor = parts[1];
    const patch = (parts[2] || "0").padStart(3, "0");

    return {
        appStoreVersion: String(version),
        loaderVersion: `${major}${minor}${patch}`
    };
}

function parseDllVersion(text) {
    const patterns = [
        /ggs\.dll\.([a-zA-Z0-9]+)\.js/i,
        /(?:DLLVersion|DllVersion|dllVersion|version|Version)\s*=\s*([a-zA-Z0-9]+)/,
        /([a-f0-9]{16,})/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);

        if (match?.[1]) {
            return match[1];
        }
    }

    return null;
}

async function resolveEmpireDllInfo() {
    for (const versionUrl of EMPIRE_DLL_VERSION_CANDIDATES) {
        try {
            const text = await fetchText(versionUrl, 15000);
            const version = parseDllVersion(text);

            if (!version) {
                continue;
            }

            return {
                version,
                versionUrl,
                dllUrl: `${EMPIRE_DLL_BASE_URL}/ggs.dll.${version}.js`,
                rawVersionFile: text
            };
        } catch (error) {
            console.warn(`DLL version candidate failed: ${versionUrl}`);
        }
    }

    console.warn("Could not resolve Empire DLL version. DLL cache will be skipped.");
    return null;
}

async function unpackE4kArchive(zipBuffer) {
    const zip = await JSZip.loadAsync(zipBuffer);
    const firstFile = Object.values(zip.files).find((file) => !file.dir);

    if (!firstFile) {
        throw new Error("The E4K archive did not contain any files.");
    }

    return await firstFile.async("text");
}

function parseE4kXmlToJson(xmlText) {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
        textNodeName: "value",
        trimValues: true,
        parseAttributeValue: false,
        parseTagValue: false
    });

    const parsed = parser.parse(xmlText);

    if (!parsed?.root) {
        throw new Error("The E4K XML root element is missing.");
    }

    return parsed.root;
}

async function updateEmpireItems({ history, manifest }) {
    console.log("");
    console.log("=== Empire items ===");

    const versionText = await fetchText(EMPIRE_ITEMS_VERSION_URL);
    const itemVersion = parseEmpireItemVersion(versionText);

    const versionRel = "empire/ItemsVersion.properties";
    await writeTextIfChanged(outputPath(versionRel), versionText);

    const archiveRel = `empire/items/items_${slug(itemVersion)}.json`;
    const latestRel = "empire/items_latest.json";
    const archivePath = outputPath(archiveRel);
    const latestPath = outputPath(latestRel);

    const shouldDownload =
        !existsSync(archivePath) ||
        !existsSync(latestPath);

    const itemsUrl =
        `${EMPIRE_ITEMS_BASE_URL}/items_v${itemVersion}.json`;

    if (shouldDownload) {
        console.log(`Downloading Empire items ${itemVersion}`);
        const itemsText = await fetchText(itemsUrl, 60000);

        JSON.parse(itemsText);

        await writeTextIfChanged(archivePath, itemsText);
        await writeTextIfChanged(latestPath, itemsText);
    } else {
        console.log(`Empire items ${itemVersion} already cached.`);
        await copyIfMissingOrChanged(archivePath, latestPath);
    }

    addHistoryEntry(
        history.empireItems,
        (entry) => String(entry.version) === String(itemVersion),
        {
            version: itemVersion,
            addedAt: new Date().toISOString(),
            sourceUrl: itemsUrl,
            file: dataPath(archiveRel),
            latestFile: dataPath(latestRel)
        }
    );

    manifest.empire = {
        itemVersion,
        itemVersionUrl: dataPath(versionRel),
        itemsUrl: dataPath(latestRel),
        archivedItemsUrl: dataPath(archiveRel),
        originalItemsUrl: itemsUrl
    };
}

async function updateLanguages({ history, manifest }) {
    console.log("");
    console.log("=== Languages ===");

    const metadataText = await fetchText(LANGUAGE_VERSION_URL);
    const metadata = JSON.parse(metadataText);
    const langVersion = parseLangVersion(metadata);

    const metadataRel = "lang/metadata.json";
    await writeTextIfChanged(
        outputPath(metadataRel),
        JSON.stringify(metadata, null, 2) + "\n"
    );

    const files = {};
    const archivedFiles = {};
    const failed = [];

    for (const langCode of LANGUAGES) {
        const latestRel = `lang/${langCode}.json`;
        const archiveRel = `lang/versions/${langCode}_${slug(langVersion)}.json`;

        const latestPath = outputPath(latestRel);
        const archivePath = outputPath(archiveRel);

        files[langCode] = dataPath(latestRel);
        archivedFiles[langCode] = dataPath(archiveRel);

        const shouldDownload =
            !existsSync(archivePath) ||
            !existsSync(latestPath);

        if (!shouldDownload) {
            console.log(`Language ${langCode} ${langVersion} already cached.`);
            await copyIfMissingOrChanged(archivePath, latestPath);
            continue;
        }

        const langUrl =
            `${LANGUAGE_BASE_URL}/12@${langVersion}/${langCode}/*`;

        try {
            console.log(`Downloading language ${langCode} ${langVersion}`);
            const langText = await fetchText(langUrl, 30000);

            JSON.parse(langText);

            await writeTextIfChanged(archivePath, langText);
            await writeTextIfChanged(latestPath, langText);
        } catch (error) {
            failed.push({
                langCode,
                message: error.message
            });

            console.warn(`Language failed: ${langCode} - ${error.message}`);

            if (!existsSync(latestPath)) {
                throw new Error(`Language ${langCode} failed and no previous latest file exists.`);
            }
        }
    }

    addHistoryEntry(
        history.language,
        (entry) => String(entry.version) === String(langVersion),
        {
            version: langVersion,
            addedAt: new Date().toISOString(),
            files: archivedFiles,
            latestFiles: files
        }
    );

    manifest.language = {
        version: langVersion,
        metadataUrl: dataPath(metadataRel),
        available: files,
        archived: archivedFiles,
        failed
    };
}

async function updateE4k({ history, manifest }) {
    console.log("");
    console.log("=== E4K ===");

    const appstoreText = await fetchText(APP_LOOKUP_URL);
    const appstoreJson = JSON.parse(appstoreText);

    const appstoreRel = "e4k/appstore.json";
    await writeTextIfChanged(
        outputPath(appstoreRel),
        JSON.stringify(appstoreJson, null, 2) + "\n"
    );

    const {
        appStoreVersion,
        loaderVersion
    } = parseE4kLoaderVersionFromAppStore(appstoreJson);

    const versionsUrl =
        `https://media.goodgamestudios.com/loader/empirefourkingdoms/${loaderVersion}/versions.json`;

    const versionsText = await fetchText(versionsUrl);
    const versionsJson = JSON.parse(versionsText);

    const itemVersion = versionsJson?.CastleItemXMLVersion;

    if (!itemVersion) {
        throw new Error("CastleItemXMLVersion missing from E4K versions.json.");
    }

    const versionsRel = "e4k/versions.json";
    await writeTextIfChanged(
        outputPath(versionsRel),
        JSON.stringify(versionsJson, null, 2) + "\n"
    );

    const normalizedItemVersion = String(itemVersion).replaceAll(".", "_");
    const ggsUrl =
        `https://media.goodgamestudios.com/loader/empirefourkingdoms/${loaderVersion}/itemsXML/items_${normalizedItemVersion}.ggs`;

    const archiveRel =
        `e4k/items/items_${slug(loaderVersion)}_${slug(itemVersion)}.json`;

    const latestRel = "e4k/items_latest.json";

    const archivePath = outputPath(archiveRel);
    const latestPath = outputPath(latestRel);

    const shouldDownload =
        !existsSync(archivePath) ||
        !existsSync(latestPath);

    if (shouldDownload) {
        console.log(`Downloading E4K items ${loaderVersion} / ${itemVersion}`);
        const zipBuffer = await fetchBuffer(ggsUrl, 90000);
        const xmlText = await unpackE4kArchive(zipBuffer);
        const parsed = parseE4kXmlToJson(xmlText);
        const jsonText = JSON.stringify(parsed);

        await writeTextIfChanged(archivePath, jsonText);
        await writeTextIfChanged(latestPath, jsonText);
    } else {
        console.log(`E4K items ${loaderVersion} / ${itemVersion} already cached.`);
        await copyIfMissingOrChanged(archivePath, latestPath);
    }

    addHistoryEntry(
        history.e4kItems,
        (entry) =>
            String(entry.appVersion) === String(loaderVersion) &&
            String(entry.itemVersion) === String(itemVersion),
        {
            appVersion: loaderVersion,
            appStoreVersion,
            itemVersion,
            addedAt: new Date().toISOString(),
            versionsSourceUrl: versionsUrl,
            sourceUrl: ggsUrl,
            file: dataPath(archiveRel),
            latestFile: dataPath(latestRel)
        }
    );

    manifest.e4k = {
        appVersion: loaderVersion,
        appStoreVersion,
        itemVersion,
        appstoreUrl: dataPath(appstoreRel),
        versionsUrl: dataPath(versionsRel),
        itemsUrl: dataPath(latestRel),
        archivedItemsUrl: dataPath(archiveRel),
        originalVersionsUrl: versionsUrl,
        originalItemsUrl: ggsUrl
    };
}

async function updateEmpireDll({ history, manifest }) {
    console.log("");
    console.log("=== Empire DLL ===");

    const info = await resolveEmpireDllInfo();

    if (!info) {
        manifest.empireDll = {
            available: false,
            reason: "Could not resolve DLL version."
        };
        return;
    }

    const versionRel = "empire/dll/version.json";
    const latestRel = "empire/dll/ggs.dll.latest.js";
    const archiveRel = `empire/dll/versions/ggs.dll.${slug(info.version)}.js`;

    const latestPath = outputPath(latestRel);
    const archivePath = outputPath(archiveRel);

    const shouldDownload =
        !existsSync(archivePath) ||
        !existsSync(latestPath);

    if (shouldDownload) {
        console.log(`Downloading Empire DLL ${info.version}`);
        const dllText = await fetchText(info.dllUrl, 60000);

        await writeTextIfChanged(archivePath, dllText);
        await writeTextIfChanged(latestPath, dllText);
    } else {
        console.log(`Empire DLL ${info.version} already cached.`);
        await copyIfMissingOrChanged(archivePath, latestPath);
    }

    const versionInfo = {
        version: info.version,
        versionUrl: info.versionUrl,
        dllUrl: info.dllUrl,
        latestFile: dataPath(latestRel),
        archivedFile: dataPath(archiveRel),
        checkedAt: new Date().toISOString()
    };

    await writeTextIfChanged(
        outputPath(versionRel),
        JSON.stringify(versionInfo, null, 2) + "\n"
    );

    addHistoryEntry(
        history.empireDll,
        (entry) => String(entry.version) === String(info.version),
        {
            version: info.version,
            addedAt: new Date().toISOString(),
            versionUrl: info.versionUrl,
            sourceUrl: info.dllUrl,
            file: dataPath(archiveRel),
            latestFile: dataPath(latestRel)
        }
    );

    manifest.empireDll = {
        available: true,
        version: info.version,
        versionUrl: dataPath(versionRel),
        dllUrl: dataPath(latestRel),
        archivedDllUrl: dataPath(archiveRel),
        originalDllUrl: info.dllUrl
    };
}

async function main() {
    await ensureDir(OUT_DIR);

    const historyPath = outputPath("version-history.json");
    const history = ensureHistoryShape(
        await readJsonIfExists(historyPath, {})
    );

    const manifest = {
        updatedAt: new Date().toISOString(),
        generatedBy: "GitHub Actions",
        languages: LANGUAGES
    };

    await updateEmpireItems({ history, manifest });
    await updateLanguages({ history, manifest });
    await updateE4k({ history, manifest });
    await updateEmpireDll({ history, manifest });

    await writeTextIfChanged(
        outputPath("manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n"
    );

    await writeTextIfChanged(
        historyPath,
        JSON.stringify(history, null, 2) + "\n"
    );

    console.log("");
    console.log("Done.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
