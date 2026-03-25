import fs from "node:fs/promises";
import path from "node:path";
import XLSX from "xlsx";

const rootDir = process.cwd();
const dataDir = path.join(rootDir, "data");
const docsPath = path.join(dataDir, "documents.json");
const historyPath = path.join(dataDir, "history.json");

const ercotExtractedDir = path.join(dataDir, "ercot", "extracted");

const sourceDocuments = [
  path.join(dataDir, "source-docs", "2024-power-docs", "231018_Northern Immersion LLC - AMA QSE, LLC - DR Agreement (fully executed).pdf"),
  path.join(dataDir, "source-docs", "2024-power-docs", "231018_Northern Immersion LLC - Ammper Power LLC - Retail Agreement (executed).pdf"),
  path.join(dataDir, "source-docs", "2024-power-docs", "Northern Immersion_2024 Statements.pdf")
];

function parseDeliveryDateParts(value) {
  const match = String(value ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, month, day, year] = match;
  return { year: Number(year), month: Number(month), day: Number(day) };
}

function buildTimestamp(row) {
  const dateParts = parseDeliveryDateParts(row["Delivery Date"]);
  if (!dateParts) return null;

  if (row["Hour Ending"]) {
    const match = String(row["Hour Ending"]).match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const startHour = Math.max(Number(match[1]) - 1, 0);
    const minute = Number(match[2]);
    return new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, startHour, minute, 0)).toISOString();
  }

  const deliveryHour = Number(row["Delivery Hour"]);
  const deliveryInterval = Number(row["Delivery Interval"]);
  if (!Number.isNaN(deliveryHour) && !Number.isNaN(deliveryInterval)) {
    const totalMinutes = (deliveryHour - 1) * 60 + (deliveryInterval - 1) * 5;
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    return new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, hour, minute, 0)).toISOString();
  }

  return null;
}

function readWorkbookRows(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  return workbook.SheetNames.flatMap((sheetName) =>
    XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" })
  );
}

function normalizeRows(rows, fileName) {
  const market = fileName.includes("DAMLZHBSPP") ? "DAM" : "RTM";
  return rows
    .map((row, index) => {
      const settlementPoint = String(row["Settlement Point"] || row["Settlement Point Name"] || "").trim();
      const settlementPointType = String(row["Settlement Point Type"] || "").trim();
      if (settlementPoint !== "LZ_SOUTH") return null;
      if (settlementPointType && settlementPointType !== "LZ") return null;

      const intervalStart = buildTimestamp(row);
      const priceUsdPerMWh = Number(row["Settlement Point Price"]);
      if (!intervalStart || Number.isNaN(priceUsdPerMWh)) return null;

      return {
        id: `${fileName}-${index}-${intervalStart}-${settlementPoint}`,
        intervalStart,
        settlementPoint,
        market,
        priceUsdPerMWh,
        source: fileName
      };
    })
    .filter(Boolean);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function main() {
  const ercotFiles = (await fs.readdir(ercotExtractedDir))
    .filter((name) => name.endsWith(".xlsx") && (name.includes("DAMLZHBSPP_") || name.includes("RTMLZHBSPP_")))
    .sort()
    .map((name) => path.join(ercotExtractedDir, name));

  const [, currentDocuments] = await Promise.all([
    readJson(historyPath, []),
    readJson(docsPath, [])
  ]);

  const priceRows = ercotFiles.flatMap((filePath) => normalizeRows(readWorkbookRows(filePath), path.basename(filePath)));
  const dedupedHistory = Array.from(new Map(priceRows.map((item) => [item.id, item])).values()).sort(
    (a, b) => a.intervalStart.localeCompare(b.intervalStart)
  );

  const nextDocuments = [...currentDocuments];

  for (const filePath of ercotFiles) {
    const name = path.basename(filePath);
    if (!nextDocuments.some((item) => item.path === filePath)) {
      nextDocuments.push({
        id: `seed-${name}`,
        name,
        uploadedAt: new Date().toISOString(),
        path: filePath,
        type: "ercot"
      });
    }
  }

  for (const filePath of sourceDocuments) {
    const name = path.basename(filePath);
    if (!nextDocuments.some((item) => item.path === filePath)) {
      nextDocuments.push({
        id: `seed-${name}`,
        name,
        uploadedAt: new Date().toISOString(),
        path: filePath,
        type: "aep"
      });
    }
  }

  await Promise.all([
    fs.writeFile(historyPath, JSON.stringify(dedupedHistory, null, 2)),
    fs.writeFile(docsPath, JSON.stringify(nextDocuments, null, 2))
  ]);

  console.log(JSON.stringify({
    importedPriceRows: priceRows.length,
    storedPriceRows: dedupedHistory.length,
    storedDocuments: nextDocuments.length
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
