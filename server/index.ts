import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";

type Market = "RTM" | "DAM";

interface PricePoint {
  id: string;
  intervalStart: string;
  settlementPoint: string;
  market: Market;
  priceUsdPerMWh: number;
  source: string;
}

interface StrikeConfig {
  siteLoadMw: number;
  curtailStrikeUsdPerMWh: number;
  sellBackStrikeUsdPerMWh: number;
}

interface DocumentRecord {
  id: string;
  name: string;
  uploadedAt: string;
  path: string;
  type: "aep" | "ercot";
}

interface LivePrice {
  settlementPoint: string;
  priceUsdPerMWh: number;
  publishedAt: string;
  source: string;
}

const rootDir = process.cwd();
const bundledDataDir = path.join(rootDir, "data");
const dataDir = process.env.DATA_DIR ?? path.join(rootDir, "data");
const uploadDir = path.join(dataDir, "uploads");
const pricePath = path.join(dataDir, "history.json");
const docsPath = path.join(dataDir, "documents.json");
const configPath = path.join(dataDir, "strike-config.json");
const app = express();
const upload = multer({ dest: uploadDir });
const authEnabled = process.env.DASHBOARD_AUTH_ENABLED === "true";
const dashboardUsername = process.env.DASHBOARD_USERNAME;
const dashboardPassword = process.env.DASHBOARD_PASSWORD;

const defaultConfig: StrikeConfig = {
  siteLoadMw: 25,
  curtailStrikeUsdPerMWh: 75,
  sellBackStrikeUsdPerMWh: 150
};

app.use(express.json());

app.use((req, res, next) => {
  if (!authEnabled || req.path === "/api/health") {
    next();
    return;
  }

  if (!dashboardUsername || !dashboardPassword) {
    res.status(503).send("Dashboard authentication is enabled but credentials are not configured.");
    return;
  }

  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Clutch Mining Dashboard"');
    res.status(401).send("Authentication required.");
    return;
  }

  const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  const username = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : "";
  const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

  if (username !== dashboardUsername || password !== dashboardPassword) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Clutch Mining Dashboard"');
    res.status(401).send("Invalid credentials.");
    return;
  }

  next();
});

async function ensureStorage() {
  await fs.mkdir(uploadDir, { recursive: true });
  await seedConfig();
  await seedHistory();
  await seedDocuments();
}

async function seedIfMissing(target: string, value: unknown) {
  if (!existsSync(target)) {
    await fs.writeFile(target, JSON.stringify(value, null, 2));
  }
}

async function copyBundledJsonIfAvailable(target: string, bundledFileName: string) {
  const bundledPath = path.join(bundledDataDir, bundledFileName);
  if (!existsSync(bundledPath)) {
    return false;
  }

  await fs.copyFile(bundledPath, target);
  return true;
}

async function seedConfig() {
  if (!existsSync(configPath)) {
    const copied = await copyBundledJsonIfAvailable(configPath, "strike-config.json");
    if (!copied) {
      await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
    }
    return;
  }

  try {
    const current = await readJson<StrikeConfig>(configPath);
    if (!current || typeof current.siteLoadMw !== "number") {
      throw new Error("Invalid config");
    }
  } catch {
    const copied = await copyBundledJsonIfAvailable(configPath, "strike-config.json");
    if (!copied) {
      await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
    }
  }
}

async function seedHistory() {
  if (!existsSync(pricePath)) {
    const copied = await copyBundledJsonIfAvailable(pricePath, "history.json");
    if (!copied) {
      await fs.writeFile(pricePath, JSON.stringify([], null, 2));
    }
    return;
  }

  try {
    const current = await readJson<PricePoint[]>(pricePath);
    if (Array.isArray(current) && current.length > 0) {
      return;
    }
  } catch {
    // fall through and replace from bundle
  }

  const copied = await copyBundledJsonIfAvailable(pricePath, "history.json");
  if (!copied) {
    await fs.writeFile(pricePath, JSON.stringify([], null, 2));
  }
}

async function seedDocuments() {
  if (!existsSync(docsPath)) {
    const copied = await copyBundledJsonIfAvailable(docsPath, "documents.json");
    if (!copied) {
      await fs.writeFile(docsPath, JSON.stringify([], null, 2));
    }
    return;
  }

  try {
    const current = await readJson<DocumentRecord[]>(docsPath);
    if (Array.isArray(current) && current.length > 0) {
      return;
    }
  } catch {
    // fall through and replace from bundle when possible
  }

  const copied = await copyBundledJsonIfAvailable(docsPath, "documents.json");
  if (!copied) {
    await fs.writeFile(docsPath, JSON.stringify([], null, 2));
  }
}

