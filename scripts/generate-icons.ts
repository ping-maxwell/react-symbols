import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname =
  typeof import.meta.dirname === "string"
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const ROOT = resolve(__dirname, "..");
const LIBRARY_SRC = resolve(ROOT, "library/src");
const ICONS_DIR = resolve(ROOT, "icons");
const JSON_OUT = resolve(ROOT, "better-hub-icons.json");

// ---------------------------------------------------------------------------
// Step 1: Parse barrel files for exportName -> iconName (file basename)
// ---------------------------------------------------------------------------

function parseBarrelFile(filePath: string): Map<string, string> {
  const src = readFileSync(filePath, "utf-8");
  const map = new Map<string, string>();
  const re = /export\s*\{\s*default\s+as\s+(\w+)\s*\}\s*from\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const exportName = m[1]!;
    const importPath = m[2]!;
    map.set(exportName, basename(importPath));
  }
  return map;
}

const fileBarrel = parseBarrelFile(join(LIBRARY_SRC, "files.tsx"));
const folderBarrel = parseBarrelFile(join(LIBRARY_SRC, "folders.tsx"));

const exportToIcon = new Map<string, string>([...fileBarrel, ...folderBarrel]);

// Also build iconName -> source file path
const iconToSourceFile = new Map<string, string>();
for (const [, iconName] of fileBarrel) {
  iconToSourceFile.set(
    iconName,
    join(LIBRARY_SRC, "library", `${iconName}.tsx`),
  );
}
for (const [, iconName] of folderBarrel) {
  iconToSourceFile.set(
    iconName,
    join(LIBRARY_SRC, "library/folders", `${iconName}.tsx`),
  );
}

// ---------------------------------------------------------------------------
// Step 2: Extract SVG from each TSX file and write .svg files
// ---------------------------------------------------------------------------

const JSX_TO_HTML_ATTRS: Record<string, string> = {
  fillRule: "fill-rule",
  clipRule: "clip-rule",
  strokeWidth: "stroke-width",
  strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin",
  strokeMiterlimit: "stroke-miterlimit",
  fillOpacity: "fill-opacity",
  strokeOpacity: "stroke-opacity",
  strokeDasharray: "stroke-dasharray",
  strokeDashoffset: "stroke-dashoffset",
  stopColor: "stop-color",
  stopOpacity: "stop-opacity",
  className: "class",
  htmlFor: "for",
  xlinkHref: "xlink:href",
};

function convertJsxToHtml(svgContent: string): string {
  let result = svgContent;

  // Remove {...props} spread
  result = result.replace(/\s*\{\.\.\.props\}\s*/g, " ");

  // Remove JSX style attributes (e.g. style={{ isolation: "isolate" }})
  result = result.replace(/\s*style=\{\{[^}]*\}\}/g, "");

  // Convert JSX attribute names to HTML equivalents
  for (const [jsxAttr, htmlAttr] of Object.entries(JSX_TO_HTML_ATTRS)) {
    result = result.replaceAll(jsxAttr, htmlAttr);
  }

  // Convert self-closing JSX tags: <tag ... /> stays the same (valid SVG)
  // Convert JSX boolean close tags: ></tag> is fine

  // Clean up extra whitespace in opening tags
  result = result.replace(/<(\w+)\s{2,}/g, "<$1 ");

  return result.trim();
}

function extractSvg(filePath: string): string | null {
  const src = readFileSync(filePath, "utf-8");

  // Match the SVG block: from <svg to the closing </svg>
  const match = src.match(/<svg[\s\S]*<\/svg>/);
  if (!match) return null;

  return convertJsxToHtml(match[0]);
}

mkdirSync(ICONS_DIR, { recursive: true });

let svgCount = 0;
const failedIcons: string[] = [];

for (const [iconName, sourcePath] of iconToSourceFile) {
  const svg = extractSvg(sourcePath);
  if (!svg) {
    failedIcons.push(iconName);
    continue;
  }
  writeFileSync(join(ICONS_DIR, `${iconName}.svg`), svg + "\n");
  svgCount++;
}

