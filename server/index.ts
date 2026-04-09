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

interface ExportScenario extends StrikeConfig {
  ersOffsetUsdPerKWh: number;
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
const temporaryGuestUsername = "temp-guest";
const temporaryGuestPassword = "clutchpower";

const defaultConfig: StrikeConfig = {
  siteLoadMw: 25,
  curtailStrikeUsdPerMWh: 75,
  sellBackStrikeUsdPerMWh: 150
};

const billAdderModel = {
  fixedRetailAdderUsdPerKWh: 0,
  marketPassThroughUsdPerKWh: 0.0037511601549620847,
  tdspUsdPerKWh: 0.02913,
  taxesUsdPerKWh: 0.0031956396307286517,
  taxRate: 0.06887661141804789
};

const aepPrimaryDeliveryTariff = {
  customerChargeUsdPerMonth: 2.15,
  meterChargeUsdPerMonth: 164.56,
  distributionSystemUsdPerKwMonth: 4.899,
  tcrfNcpUsdPerKwMonth: 2.337481,
  tcrf4cpUsdPerKwMonth: 4.966423,
  dcrfUsdPerKwMonth: 0.350849,
  eecrfUsdPerKWh: 0.000502,
  srcUsdPerKwMonth: 0.188063,
  adfitUsdPerKwMonth: -0.010529,
  rarUsdPerKwMonth: 0.043582,
  mobileTeeeUsdPerKwMonth: 0.2275,
  rceBaseRevenueFactor: 0.00238
};

const averageBillingHoursPerMonth = 730;
let historySyncPromise: Promise<number> | null = null;
let lastHistorySyncAt = 0;

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

  const matchesPrimary = username === dashboardUsername && password === dashboardPassword;
  const matchesGuest = username === temporaryGuestUsername && password === temporaryGuestPassword;

