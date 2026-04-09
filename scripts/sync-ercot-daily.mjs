import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const dataDir = process.env.DATA_DIR ?? path.join(rootDir, "data");
const pricePath = path.join(dataDir, "history.json");

function stripTags(value) {
  return value.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
}

function extractTableRows(html) {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) {
    return [];
  }

  return Array.from(tableMatch[0].matchAll(/<tr[\s\S]*?>([\s\S]*?)<\/tr>/gi)).map(([, rowHtml]) =>
    Array.from(rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)).map(([, cellHtml]) => stripTags(cellHtml))
  );
}

function buildUtcLikeTimestamp(dateText, endingText, market) {
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
    const startMinutes = endingHour * 60 + endingMinute - 15;
    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), Math.floor(startMinutes / 60), startMinutes % 60, 0)
    ).toISOString();
  }

  const hourEnding = Number(String(endingText).trim());
  if (Number.isNaN(hourEnding)) {
    return null;
  }

  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hourEnding - 1, 0, 0)).toISOString();
}

function parseSettlementPointDailyPage(html, market, source) {
  const rows = extractTableRows(html);
  if (rows.length < 2) {
    return [];
  }

  const header = rows[0];
  const settlementIndex = header.findIndex((value) => value === "LZ_SOUTH");
  const dateIndex = header.findIndex((value) => value === "Oper Day");
  const endingIndex = header.findIndex((value) => value === "Interval Ending" || value === "Hour Ending");
  if (settlementIndex < 0 || dateIndex < 0 || endingIndex < 0) {
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
      };
    })
    .filter(Boolean);
}

function formatErcotDay(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

async function fetchDailySettlementPoints(day, market) {
  const token = formatErcotDay(day);
  const pageName = market === "RTM" ? "real_time_spp" : "dam_spp";
  const url = `https://www.ercot.com/content/cdr/html/${token}_${pageName}.html`;
  const response = await fetch(url);
  if (!response.ok) {
    return [];
  }
  const html = await response.text();
  return parseSettlementPointDailyPage(html, market, `${token}_${pageName}.html`);
}

function dedupePriceHistory(history) {
  const keyed = new Map();
  for (const item of history) {
    keyed.set(`${item.market}|${item.intervalStart}|${item.settlementPoint}`, item);
  }
  return [...keyed.values()].sort((a, b) => a.intervalStart.localeCompare(b.intervalStart));
}

async function main() {
  const history = JSON.parse(await fs.readFile(pricePath, "utf8"));
  const latestPoint = history.at(-1);
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

  const fetched = [];
  for (let cursor = new Date(startDay); cursor <= todayUtcDay; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = new Date(cursor);
    const [damRows, rtmRows] = await Promise.all([
      fetchDailySettlementPoints(day, "DAM"),
      fetchDailySettlementPoints(day, "RTM")
    ]);
    console.log(day.toISOString().slice(0, 10), "DAM", damRows.length, "RTM", rtmRows.length);
    fetched.push(...damRows, ...rtmRows);
  }

  const next = dedupePriceHistory([...history, ...fetched]);
  await fs.writeFile(pricePath, JSON.stringify(next, null, 2));
  console.log(`Imported ${fetched.length} rows. History now ${next.length} rows.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