async function readJson<T>(target: string): Promise<T> {
  const raw = await fs.readFile(target, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJson(target: string, value: unknown) {
  await fs.writeFile(target, JSON.stringify(value, null, 2));
}

function parseTimestamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseDeliveryDateParts(value: unknown) {
  if (!value) return null;
  const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, month, day, year] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day)
  };
}

function buildTimestampFromStructuredFields(row: Record<string, unknown>): string | null {
  const dateParts = parseDeliveryDateParts(row["Delivery Date"]);
  if (!dateParts) return null;

  const hourEnding = row["Hour Ending"];
  if (hourEnding) {
    const hourMatch = String(hourEnding).match(/^(\d{1,2}):(\d{2})$/);
    if (!hourMatch) return null;
    const hourEndingValue = Number(hourMatch[1]);
    const minute = Number(hourMatch[2]);
    const startHour = Math.max(hourEndingValue - 1, 0);
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

function toRowsFromWorkbook(filePath: string) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  return workbook.SheetNames.flatMap((sheetName) =>
    XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: "" })
  );
}

async function getRows(filePath: string, originalName: string) {
  const extension = path.extname(originalName).toLowerCase();
  if (extension === ".xlsx") {
    return toRowsFromWorkbook(filePath);
  }

  const raw = await fs.readFile(filePath, "utf8");
  return parse(raw, { columns: true, skip_empty_lines: true }) as Record<string, unknown>[];
}

function detectMarket(fileName: string, row: Record<string, unknown>): Market {
  const joined = `${fileName} ${Object.keys(row).join(" ")}`.toUpperCase();
  return joined.includes("DAM") || joined.includes("DAY") ? "DAM" : "RTM";
}

function detectSettlementPoint(row: Record<string, unknown>): string {
  const keys = ["Settlement Point", "Settlement Point Name", "SETTLEMENT_POINT", "SettlementPoint"];
  for (const key of keys) {
    const value = row[key];
    if (value) return String(value).trim();
  }
  return "";
}

function detectTimestamp(row: Record<string, unknown>): string | null {
  const structuredTimestamp = buildTimestampFromStructuredFields(row);
  if (structuredTimestamp) return structuredTimestamp;

  const keys = [
    "Interval Start",
    "Delivery Date",
    "Settlement Point Price Time",
    "SCED Timestamp",
    "Operating Day",
    "Datetime",
    "Timestamp",
    "Hour Ending"
  ];
  for (const key of keys) {
    const value = parseTimestamp(row[key]);
    if (value) return value;
  }
  return null;
}

function detectPrice(row: Record<string, unknown>): number | null {
  const keys = ["Settlement Point Price", "SPP", "Price", "LMP", "SettlementPointPrice"];
  for (const key of keys) {
    const value = row[key];
    const numeric = Number(value);
    if (!Number.isNaN(numeric)) return numeric;
  }
  return null;
}

function normalizeRows(rows: Record<string, unknown>[], fileName: string): PricePoint[] {
  return rows
    .map((row, index) => {
      const settlementPoint = detectSettlementPoint(row);
      const settlementPointType = String(row["Settlement Point Type"] ?? "").trim();
      const intervalStart = detectTimestamp(row);
      const priceUsdPerMWh = detectPrice(row);
      if (!intervalStart || priceUsdPerMWh == null) return null;
      if (settlementPoint && settlementPoint !== "LZ_SOUTH") return null;
      if (settlementPointType && settlementPointType !== "LZ") return null;

      return {
        id: `${fileName}-${index}-${intervalStart}`,
        intervalStart,
        settlementPoint: settlementPoint || "LZ_SOUTH",
        market: detectMarket(fileName, row),
        priceUsdPerMWh,
        source: fileName
      } satisfies PricePoint;
    })
    .filter((item): item is PricePoint => Boolean(item))
    .sort((a, b) => a.intervalStart.localeCompare(b.intervalStart));
}