  if (!matchesPrimary && !matchesGuest) {
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

function getIntervalHours(point: Pick<PricePoint, "market">) {
  return point.market === "RTM" ? 5 / 60 : 1;
}

function deriveStatus(point: PricePoint, config: StrikeConfig) {
  if (point.priceUsdPerMWh >= config.sellBackStrikeUsdPerMWh) {
    return "sell_back";
  }
  if (point.priceUsdPerMWh >= config.curtailStrikeUsdPerMWh) {
    return "curtail";
  }
  return "compute";
}

function averageHours(points: PricePoint[], config: StrikeConfig, predicate: (item: PricePoint) => boolean) {
  let matchingHours = 0;
  let totalHours = 0;
  for (const point of points) {
    const intervalHours = getIntervalHours(point);
    totalHours += intervalHours;
    if (predicate(point)) {
      matchingHours += intervalHours;
    }
  }
  return totalHours === 0 ? 0 : matchingHours / totalHours;
}

function summarizeHistory(points: PricePoint[], config: StrikeConfig) {
  return points.reduce(
    (acc, point) => {
      const status = deriveStatus(point, config);
      const intervalHours = getIntervalHours(point);
      const intervalMWh = intervalHours * config.siteLoadMw;
      acc.totalHours += intervalHours;
      if (status === "compute") {
        acc.computeHours += intervalHours;
        acc.computeMWh += intervalMWh;
      }
      return acc;
    },
    { totalHours: 0, computeHours: 0, computeMWh: 0 }
  );
}

function calculateModernAdderModel(siteLoadMw: number, miningUptimePct: number, fourCpEligibilityShare: number) {
  const siteLoadKw = siteLoadMw * 1000;
  const miningLoadFactor = Math.max(miningUptimePct / 100, 0.01);
  const miningKWhPerMonth = siteLoadKw * averageBillingHoursPerMonth * miningLoadFactor;
  const baseRevenueUsd =
    aepPrimaryDeliveryTariff.customerChargeUsdPerMonth +
    aepPrimaryDeliveryTariff.meterChargeUsdPerMonth +
    siteLoadKw * aepPrimaryDeliveryTariff.distributionSystemUsdPerKwMonth;
  const demandChargesUsdPerMonth =
    aepPrimaryDeliveryTariff.customerChargeUsdPerMonth +
    aepPrimaryDeliveryTariff.meterChargeUsdPerMonth +
    siteLoadKw *
      (aepPrimaryDeliveryTariff.distributionSystemUsdPerKwMonth +
        aepPrimaryDeliveryTariff.tcrfNcpUsdPerKwMonth +
        aepPrimaryDeliveryTariff.dcrfUsdPerKwMonth +
        aepPrimaryDeliveryTariff.srcUsdPerKwMonth +
        aepPrimaryDeliveryTariff.adfitUsdPerKwMonth +
        aepPrimaryDeliveryTariff.rarUsdPerKwMonth +
        aepPrimaryDeliveryTariff.mobileTeeeUsdPerKwMonth) +
    baseRevenueUsd * aepPrimaryDeliveryTariff.rceBaseRevenueFactor;
  const variableChargesUsdPerMonth =
    miningKWhPerMonth *
    (aepPrimaryDeliveryTariff.eecrfUsdPerKWh +
      billAdderModel.fixedRetailAdderUsdPerKWh +
      billAdderModel.marketPassThroughUsdPerKWh);
  const fourCpAvoidedUsdPerMonth =
    siteLoadKw * aepPrimaryDeliveryTariff.tcrf4cpUsdPerKwMonth * fourCpEligibilityShare;
  const pretaxModernUsdPerMonth = demandChargesUsdPerMonth + variableChargesUsdPerMonth;
  const pretaxWithoutFourCpManagementUsdPerMonth = pretaxModernUsdPerMonth + fourCpAvoidedUsdPerMonth;
  const taxesAfterFourCpUsdPerMonth = pretaxModernUsdPerMonth * billAdderModel.taxRate;
  const taxesBeforeFourCpUsdPerMonth = pretaxWithoutFourCpManagementUsdPerMonth * billAdderModel.taxRate;

  return {
    deliveredAdderAfterFourCpUsdPerKWh:
      (pretaxModernUsdPerMonth + taxesAfterFourCpUsdPerMonth) / miningKWhPerMonth,
    fourCpCreditUsdPerKWh:
      (pretaxWithoutFourCpManagementUsdPerMonth +
        taxesBeforeFourCpUsdPerMonth -
        pretaxModernUsdPerMonth -
        taxesAfterFourCpUsdPerMonth) /
      miningKWhPerMonth
  };
}

function csvEscape(value: unknown) {
  const stringValue = value == null ? "" : String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function toCsv(rows: Array<Array<string | number>>) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function filterHistory(
  history: PricePoint[],
  selectedYear: string,
  selectedMarket: string,
  start?: string,
  end?: string
) {
  const startDate = start ? new Date(`${start}T00:00:00Z`) : null;
  const endDate = end ? new Date(`${end}T23:59:59Z`) : null;
  return history.filter((point) => {
    const itemDate = new Date(point.intervalStart);
    const matchesYear = startDate || endDate ? true : selectedYear === "all" || point.intervalStart.startsWith(selectedYear);
    const matchesMarket = selectedMarket === "all" || point.market === selectedMarket;
    const matchesStart = !startDate || itemDate >= startDate;
    const matchesEnd = !endDate || itemDate <= endDate;
    return matchesYear && matchesMarket && matchesStart && matchesEnd;
  });
}

function appendLivePricePoint(
  filteredHistory: PricePoint[],
  livePrice: LivePrice | null,
  selectedMarket: string,
  start?: string,
  end?: string
) {
  if (!livePrice) {
    return filteredHistory;
  }

  if (selectedMarket !== "all" && selectedMarket !== "RTM") {
    return filteredHistory;
  }

  const liveTimestamp = new Date(livePrice.publishedAt);
  const startDate = start ? new Date(`${start}T00:00:00Z`) : null;
  const endDate = end ? new Date(`${end}T23:59:59Z`) : null;

  if (startDate && liveTimestamp < startDate) {
    return filteredHistory;
  }

  if (endDate && liveTimestamp > endDate) {
    return filteredHistory;
  }

  const syntheticPoint: PricePoint = {
    id: `live-${livePrice.publishedAt}-${livePrice.settlementPoint}`,
    intervalStart: livePrice.publishedAt,
    settlementPoint: livePrice.settlementPoint === "HB_SOUTH" ? "LZ_SOUTH" : livePrice.settlementPoint,
    market: "RTM",
    priceUsdPerMWh: livePrice.priceUsdPerMWh,
    source: livePrice.source
  };

  const alreadyPresent = filteredHistory.some((item) => item.intervalStart === syntheticPoint.intervalStart);
  if (alreadyPresent) {
    return filteredHistory;
  }

  return [...filteredHistory, syntheticPoint].sort((a, b) => a.intervalStart.localeCompare(b.intervalStart));
}

function formatErcotDay(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
}

function extractTableRows(html: string) {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) {
    return [];
  }

  return Array.from(tableMatch[0].matchAll(/<tr[\s\S]*?>([\s\S]*?)<\/tr>/gi)).map(([, rowHtml]) =>
    Array.from(rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)).map(([, cellHtml]) => stripTags(cellHtml))
  );
}

function buildUtcLikeTimestamp(dateText: string, endingText: string, market: Market) {
  const dateMatch = dateText.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!dateMatch) {
    return null;
  }

