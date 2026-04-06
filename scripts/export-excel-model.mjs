import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const dataDir = process.env.DATA_DIR ?? path.join(rootDir, "data");
const exportDir = path.join(rootDir, "exports");

const billAdderModel = {
  fixedRetailAdderUsdPerKWh: 0,
  marketPassThroughUsdPerKWh: 0.0037511601549620847,
  tdspUsdPerKWh: 0.02913,
  taxesUsdPerKWh: 0.0031956396307286517,
  taxRate: 0.06887661141804789
};

const ersModel = {
  realizedRevenueUsd: 10092.6972,
  baselineUsageKWh: 7948800,
  invoiceChargeUsdPerKWh: 0.00002106227106227106
};

const defaultErsOffsetUsdPerKWh = Math.max(
  ersModel.realizedRevenueUsd / ersModel.baselineUsageKWh - ersModel.invoiceChargeUsdPerKWh,
  0
);

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

function parseArgs(argv) {
  return argv.reduce((acc, item) => {
    const match = item.match(/^--([^=]+)=(.*)$/);
    if (!match) return acc;
    acc[match[1]] = match[2];
    return acc;
  }, {});
}

function getIntervalHours(point) {
  return point.market === "RTM" ? 5 / 60 : 1;
}

function deriveDecision(point, config) {
  const intervalHours = getIntervalHours(point);
  const estimatedValueUsd = point.priceUsdPerMWh * config.siteLoadMw * intervalHours;

  let status = "compute";
  if (point.priceUsdPerMWh >= config.sellBackStrikeUsdPerMWh) {
    status = "sell_back";
  } else if (point.priceUsdPerMWh >= config.curtailStrikeUsdPerMWh) {
    status = "curtail";
  }

  return { ...point, status, estimatedValueUsd };
}

function averageHours(decisions, predicate) {
  const matchingHours = decisions.reduce((sum, item) => sum + (predicate(item) ? getIntervalHours(item) : 0), 0);
  const totalHours = decisions.reduce((sum, item) => sum + getIntervalHours(item), 0);
  return totalHours === 0 ? 0 : matchingHours / totalHours;
}

function calculateModernAdderModel(siteLoadMw, computeUptimePct, fourCpEligibilityShare) {
  const siteLoadKw = siteLoadMw * 1000;
  const computeLoadFactor = Math.max(computeUptimePct / 100, 0.01);
  const computeKWhPerMonth = siteLoadKw * averageBillingHoursPerMonth * computeLoadFactor;
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
    computeKWhPerMonth *
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
      (pretaxModernUsdPerMonth + taxesAfterFourCpUsdPerMonth) / computeKWhPerMonth,
    fourCpCreditUsdPerKWh:
      (pretaxWithoutFourCpManagementUsdPerMonth +
        taxesBeforeFourCpUsdPerMonth -
        pretaxModernUsdPerMonth -
        taxesAfterFourCpUsdPerMonth) /
      computeKWhPerMonth
  };
}

function summarize(decisions, siteLoadMw) {
  return decisions.reduce(
    (acc, item) => {
      const intervalHours = getIntervalHours(item);
      const intervalMWh = intervalHours * siteLoadMw;
      acc.totalHours += intervalHours;

      if (item.status === "compute") {
        acc.computeHours += intervalHours;
        acc.computeMWh += intervalMWh;
        acc.computeCostUsd += item.priceUsdPerMWh * intervalMWh;
      } else if (item.status === "curtail") {
        acc.curtailedExposureUsd += item.priceUsdPerMWh * intervalMWh;
      } else {
        acc.sellBackRevenueUsd += item.priceUsdPerMWh * intervalMWh;
      }

      return acc;
    },
    {
      totalHours: 0,
      computeHours: 0,
      computeMWh: 0,
      computeCostUsd: 0,
      sellBackRevenueUsd: 0,
      curtailedExposureUsd: 0
    }
  );
}