async function scrapeLiveSouthPrice(): Promise<LivePrice | null> {
  const response = await fetch("https://www.ercot.com/content/cdr/html/hb_lz.html");
  if (!response.ok) {
    return null;
  }
  const html = await response.text();
  const updatedMatch = html.match(/Last Updated:\s*([^<]+)/i);
  const southRowMatch = html.match(
    /<tr>\s*<td[^>]*>\s*(?:HB_SOUTH|LZ_SOUTH)\s*<\/td>\s*<td[^>]*>\s*([-.0-9]+)\s*<\/td>/i
  );
  const legacyMatch = html.match(/(?:HB_SOUTH|LZ_SOUTH)\s*\|\s*([-0-9.]+)/i);

  const parsedPrice = Number(southRowMatch?.[1] ?? legacyMatch?.[1]);
  if (Number.isNaN(parsedPrice)) {
    return null;
  }

  const updatedAt = updatedMatch?.[1]?.trim() ?? new Date().toISOString();
  return {
    settlementPoint: "HB_SOUTH",
    priceUsdPerMWh: parsedPrice,
    publishedAt: new Date(updatedAt).toISOString(),
    source: "ERCOT hb_lz.html"
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

if (process.env.NODE_ENV !== "production") {
  app.get("/", (_req, res) => {
  res.type("text/plain").send("Clutch Mining dashboard API is running. Open http://localhost:5173 for the UI.");
  });
}

app.get("/api/dashboard", async (_req, res) => {
  await ensureStorage();
  const [priceHistory, documents, strikeConfig] = await Promise.all([
    readJson<PricePoint[]>(pricePath),
    readJson<DocumentRecord[]>(docsPath),
    readJson<StrikeConfig>(configPath)
  ]);

  let livePrice: LivePrice | null = null;
  try {
    livePrice = await scrapeLiveSouthPrice();
  } catch {
    livePrice = null;
  }

  const year = typeof _req.query.year === "string" ? _req.query.year : "all";
  const market = typeof _req.query.market === "string" ? _req.query.market : "all";
  const availableYears = [...new Set(priceHistory.map((item) => item.intervalStart.slice(0, 4)))].sort();
  const filteredHistory = priceHistory.filter((item) => {
    const matchesYear = year === "all" || item.intervalStart.startsWith(year);
    const matchesMarket = market === "all" || item.market === market;
    return matchesYear && matchesMarket;
  });

  res.json({ livePrice, priceHistory: filteredHistory, strikeConfig, documents, availableYears });
});

app.post("/api/config", async (req, res) => {
  await ensureStorage();
  const nextConfig = req.body as StrikeConfig;
  await writeJson(configPath, nextConfig);
  res.json({ ok: true });
});

app.post("/api/import/ercot", upload.single("file"), async (req, res) => {
  await ensureStorage();
  if (!req.file) {
    res.status(400).json({ error: "Missing file." });
    return;
  }

  const normalized = normalizeRows(await getRows(req.file.path, req.file.originalname), req.file.originalname);
  const current = await readJson<PricePoint[]>(pricePath);
  const next = [...current, ...normalized].sort((a, b) => a.intervalStart.localeCompare(b.intervalStart));
  const deduped = Array.from(new Map(next.map((item) => [item.id, item])).values());
  const documents = await readJson<DocumentRecord[]>(docsPath);

  documents.push({
    id: `${Date.now()}-${req.file.originalname}`,
    name: req.file.originalname,
    uploadedAt: new Date().toISOString(),
    path: req.file.path,
    type: "ercot"
  });

  await Promise.all([writeJson(pricePath, deduped), writeJson(docsPath, documents)]);
  res.json({ imported: normalized.length });
});

app.post("/api/import/aep", upload.single("file"), async (req, res) => {
  await ensureStorage();
  if (!req.file) {
    res.status(400).json({ error: "Missing file." });
    return;
  }

  const documents = await readJson<DocumentRecord[]>(docsPath);
  documents.push({
    id: `${Date.now()}-${req.file.originalname}`,
    name: req.file.originalname,
    uploadedAt: new Date().toISOString(),
    path: req.file.path,
    type: "aep"
  });
  await writeJson(docsPath, documents);
  res.json({ ok: true });
});

if (process.env.NODE_ENV === "production") {
  const clientDir = path.join(rootDir, "dist");
  app.use(express.static(clientDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

ensureStorage().then(() => {
  app.listen(port, host, () => {
    console.log(`Server listening on ${host}:${port}`);
  });
});