  const [, month, day, year] = dateMatch;
  if (market === "RTM") {
    const intervalMatch = endingText.match(/^(\d{2})(\d{2})$/);
    if (!intervalMatch) {
      return null;
    }
    const endingHour = Number(intervalMatch[1]);
    const endingMinute = Number(intervalMatch[2]);
    const totalEndingMinutes = endingHour * 60 + endingMinute;
    const startMinutes = totalEndingMinutes - 15;
    const startHour = Math.floor(startMinutes / 60);
    const startMinute = startMinutes % 60;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), startHour, startMinute, 0)).toISOString();
  }

  const hourEnding = Number(endingText.trim());
  if (Number.isNaN(hourEnding)) {
    return null;
  }
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hourEnding - 1, 0, 0)).toISOString();
}

function parseSettlementPointDailyPage(html: string, market: Market, source: string): PricePoint[] {
  const rows = extractTableRows(html);
  if (rows.length < 2) {
    return [];
  }

  const header = rows[0];
  const settlementIndex = header.findIndex((value) => value === "LZ_SOUTH");
  if (settlementIndex < 0) {
    return [];
  }

  const dateIndex = header.findIndex((value) => value === "Oper Day");
  const endingIndex = header.findIndex((value) => value === "Interval Ending" || value === "Hour Ending");
  if (dateIndex < 0 || endingIndex < 0) {
    return [];
  }

  return rows
    .slice(1)
    .map((row) => {
      const intervalStart = buildUtcLikeTimestamp(row[dateIndex] ?? "", row[endingIndex] ?? "", market);
      const priceUsdPerMWh = Number(row[settlementIndex]);
      if (!intervalStart || Number.isNaN(priceUsdPerMWh)) {
        return null;
      }
      return {
        id: `${source}-${intervalStart}-LZ_SOUTH`,
        intervalStart,
        settlementPoint: "LZ_SOUTH",
        market,
        priceUsdPerMWh,
        source
      } satisfies PricePoint;
    })
    .filter((item): item is PricePoint => Boolean(item));
}

async function fetchDailySettlementPoints(day: Date, market: Market) {
  const dayToken = formatErcotDay(day);
  const pageName = market === "RTM" ? "real_time_spp" : "dam_spp";
  const url = `https://www.ercot.com/content/cdr/html/${dayToken}_${pageName}.html`;
  const response = await fetch(url);
  if (!response.ok) {
    return [];
  }
  const html = await response.text();
  return parseSettlementPointDailyPage(html, market, `${dayToken}_${pageName}.html`);
}

function dedupePriceHistory(history: PricePoint[]) {
  const keyed = new Map<string, PricePoint>();
  for (const item of history) {
    keyed.set(`${item.market}|${item.intervalStart}|${item.settlementPoint}`, item);
  }
  return [...keyed.values()].sort((a, b) => a.intervalStart.localeCompare(b.intervalStart));
}

async function syncMissingErcotHistory(force = false) {
  if (historySyncPromise) {
    return historySyncPromise;
  }

  if (!force && Date.now() - lastHistorySyncAt < 15 * 60 * 1000) {
    return 0;
  }

  historySyncPromise = (async () => {
    const current = await readJson<PricePoint[]>(pricePath);
    const latestPoint = current.at(-1);
    const today = new Date();
    const todayUtcDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    let startDay = latestPoint
      ? new Date(Date.UTC(
          Number(latestPoint.intervalStart.slice(0, 4)),
          Number(latestPoint.intervalStart.slice(5, 7)) - 1,
          Number(latestPoint.intervalStart.slice(8, 10))
        ))
      : todayUtcDay;

    if (startDay > todayUtcDay) {
      startDay = todayUtcDay;
    }

    const fetched: PricePoint[] = [];
    for (let cursor = new Date(startDay); cursor <= todayUtcDay; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const [damRows, rtmRows] = await Promise.all([
        fetchDailySettlementPoints(new Date(cursor), "DAM"),
        fetchDailySettlementPoints(new Date(cursor), "RTM")
      ]);
      fetched.push(...damRows, ...rtmRows);
    }

    if (fetched.length > 0) {
      const next = dedupePriceHistory([...current, ...fetched]);
      await writeJson(pricePath, next);
      console.log(`ERCOT sync wrote ${fetched.length} rows. History now ${next.length} rows.`);
    }

    if (fetched.length === 0) {
      console.log("ERCOT sync found no new rows.");
    }

    lastHistorySyncAt = Date.now();
    return fetched.length;
  })();

  try {
    return await historySyncPromise;
  } finally {
    historySyncPromise = null;
  }
}