function csvEscape(value) {
  const stringValue = value == null ? "" : String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function formulaCell(value) {
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const historyPath = path.join(dataDir, "history.json");
  const configPath = path.join(dataDir, "strike-config.json");
  const history = JSON.parse(await fs.readFile(historyPath, "utf8"));
  const strikeConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

  const selectedYear = args.year ?? "all";
  const selectedMarket = args.market ?? "all";
  const filteredHistory = history.filter((point) => {
    const year = point.intervalStart.slice(0, 4);
    const yearMatches = selectedYear === "all" || year === selectedYear;
    const marketMatches = selectedMarket === "all" || point.market === selectedMarket;
    return yearMatches && marketMatches;
  });

  const decisions = filteredHistory.map((point) => deriveDecision(point, strikeConfig));
  const summary = summarize(decisions, strikeConfig.siteLoadMw);
  const modernYearShare = averageHours(decisions, (item) => !item.intervalStart.startsWith("2024"));
  const fourCpEligibilityShare = averageHours(decisions, (item) => !item.intervalStart.startsWith("2024"));
  const modernAdderModel = calculateModernAdderModel(
    strikeConfig.siteLoadMw,
    summary.totalHours === 0 ? 0 : (summary.computeHours / summary.totalHours) * 100,
    fourCpEligibilityShare
  );
  const legacyDeliveredAdderUsdPerKWh =
    billAdderModel.fixedRetailAdderUsdPerKWh +
    billAdderModel.marketPassThroughUsdPerKWh +
    billAdderModel.tdspUsdPerKWh +
    billAdderModel.taxesUsdPerKWh;
  const deliveredAdderAfterCreditUsdPerKWh =
    legacyDeliveredAdderUsdPerKWh * (1 - modernYearShare) +
    modernAdderModel.deliveredAdderAfterFourCpUsdPerKWh * modernYearShare;
  const ersOffsetUsdPerKWh = defaultErsOffsetUsdPerKWh;

  const flatRows = [
    [
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
    ]
  ];

  for (const item of decisions) {
    const intervalHours = getIntervalHours(item);
    const intervalMWh = strikeConfig.siteLoadMw * intervalHours;
    const deliveredAdderUsdPerKWh = item.intervalStart.startsWith("2024")
      ? legacyDeliveredAdderUsdPerKWh
      : modernAdderModel.deliveredAdderAfterFourCpUsdPerKWh;
    const deliveredAdderUsdPerMWh = deliveredAdderUsdPerKWh * 1000;
    const allInComputeCostUsd = item.status === "compute" ? (item.priceUsdPerMWh + deliveredAdderUsdPerMWh) * intervalMWh : 0;
    const sellBackRevenueUsd = item.status === "sell_back" ? item.priceUsdPerMWh * intervalMWh : 0;
    const ersCreditUsd = item.status === "compute" ? ersOffsetUsdPerKWh * intervalMWh * 1000 : 0;
    const curtailedExposureUsd = item.status === "curtail" ? item.priceUsdPerMWh * intervalMWh : 0;
    const netMiningImpactUsd =
      item.status === "compute" ? -allInComputeCostUsd + ersCreditUsd : item.status === "sell_back" ? sellBackRevenueUsd : 0;

    flatRows.push([
      item.intervalStart,
      item.market,
      item.settlementPoint,
      item.priceUsdPerMWh,
      intervalHours,
      item.status,
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

  const rows = [];
  rows.push(["Clutch Mining ERCOT Dashboard Export", new Date().toISOString()]);
  rows.push(["Open this CSV in Excel. Edit only column B input cells below. Summary formulas will recalculate automatically."]);
  rows.push([]);
  rows.push(["Input", "Value"]);
  rows.push(["Site Load (MW)", strikeConfig.siteLoadMw]);
  rows.push(["Curtail Strike ($/MWh)", strikeConfig.curtailStrikeUsdPerMWh]);
  rows.push(["Sell-Back Strike ($/MWh)", strikeConfig.sellBackStrikeUsdPerMWh]);
  rows.push(["ERS Offset (¢/kWh)", Number((ersOffsetUsdPerKWh * 100).toFixed(6))]);
  rows.push(["Year Filter", selectedYear]);
  rows.push(["Market Filter", selectedMarket]);
  rows.push(["Retail Consulting Adder (¢/kWh)", 0]);
  rows.push(["Other Market Pass-Throughs (¢/kWh)", Number((billAdderModel.marketPassThroughUsdPerKWh * 100).toFixed(6))]);
  rows.push(["Effective Tax Rate", billAdderModel.taxRate]);
  rows.push(["Legacy 2024 Delivered Adder (¢/kWh)", Number((legacyDeliveredAdderUsdPerKWh * 100).toFixed(6))]);
  rows.push([]);
  rows.push(["Summary Metric", "Formula Result"]);

  const dataHeaderRow = 33;
  const dataStartRow = 34;
  const dataEndRow = dataStartRow + filteredHistory.length - 1;
  const range = (column) => `${column}${dataStartRow}:${column}${dataEndRow}`;

  rows.push(["Total Modeled Hours", formulaCell(`=SUMPRODUCT(${range("G")},${range("H")})`)]);
  rows.push(["Compute Hours", formulaCell(`=SUMIFS(${range("G")},${range("J")},"compute",${range("H")},1)`)]);
  rows.push(["Mining Uptime", formulaCell("=IF(B17=0,0,B18/B17)")]);
  rows.push(["4CP Eligibility Share", formulaCell(`=IF(B17=0,0,SUMPRODUCT(${range("G")},${range("H")},${range("I")})/B17)`)]);
  rows.push([
    "Modern Delivered Adder After 4CP (¢/kWh)",
    formulaCell(
      "=((((2.15+164.56+($B$5*1000)*(4.899+2.337481+0.350849+0.188063-0.010529+0.043582+0.2275))+((2.15+164.56+($B$5*1000)*4.899)*0.00238))+((($B$5*1000)*730*MAX(B19,0.01))*(0.000502+($B$11/100)+($B$12/100))))*(1+$B$13))/((($B$5*1000)*730*MAX(B19,0.01))))*100"
    )
  ]);
  rows.push([
    "4CP Credit (¢/kWh)",
    formulaCell(`=((($B$5*1000)*4.966423*B20)*(1+$B$13)/(($B$5*1000)*730*MAX(B19,0.01)))*100`)
  ]);
  rows.push(["Compute MWh", formulaCell(`=SUM(${range("L")})`)]);
  rows.push(["Sell-Back Revenue ($)", formulaCell(`=SUM(${range("P")})`)]);
  rows.push(["Gross All-In Mining Cost ($)", formulaCell(`=SUM(${range("S")})`)]);
  rows.push(["ERS Credit ($)", formulaCell(`=SUM(${range("T")})`)]);
  rows.push(["Net All-In Mining Cost ($)", formulaCell("=B25-B24-B26")]);
  rows.push(["Gross All-In Rate ($/kWh)", formulaCell("=IF(B23=0,0,B25/(B23*1000))")]);
  rows.push(["Net All-In Rate ($/kWh)", formulaCell("=IF(B23=0,0,B27/(B23*1000))")]);
  rows.push(["Curtailed Exposure Avoided ($)", formulaCell(`=SUM(${range("U")})`)]);
  rows.push(["Sell-Back Hours", formulaCell(`=SUMIFS(${range("G")},${range("J")},"sell_back",${range("H")},1)`)]);
  rows.push([]);
  rows.push([
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
      formulaCell(`=IF(C${row}="RTM",5/60,1)`),
      formulaCell(`=--(AND(OR($B$9="all",B${row}=$B$9),OR($B$10="all",C${row}=$B$10)))`),
      formulaCell(`=--(B${row}<>2024)`),
      formulaCell(`=IF(H${row}=0,"excluded",IF(F${row}>=$B$7,"sell_back",IF(F${row}>=$B$6,"curtail","compute")))`),
      formulaCell(`=$B$5*G${row}*H${row}`),
      formulaCell(`=IF(J${row}="compute",K${row},0)`),
      formulaCell(`=IF(J${row}="curtail",K${row},0)`),
      formulaCell(`=IF(J${row}="sell_back",K${row},0)`),
      formulaCell(`=IF(J${row}="compute",F${row}*L${row},0)`),
      formulaCell(`=IF(J${row}="sell_back",F${row}*N${row},0)`),
      formulaCell(`=IF(B${row}=2024,$B$14,$B$21)`),
      formulaCell(`=Q${row}*10`),
      formulaCell(`=IF(J${row}="compute",(F${row}+R${row})*L${row},0)`),
      formulaCell(`=IF(J${row}="compute",($B$8/100)*L${row}*1000,0)`),
      formulaCell(`=IF(J${row}="curtail",F${row}*M${row},0)`),
      formulaCell(`=IF(J${row}="compute",-S${row}+T${row},IF(J${row}="sell_back",P${row},0))`)
    ]);
  });

  await fs.mkdir(exportDir, { recursive: true });
  await fs.writeFile(path.join(exportDir, "dashboard-intervals-flat.csv"), toCsv(flatRows));
  await fs.writeFile(path.join(exportDir, "dashboard-excel-model.csv"), toCsv(rows));
  await fs.writeFile(
    path.join(exportDir, "dashboard-export-notes.txt"),
    [
      "Files generated:",
      "- dashboard-intervals-flat.csv: current scenario export from the app assumptions",
      "- dashboard-excel-model.csv: Excel-ready sheet with editable inputs in column B and formulas below",
      "",
      "Recommended workflow:",
      "1. Open dashboard-excel-model.csv in Microsoft Excel.",
      "2. Edit cells B5:B10 to test site load, curtail strike, sell-back strike, ERS offset, year filter, and market filter.",
      "3. Read the summary block in rows 17:31 for uptime, sell-back revenue, and all-in $/kWh.",
      "4. Use dashboard-intervals-flat.csv if you want a clean pivot-table source.",
      "",
      `Rows exported: ${filteredHistory.length}`
    ].join("\n")
  );

  console.log(`Exported ${filteredHistory.length} rows to ${exportDir}`);
  console.log(`Delivered adder after credit in current scenario: ${(deliveredAdderAfterCreditUsdPerKWh * 100).toFixed(2)} cents/kWh`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