if (failedIcons.length > 0) {
  console.warn(`⚠  Could not extract SVG from: ${failedIcons.join(", ")}`);
}
console.log(`✓ Wrote ${svgCount} SVG files to icons/`);

// ---------------------------------------------------------------------------
// Step 3: Parse the three mapping files to build the JSON
// ---------------------------------------------------------------------------

// Parse mapping files as text to extract { key: ReactSymbol.ExportName } pairs
function parseMappingFile(filePath: string): Array<[string, string]> {
  const src = readFileSync(filePath, "utf-8");
  const pairs: Array<[string, string]> = [];
  // Match lines like:  key: ReactSymbol.ExportName,
  //   or  "key.ext": ReactSymbol.ExportName,
  const re = /(?:"([^"]+)"|(\w+))\s*:\s*ReactSymbol\.(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const key = m[1] ?? m[2]!;
    const exportName = m[3]!;
    pairs.push([key, exportName]);
  }
  return pairs;
}

const extensionPairs = parseMappingFile(
  join(LIBRARY_SRC, "utils/extensions/fileExtensionIcons.tsx"),
);
const fileNamePairs = parseMappingFile(
  join(LIBRARY_SRC, "utils/extensions/fileNameIcons.tsx"),
);
const folderNamePairs = parseMappingFile(
  join(LIBRARY_SRC, "utils/extensions/folderNameIcons.tsx"),
);

// Build fileIcons: group by icon name
interface FileIconEntry {
  fileExtensions: string[];
  fileNames: string[];
}
const fileIconMap = new Map<string, FileIconEntry>();

function ensureFileEntry(iconName: string): FileIconEntry {
  let entry = fileIconMap.get(iconName);
  if (!entry) {
    entry = { fileExtensions: [], fileNames: [] };
    fileIconMap.set(iconName, entry);
  }
  return entry;
}

for (const [ext, exportName] of extensionPairs) {
  const iconName = exportToIcon.get(exportName);
  if (!iconName) {
    console.warn(`⚠  Extension "${ext}": unknown export "${exportName}"`);
    continue;
  }
  ensureFileEntry(iconName).fileExtensions.push(ext);
}

for (const [fileName, exportName] of fileNamePairs) {
  const iconName = exportToIcon.get(exportName);
  if (!iconName) {
    console.warn(`⚠  FileName "${fileName}": unknown export "${exportName}"`);
    continue;
  }
  ensureFileEntry(iconName).fileNames.push(fileName);
}

// Build folderIcons: group by icon name
const folderIconMap = new Map<string, string[]>();

for (const [folderName, exportName] of folderNamePairs) {
  const iconName = exportToIcon.get(exportName);
  if (!iconName) {
    console.warn(
      `⚠  FolderName "${folderName}": unknown export "${exportName}"`,
    );
    continue;
  }
  if (!folderIconMap.has(iconName)) folderIconMap.set(iconName, []);
  folderIconMap.get(iconName)!.push(folderName);
}

// Assemble arrays
const fileIcons = [...fileIconMap].map(([name, data]) => {
  const entry: Record<string, unknown> = { name };
  if (data.fileExtensions.length > 0)
    entry.fileExtensions = data.fileExtensions;
  if (data.fileNames.length > 0) entry.fileNames = data.fileNames;
  return entry;
});

const folderIcons = [...folderIconMap].map(([name, folderNames]) => ({
  name,
  folderNames,
}));

// ---------------------------------------------------------------------------
// Step 4: Write better-hub-icons.json
// ---------------------------------------------------------------------------

const output = {
  $schema: "https://betterhub.dev/schemas/icon-theme-data.json",
  baseURL:
    "https://raw.githubusercontent.com/pheralb/react-symbols/HEAD/icons/",
  defaultFile: "document",
  defaultFolder: "folder",
  defaultFolderOpen: "folderOpen",
  fileIcons,
  folderIcons,
};

writeFileSync(JSON_OUT, JSON.stringify(output, null, 2) + "\n");
console.log(
  `✓ Wrote better-hub-icons.json (${fileIcons.length} file icons, ${folderIcons.length} folder icons)`,
);