function buildExportWorkbook(
  history: PricePoint[],
  scenario: ExportScenario,
  selectedYear: string,
  selectedMarket: string,
  start?: string,
  end?: string
) {
  const filteredHistory = filterHistory(history, selectedYear, selectedMarket, start, end);

  const workbook = XLSX.utils.book_new();

  const inputsRows: Array<Array<string | number>> = [
    ["Input", "Value"],
    ["Site Load (MW)", scenario.siteLoadMw],
    ["Curtail Strike ($/MWh)", scenario.curtailStrikeUsdPerMWh],
    ["Sell-Back Strike ($/MWh)", scenario.sellBackStrikeUsdPerMWh],
    ["ERS Offset (¢/kWh)", Number((scenario.ersOffsetUsdPerKWh * 100).toFixed(6))],
    ["Year Filter", selectedYear],
    ["Market Filter", selectedMarket],
    ["Retail Consulting Adder (¢/kWh)", 0],
    ["Other Market Pass-Throughs (¢/kWh)", Number((billAdderModel.marketPassThroughUsdPerKWh * 100).toFixed(6))],
    ["Effective Tax Rate", billAdderModel.taxRate],
    [
      "Legacy 2024 Delivered Adder (¢/kWh)",
      Number(
        (
          (billAdderModel.fixedRetailAdderUsdPerKWh +
            billAdderModel.marketPassThroughUsdPerKWh +
            billAdderModel.tdspUsdPerKWh +
            billAdderModel.taxesUsdPerKWh) *
          100
        ).toFixed(6)
      )
    ],
    ["Generated At", new Date().toISOString()]
  ];
  const inputsSheet = XLSX.utils.aoa_to_sheet(inputsRows);
  inputsSheet["!cols"] = [{ wch: 34 }, { wch: 18 }];

  const summaryRows: Array<Array<string | number>> = [
    ["Summary Metric", "Formula Result"],
    ["Total Modeled Hours", ""],
    ["Compute Hours", ""],
    ["Mining Uptime", ""],
    ["4CP Eligibility Share", ""],
    ["Modern Delivered Adder After 4CP (¢/kWh)", ""],
    ["4CP Credit (¢/kWh)", ""],
    ["Compute MWh", ""],
    ["Sell-Back Revenue ($)", ""],
    ["Gross All-In Mining Cost ($)", ""],
    ["ERS Credit ($)", ""],
    ["Net All-In Mining Cost ($)", ""],
    ["Gross All-In Rate ($/kWh)", ""],
    ["Net All-In Rate ($/kWh)", ""],
    ["Curtailed Exposure Avoided ($)", ""],
    ["Sell-Back Hours", ""]
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!cols"] = [{ wch: 38 }, { wch: 18 }];

  const intervalsHeaders = [
    "Interval Start",
    "Year",
    "Market",
    "Settlement Point",
    "Source",
    "Price ($/MWh)",
    "Hours",
    "Included",
    "4CP Managed",
    "Status",
    "Interval MWh",
    "Compute MWh",
    "Curtail MWh",
    "Sell-Back MWh",
    "Market Cost ($)",
    "Sell-Back Revenue ($)",
    "Delivered Adder (¢/kWh)",
    "Delivered Adder ($/MWh)",
    "All-In Compute Cost ($)",
    "ERS Credit ($)",
    "Curtailed Exposure ($)",
    "Net Mining Impact ($)"
  ];
  const intervalRows: Array<Array<string | number>> = [intervalsHeaders];
  filteredHistory.forEach((point) => {
    intervalRows.push([
      point.intervalStart,
      new Date(point.intervalStart).getUTCFullYear(),
      point.market,
      point.settlementPoint,
      point.source,
      point.priceUsdPerMWh,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      ""
    ]);
  });
  const intervalsSheet = XLSX.utils.aoa_to_sheet(intervalRows);
  intervalsSheet["!cols"] = [
    { wch: 24 }, { wch: 8 }, { wch: 8 }, { wch: 18 }, { wch: 42 }, { wch: 14 }, { wch: 10 }, { wch: 10 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 18 },
    { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 16 }, { wch: 20 }, { wch: 18 }
  ];

  const lastIntervalRow = filteredHistory.length + 1;
  const range = (column: string) => `Intervals!$${column}$2:$${column}$${lastIntervalRow}`;
  const setFormula = (sheet: XLSX.WorkSheet, address: string, formula: string, type: "n" | "s" = "n") => {
    sheet[address] = { t: type, f: formula };
  };

  setFormula(summarySheet, "B2", `SUMPRODUCT(${range("G")},${range("H")})`);
  setFormula(summarySheet, "B3", `SUMIFS(${range("G")},${range("J")},"compute",${range("H")},1)`);
  setFormula(summarySheet, "B4", "IF(B2=0,0,B3/B2)");
  setFormula(summarySheet, "B5", `IF(B2=0,0,SUMPRODUCT(${range("G")},${range("H")},${range("I")})/B2)`);
  setFormula(
    summarySheet,
    "B6",
    "((((2.15+164.56+(Inputs!$B$2*1000)*(4.899+2.337481+0.350849+0.188063-0.010529+0.043582+0.2275))+((2.15+164.56+(Inputs!$B$2*1000)*4.899)*0.00238))+(((Inputs!$B$2*1000)*730*MAX(B4,0.01))*(0.000502+(Inputs!$B$8/100)+(Inputs!$B$9/100))))*(1+Inputs!$B$10))/(((Inputs!$B$2*1000)*730*MAX(B4,0.01))))*100"
  );
  setFormula(summarySheet, "B7", `=(((Inputs!$B$2*1000)*4.966423*B5)*(1+Inputs!$B$10)/((Inputs!$B$2*1000)*730*MAX(B4,0.01)))*100`.slice(1));
  setFormula(summarySheet, "B8", `SUM(${range("L")})`);
  setFormula(summarySheet, "B9", `SUM(${range("P")})`);
  setFormula(summarySheet, "B10", `SUM(${range("S")})`);
  setFormula(summarySheet, "B11", `SUM(${range("T")})`);
  setFormula(summarySheet, "B12", "B10-B9-B11");
  setFormula(summarySheet, "B13", "IF(B8=0,0,B10/(B8*1000))");
  setFormula(summarySheet, "B14", "IF(B8=0,0,B12/(B8*1000))");
  setFormula(summarySheet, "B15", `SUM(${range("U")})`);
  setFormula(summarySheet, "B16", `SUMIFS(${range("G")},${range("J")},"sell_back",${range("H")},1)`);

  for (let row = 2; row <= lastIntervalRow; row += 1) {
    setFormula(intervalsSheet, `G${row}`, `IF(C${row}="RTM",5/60,1)`);
    setFormula(intervalsSheet, `H${row}`, `--(AND(OR(Inputs!$B$6="all",B${row}=Inputs!$B$6),OR(Inputs!$B$7="all",C${row}=Inputs!$B$7)))`);
    setFormula(intervalsSheet, `I${row}`, `--(B${row}<>2024)`);
    setFormula(intervalsSheet, `J${row}`, `IF(H${row}=0,"excluded",IF(F${row}>=Inputs!$B$4,"sell_back",IF(F${row}>=Inputs!$B$3,"curtail","compute")))`, "s");
    setFormula(intervalsSheet, `K${row}`, `Inputs!$B$2*G${row}*H${row}`);
    setFormula(intervalsSheet, `L${row}`, `IF(J${row}="compute",K${row},0)`);
    setFormula(intervalsSheet, `M${row}`, `IF(J${row}="curtail",K${row},0)`);
    setFormula(intervalsSheet, `N${row}`, `IF(J${row}="sell_back",K${row},0)`);
    setFormula(intervalsSheet, `O${row}`, `IF(J${row}="compute",F${row}*L${row},0)`);
    setFormula(intervalsSheet, `P${row}`, `IF(J${row}="sell_back",F${row}*N${row},0)`);
    setFormula(intervalsSheet, `Q${row}`, `IF(B${row}=2024,Inputs!$B$11,Summary!$B$6)`);
    setFormula(intervalsSheet, `R${row}`, `Q${row}*10`);
    setFormula(intervalsSheet, `S${row}`, `IF(J${row}="compute",(F${row}+R${row})*L${row},0)`);
    setFormula(intervalsSheet, `T${row}`, `IF(J${row}="compute",(Inputs!$B$5/100)*L${row}*1000,0)`);
    setFormula(intervalsSheet, `U${row}`, `IF(J${row}="curtail",F${row}*M${row},0)`);
    setFormula(intervalsSheet, `V${row}`, `IF(J${row}="compute",-S${row}+T${row},IF(J${row}="sell_back",P${row},0))`);
  }

  const notesRows: Array<Array<string | number>> = [
    ["Clutch Mining Excel Export"],
    ["Use the Inputs tab to edit strike levels, ERS offset, year filter, and market filter."],
    ["Summary recalculates from the Intervals tab using Excel formulas."],
    ["Intervals contains one row per ERCOT price interval with formula-driven status and economics."],
    ["Save the workbook as your scenario base before sharing or making structural edits."]
  ];
  const notesSheet = XLSX.utils.aoa_to_sheet(notesRows);
  notesSheet["!cols"] = [{ wch: 100 }];

  XLSX.utils.book_append_sheet(workbook, inputsSheet, "Inputs");
  XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");
  XLSX.utils.book_append_sheet(workbook, intervalsSheet, "Intervals");
  XLSX.utils.book_append_sheet(workbook, notesSheet, "Notes");
  workbook.Workbook = { CalcPr: { fullCalcOnLoad: true } };

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function buildExportCsv(
  history: PricePoint[],
  scenario: ExportScenario,
  selectedYear: string,
  selectedMarket: string,
  mode: "model" | "flat",
  start?: string,
  end?: string
) {
  const filteredHistory = filterHistory(history, selectedYear, selectedMarket, start, end);
  const summary = summarizeHistory(filteredHistory, scenario);
  const miningUptimePct = summary.totalHours === 0 ? 0 : (summary.computeHours / summary.totalHours) * 100;
  const modernYearShare = averageHours(filteredHistory, scenario, (item) => !item.intervalStart.startsWith("2024"));
  const fourCpEligibilityShare = averageHours(filteredHistory, scenario, (item) => !item.intervalStart.startsWith("2024"));
  const modernAdderModel = calculateModernAdderModel(scenario.siteLoadMw, miningUptimePct, fourCpEligibilityShare);
  const legacyDeliveredAdderUsdPerKWh =
    billAdderModel.fixedRetailAdderUsdPerKWh +
    billAdderModel.marketPassThroughUsdPerKWh +
    billAdderModel.tdspUsdPerKWh +
    billAdderModel.taxesUsdPerKWh;

  if (mode === "flat") {
    const rows: Array<Array<string | number>> = [[
      "interval_start",
      "market",
      "settlement_point",
      "price_usd_per_mwh",
      "interval_hours",
      "status",
      "interval_mwh",
      "delivered_adder_usd_per_kwh",
      "delivered_adder_usd_per_mwh",
      "all_in_compute_cost_usd",
      "sell_back_revenue_usd",
      "ers_credit_usd",
      "curtailed_exposure_usd",
      "net_mining_impact_usd"
    ]];

    for (const point of filteredHistory) {
      const status = deriveStatus(point, scenario);
      const intervalHours = getIntervalHours(point);
      const intervalMWh = scenario.siteLoadMw * intervalHours;
      const deliveredAdderUsdPerKWh = point.intervalStart.startsWith("2024")
        ? legacyDeliveredAdderUsdPerKWh
        : modernAdderModel.deliveredAdderAfterFourCpUsdPerKWh;
      const deliveredAdderUsdPerMWh = deliveredAdderUsdPerKWh * 1000;
      const allInComputeCostUsd = status === "compute" ? (point.priceUsdPerMWh + deliveredAdderUsdPerMWh) * intervalMWh : 0;
      const sellBackRevenueUsd = status === "sell_back" ? point.priceUsdPerMWh * intervalMWh : 0;
      const ersCreditUsd = status === "compute" ? scenario.ersOffsetUsdPerKWh * intervalMWh * 1000 : 0;
      const curtailedExposureUsd = status === "curtail" ? point.priceUsdPerMWh * intervalMWh : 0;
      const netMiningImpactUsd = status === "compute" ? -allInComputeCostUsd + ersCreditUsd : status === "sell_back" ? sellBackRevenueUsd : 0;

      rows.push([
        point.intervalStart,
        point.market,
        point.settlementPoint,
        point.priceUsdPerMWh,
        intervalHours,
        status,
        intervalMWh,
        deliveredAdderUsdPerKWh,
        deliveredAdderUsdPerMWh,
        allInComputeCostUsd,
        sellBackRevenueUsd,
        ersCreditUsd,
        curtailedExposureUsd,
        netMiningImpactUsd
      ]);
    }

    return toCsv(rows);
  }

  const rows: Array<Array<string | number>> = [];
  const dataStartRow = 34;
  const dataEndRow = dataStartRow + filteredHistory.length - 1;
  const range = (column: string) => `${column}${dataStartRow}:${column}${dataEndRow}`;

  rows.push(["Clutch Mining ERCOT Dashboard Export", new Date().toISOString()]);
  rows.push(["Open this CSV in Excel. Edit only column B input cells below. Summary formulas will recalculate automatically."]);
  rows.push([]);
  rows.push(["Input", "Value"]);
  rows.push(["Site Load (MW)", scenario.siteLoadMw]);
  rows.push(["Curtail Strike ($/MWh)", scenario.curtailStrikeUsdPerMWh]);
  rows.push(["Sell-Back Strike ($/MWh)", scenario.sellBackStrikeUsdPerMWh]);
  rows.push(["ERS Offset (¢/kWh)", Number((scenario.ersOffsetUsdPerKWh * 100).toFixed(6))]);
  rows.push(["Year Filter", selectedYear]);
  rows.push(["Market Filter", selectedMarket]);
  rows.push(["Retail Consulting Adder (¢/kWh)", 0]);
  rows.push(["Other Market Pass-Throughs (¢/kWh)", Number((billAdderModel.marketPassThroughUsdPerKWh * 100).toFixed(6))]);
  rows.push(["Effective Tax Rate", billAdderModel.taxRate]);
  rows.push(["Legacy 2024 Delivered Adder (¢/kWh)", Number((legacyDeliveredAdderUsdPerKWh * 100).toFixed(6))]);
  rows.push([]);
  rows.push(["Summary Metric", "Formula Result"]);
  rows.push(["Total Modeled Hours", `=SUMPRODUCT(${range("G")},${range("H")})`]);
  rows.push(["Compute Hours", `=SUMIFS(${range("G")},${range("J")},"compute",${range("H")},1)`]);
  rows.push(["Mining Uptime", "=IF(B17=0,0,B18/B17)"]);
  rows.push(["4CP Eligibility Share", `=IF(B17=0,0,SUMPRODUCT(${range("G")},${range("H")},${range("I")})/B17)`]);
  rows.push([
    "Modern Delivered Adder After 4CP (¢/kWh)",
    "=((((2.15+164.56+($B$5*1000)*(4.899+2.337481+0.350849+0.188063-0.010529+0.043582+0.2275))+((2.15+164.56+($B$5*1000)*4.899)*0.00238))+((($B$5*1000)*730*MAX(B19,0.01))*(0.000502+($B$11/100)+($B$12/100))))*(1+$B$13))/((($B$5*1000)*730*MAX(B19,0.01))))*100"
  ]);
  rows.push(["4CP Credit (¢/kWh)", `=((($B$5*1000)*4.966423*B20)*(1+$B$13)/(($B$5*1000)*730*MAX(B19,0.01)))*100`]);
  rows.push(["Compute MWh", `=SUM(${range("L")})`]);
  rows.push(["Sell-Back Revenue ($)", `=SUM(${range("P")})`]);
  rows.push(["Gross All-In Mining Cost ($)", `=SUM(${range("S")})`]);
  rows.push(["ERS Credit ($)", `=SUM(${range("T")})`]);
  rows.push(["Net All-In Mining Cost ($)", "=B25-B24-B26"]);
  rows.push(["Gross All-In Rate ($/kWh)", "=IF(B23=0,0,B25/(B23*1000))"]);
  rows.push(["Net All-In Rate ($/kWh)", "=IF(B23=0,0,B27/(B23*1000))"]);
  rows.push(["Curtailed Exposure Avoided ($)", `=SUM(${range("U")})`]);
  rows.push(["Sell-Back Hours", `=SUMIFS(${range("G")},${range("J")},"sell_back",${range("H")},1)`]);
  rows.push([]);
  rows.push([
    "Interval Start","Year","Market","Settlement Point","Source","Price ($/MWh)","Hours","Included","4CP Managed",
    "Status","Interval MWh","Compute MWh","Curtail MWh","Sell-Back MWh","Market Cost ($)","Sell-Back Revenue ($)",
    "Delivered Adder (¢/kWh)","Delivered Adder ($/MWh)","All-In Compute Cost ($)","ERS Credit ($)","Curtailed Exposure ($)","Net Mining Impact ($)"
  ]);

  filteredHistory.forEach((point, index) => {
    const row = dataStartRow + index;
    rows.push([
      point.intervalStart,
      new Date(point.intervalStart).getUTCFullYear(),
      point.market,
      point.settlementPoint,
      point.source,
      point.priceUsdPerMWh,
      `=IF(C${row}="RTM",5/60,1)`,
      `=--(AND(OR($B$9="all",B${row}=$B$9),OR($B$10="all",C${row}=$B$10)))`,
      `=--(B${row}<>2024)`,
      `=IF(H${row}=0,"excluded",IF(F${row}>=$B$7,"sell_back",IF(F${row}>=$B$6,"curtail","compute")))`,
      `=$B$5*G${row}*H${row}`,
      `=IF(J${row}="compute",K${row},0)`,
      `=IF(J${row}="curtail",K${row},0)`,
      `=IF(J${row}="sell_back",K${row},0)`,
      `=IF(J${row}="compute",F${row}*L${row},0)`,
      `=IF(J${row}="sell_back",F${row}*N${row},0)`,
      `=IF(B${row}=2024,$B$14,$B$21)`,
      `=Q${row}*10`,
      `=IF(J${row}="compute",(F${row}+R${row})*L${row},0)`,
      `=IF(J${row}="compute",($B$8/100)*L${row}*1000,0)`,
      `=IF(J${row}="curtail",F${row}*M${row},0)`,
      `=IF(J${row}="compute",-S${row}+T${row},IF(J${row}="sell_back",P${row},0))`
    ]);
  });

  return toCsv(rows);
}

async function scrapeLiveSouthPrice(): Promise<LivePrice | null> {
  const sources = [
    {
      url: "https://www.ercot.com/content/cdr/html/real_time_spp.html",
      settlementPoint: "LZ_SOUTH",
      source: "ERCOT real_time_spp.html"
    },
    {
      url: "https://www.ercot.com/content/cdr/html/hb_lz.html",
      settlementPoint: "HB_SOUTH",
      source: "ERCOT hb_lz.html"
    }
  ];

  for (const target of sources) {
    const response = await fetch(target.url);
    if (!response.ok) {
      continue;
    }

    const html = await response.text();
    const updatedMatch = html.match(/Last Updated:\s*([^<]+)/i);
    const rowMatch = html.match(
      new RegExp(
        `<tr>\\s*<td[^>]*>\\s*${target.settlementPoint}\\s*<\\/td>\\s*<td[^>]*>\\s*([-.0-9]+)\\s*<\\/td>`,
        "i"
      )
    );
    const legacyMatch = html.match(new RegExp(`${target.settlementPoint}\\s*\\|\\s*([-0-9.]+)`, "i"));
    const parsedPrice = Number(rowMatch?.[1] ?? legacyMatch?.[1]);
    if (Number.isNaN(parsedPrice)) {
      continue;
    }

    const updatedAt = updatedMatch?.[1]?.trim() ?? new Date().toISOString();
    return {
      settlementPoint: target.settlementPoint,
      priceUsdPerMWh: parsedPrice,
      publishedAt: new Date(updatedAt).toISOString(),
      source: target.source
    };
  }

  return null;
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
  try {
    await syncMissingErcotHistory();
  } catch (error) {
    console.error("ERCOT history sync failed", error);
  }
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
  const start = typeof _req.query.start === "string" ? _req.query.start : "";
  const end = typeof _req.query.end === "string" ? _req.query.end : "";
  const startDate = start ? new Date(`${start}T00:00:00Z`) : null;
  const endDate = end ? new Date(`${end}T23:59:59Z`) : null;
  const availableYears = [...new Set(priceHistory.map((item) => item.intervalStart.slice(0, 4)))].sort();
  const filteredHistory = priceHistory.filter((item) => {
    const itemDate = new Date(item.intervalStart);
    const matchesYear = startDate || endDate ? true : year === "all" || item.intervalStart.startsWith(year);
    const matchesMarket = market === "all" || item.market === market;
    const matchesStart = !startDate || itemDate >= startDate;
    const matchesEnd = !endDate || itemDate <= endDate;
    return matchesYear && matchesMarket && matchesStart && matchesEnd;
  });
  const historyWithLive = appendLivePricePoint(filteredHistory, livePrice, market, start, end);

  res.json({
    livePrice,
    priceHistory: historyWithLive,
    strikeConfig,
    documents,
    availableYears,
    earliestIntervalStart: priceHistory[0]?.intervalStart ?? null,
    latestIntervalStart: priceHistory.at(-1)?.intervalStart ?? null
  });
});

app.get("/api/export/:mode", async (req, res) => {
  await ensureStorage();
  const priceHistory = await readJson<PricePoint[]>(pricePath);
  const savedConfig = await readJson<StrikeConfig>(configPath);

  const year = typeof req.query.year === "string" ? req.query.year : "all";
  const market = typeof req.query.market === "string" ? req.query.market : "all";
  const start = typeof req.query.start === "string" ? req.query.start : "";
  const end = typeof req.query.end === "string" ? req.query.end : "";
  const mode = req.params.mode === "flat" ? "flat" : req.params.mode === "workbook" ? "workbook" : "model";
  const scenario: ExportScenario = {
    siteLoadMw: Number(req.query.siteLoadMw ?? savedConfig.siteLoadMw),
    curtailStrikeUsdPerMWh: Number(req.query.curtailStrikeUsdPerMWh ?? savedConfig.curtailStrikeUsdPerMWh),
    sellBackStrikeUsdPerMWh: Number(req.query.sellBackStrikeUsdPerMWh ?? savedConfig.sellBackStrikeUsdPerMWh),
    ersOffsetUsdPerKWh: Number(req.query.ersOffsetUsdPerKWh ?? 0)
  };

  if (mode === "workbook") {
    const workbook = buildExportWorkbook(priceHistory, scenario, year, market, start, end);
    const fileName = `clutch-dashboard-workbook-${year}-${market}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(workbook);
    return;
  }

  const csv = buildExportCsv(priceHistory, scenario, year, market, mode, start, end);
  const fileName = `clutch-dashboard-${mode}-${year}-${market}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(csv);
});

app.post("/api/admin/sync-ercot", async (_req, res) => {
  await ensureStorage();
  const imported = await syncMissingErcotHistory(true);
  const history = await readJson<PricePoint[]>(pricePath);
  res.json({
    imported,
    totalRows: history.length,
    latestIntervalStart: history.at(-1)?.intervalStart ?? null
  });
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
  syncMissingErcotHistory(true).catch((error) => {
    console.error("Initial ERCOT history sync failed", error);
  });
  setInterval(() => {
    syncMissingErcotHistory(true).catch((error) => {
      console.error("Scheduled ERCOT history sync failed", error);
    });
  }, 60 * 60 * 1000);
  app.listen(port, host, () => {
    console.log(`Server listening on ${host}:${port}`);
  });
});
