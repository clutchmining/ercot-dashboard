import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";

const rootDir = process.cwd();
const dataDir = path.join(rootDir, "data");
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

function setFormula(sheet, address, formula, type = "n") {
  sheet[address] = { t: type, f: formula };
}

function setNumberFormat(sheet, cell, format) {
  if (sheet[cell]) {
    sheet[cell].z = format;
  }
}

async function main() {
  const history = JSON.parse(await fs.readFile(path.join(dataDir, "history.json"), "utf8"));
  const frameworkYear = "2026";
  const frameworkHistory = history.filter((point) => point.intervalStart.startsWith(`${frameworkYear}-`));
  const strikeConfig = JSON.parse(await fs.readFile(path.join(dataDir, "strike-config.json"), "utf8"));
  const workbook = XLSX.utils.book_new();

  const inputsRows = [
    ["Clutch Mining ERCOT Workbook Framework", ""],
    ["", ""],
    ["Input", "Value", "Notes"],
    ["Site Load (MW)", strikeConfig.siteLoadMw, "Editable operating load assumption"],
    ["Curtail Strike ($/MWh)", strikeConfig.curtailStrikeUsdPerMWh, "Price at which mining curtails"],
    ["Sell-Back Strike ($/MWh)", strikeConfig.sellBackStrikeUsdPerMWh, "Price at which mining is modeled as sell-back"],
    ["ERS Offset (¢/kWh)", Number((defaultErsOffsetUsdPerKWh * 100).toFixed(6)), "Net ERS credit assumption"],
    ["Year Filter", frameworkYear, "Framework seed uses 2026 YTD power data"],
    ["Market Filter", "All", "Valid values: All, RTM, DAM"],
    ["Manual Live Price ($/MWh)", "", "Optional placeholder for a live dashboard readout"],
    ["", "", ""],
    ["Workbook Usage", "", ""],
    ["1", "Edit only column B input cells above", ""],
    ["2", "Summary tab mirrors the dashboard outputs", ""],
    ["3", "Power_Data tab contains the interval-level economics", ""]
  ];
  const inputsSheet = XLSX.utils.aoa_to_sheet(inputsRows);
  inputsSheet["!cols"] = [{ wch: 28 }, { wch: 18 }, { wch: 44 }];
  inputsSheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];

  const assumptionsRows = [
    ["Assumption", "Value", "Units", "Source / Purpose"],
    ["Retail consulting adder", billAdderModel.fixedRetailAdderUsdPerKWh * 100, "¢/kWh", "Assumed zero going forward"],
    ["Other market pass-throughs", billAdderModel.marketPassThroughUsdPerKWh * 100, "¢/kWh", "2025-2026 forward calibration"],
    ["Legacy 2024 delivered adder", (billAdderModel.fixedRetailAdderUsdPerKWh + billAdderModel.marketPassThroughUsdPerKWh + billAdderModel.tdspUsdPerKWh + billAdderModel.taxesUsdPerKWh) * 100, "¢/kWh", "Used only for 2024 intervals"],
    ["Tax rate", billAdderModel.taxRate, "decimal", "Applied to modeled pretax delivery and pass-throughs"],
    ["EECRF", aepPrimaryDeliveryTariff.eecrfUsdPerKWh * 100, "¢/kWh", "AEP primary tariff component"],
    ["Customer charge", aepPrimaryDeliveryTariff.customerChargeUsdPerMonth, "$/month", "AEP primary tariff component"],
    ["Meter charge", aepPrimaryDeliveryTariff.meterChargeUsdPerMonth, "$/month", "AEP primary tariff component"],
    ["Distribution system", aepPrimaryDeliveryTariff.distributionSystemUsdPerKwMonth, "$/kW-month", "AEP primary tariff component"],
    ["TCRF NCP", aepPrimaryDeliveryTariff.tcrfNcpUsdPerKwMonth, "$/kW-month", "AEP primary tariff component"],
    ["TCRF 4CP", aepPrimaryDeliveryTariff.tcrf4cpUsdPerKwMonth, "$/kW-month", "AEP primary tariff component"],
    ["DCRF", aepPrimaryDeliveryTariff.dcrfUsdPerKwMonth, "$/kW-month", "AEP primary tariff component"],
    ["SRC", aepPrimaryDeliveryTariff.srcUsdPerKwMonth, "$/kW-month", "AEP primary tariff component"],
    ["ADFIT", aepPrimaryDeliveryTariff.adfitUsdPerKwMonth, "$/kW-month", "AEP primary tariff component"],
    ["RAR", aepPrimaryDeliveryTariff.rarUsdPerKwMonth, "$/kW-month", "AEP primary tariff component"],
    ["Mobile TEEE", aepPrimaryDeliveryTariff.mobileTeeeUsdPerKwMonth, "$/kW-month", "AEP primary tariff component"],
    ["RCE factor", aepPrimaryDeliveryTariff.rceBaseRevenueFactor, "decimal", "AEP primary tariff component"],
    ["Average billing hours", 730, "hours/month", "Used in current dashboard model"],
    ["Default ERS offset", defaultErsOffsetUsdPerKWh * 100, "¢/kWh", "ERS revenue net of ERS bill charges"]
  ];
  const assumptionsSheet = XLSX.utils.aoa_to_sheet(assumptionsRows);
  assumptionsSheet["!cols"] = [{ wch: 24 }, { wch: 18 }, { wch: 14 }, { wch: 36 }];

  const summaryRows = [
    ["Clutch Mining ERCOT Dashboard Summary", ""],
    ["", ""],
    ["Scenario", "Value"],
    ["Site Load (MW)", ""],
    ["Curtail Strike ($/MWh)", ""],
    ["Sell-Back Strike ($/MWh)", ""],
    ["ERS Offset (¢/kWh)", ""],
    ["Year Filter", ""],
    ["Market Filter", ""],
    ["Coverage Start", ""],
    ["Coverage End", ""],
    ["", ""],
    ["Primary KPIs", "Value"],
    ["Total Modeled Hours", ""],
    ["Mining Uptime", ""],
    ["Compute MWh", ""],
    ["Gross All-In Mining Cost ($)", ""],
    ["Sell-Back Revenue ($)", ""],
    ["ERS Credit ($)", ""],
    ["Net All-In Mining Cost ($)", ""],
    ["Gross All-In Rate ($/kWh)", ""],
    ["Net All-In Rate ($/kWh)", ""],
    ["Hours Sold Back", ""],
    ["Curtailed Exposure Avoided ($)", ""],
    ["Best Sell-Back Interval ($)", ""],
    ["Best Sell-Back Timestamp", ""],
    ["", ""],
    ["Rate Stack", "Value"],
    ["Delivered Adders (¢/kWh)", ""],
    ["4CP Credit (¢/kWh)", ""],
    ["Retail consulting adder (¢/kWh)", ""],
    ["Other market pass-throughs + EECRF (¢/kWh)", ""],
    ["TDSP / delivery at current load (¢/kWh)", ""],
    ["Taxes and PUC (¢/kWh)", ""],
    ["Manual Live Price ($/MWh)", ""],
    ["Manual Live All-In ($/kWh)", ""]
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!cols"] = [{ wch: 34 }, { wch: 22 }];
  summarySheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];

  const headers = [
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
  const powerRows = [headers];
  for (const point of frameworkHistory) {
    powerRows.push([
      point.intervalStart,
      Number(point.intervalStart.slice(0, 4)),
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
  }
  const powerSheet = XLSX.utils.aoa_to_sheet(powerRows);
  powerSheet["!cols"] = [
    { wch: 24 }, { wch: 8 }, { wch: 8 }, { wch: 18 }, { wch: 42 }, { wch: 14 }, { wch: 10 }, { wch: 10 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 18 },
    { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 16 }, { wch: 20 }, { wch: 18 }
  ];

  const notesRows = [
    ["Notes"],
    ["This workbook is a framework version intended to mirror the dashboard at a finance-friendly level."],
    ["Inputs tab is the only place users should edit assumptions directly."],
    ["Summary tab is the front page for presentation and quick scenario review."],
    [`Power_Data contains the ${frameworkYear} YTD interval set and row-level formulas.`],
    ["Assumptions documents the delivery and adder model currently used in the dashboard."],
    ["API and auto-refresh can be connected later without changing the workbook structure."]
  ];
  const notesSheet = XLSX.utils.aoa_to_sheet(notesRows);
  notesSheet["!cols"] = [{ wch: 110 }];

  const lastRow = frameworkHistory.length + 1;
  const range = (col) => `Power_Data!$${col}$2:$${col}$${lastRow}`;

  setFormula(summarySheet, "B4", "Inputs!B4");
  setFormula(summarySheet, "B5", "Inputs!B5");
  setFormula(summarySheet, "B6", "Inputs!B6");
  setFormula(summarySheet, "B7", "Inputs!B7");
  setFormula(summarySheet, "B8", "Inputs!B8", "s");
  setFormula(summarySheet, "B9", "Inputs!B9", "s");
  setFormula(summarySheet, "B10", `IFERROR(MINIFS(${range("A")},${range("H")},1),"")`, "s");
  setFormula(summarySheet, "B11", `IFERROR(MAXIFS(${range("A")},${range("H")},1),"")`, "s");
  setFormula(summarySheet, "B14", `SUMPRODUCT(${range("G")},${range("H")})`);
  setFormula(summarySheet, "B15", `IF(B14=0,0,SUMIFS(${range("G")},${range("J")},"compute",${range("H")},1)/B14)`);
  setFormula(summarySheet, "B16", `SUM(${range("L")})`);
  setFormula(summarySheet, "B17", `SUM(${range("S")})`);
  setFormula(summarySheet, "B18", `SUM(${range("P")})`);
  setFormula(summarySheet, "B19", `SUM(${range("T")})`);
  setFormula(summarySheet, "B20", `B17-B18-B19`);
  setFormula(summarySheet, "B21", `IF(B16=0,0,B17/(B16*1000))`);
  setFormula(summarySheet, "B22", `IF(B16=0,0,B20/(B16*1000))`);
  setFormula(summarySheet, "B23", `SUMIFS(${range("G")},${range("J")},"sell_back",${range("H")},1)`);
  setFormula(summarySheet, "B24", `SUM(${range("U")})`);
  setFormula(summarySheet, "B25", `IFERROR(MAX(${range("P")}),0)`);
  setFormula(summarySheet, "B26", `IFERROR(INDEX(${range("A")},MATCH(B25,${range("P")},0)),"")`, "s");

  setFormula(summarySheet, "B29", `((1-B30/100)*Assumptions!B4)+(B30/100*B31/100)`);
  setFormula(summarySheet, "B30", `IF(B14=0,0,SUMPRODUCT(${range("G")},${range("H")},${range("I")})/B14*100)`);
  setFormula(
    summarySheet,
    "B31",
    "((((Assumptions!B7+Assumptions!B8+(Inputs!B4*1000)*(Assumptions!B9+Assumptions!B10+Assumptions!B12+Assumptions!B13+Assumptions!B14+Assumptions!B15+Assumptions!B16))+((Assumptions!B7+Assumptions!B8+(Inputs!B4*1000)*Assumptions!B9)*Assumptions!B17))+(((Inputs!B4*1000)*Assumptions!B18*MAX(B15,0.01))*((Assumptions!B6/100)+(Assumptions!B2/100)+(Assumptions!B3/100))))*(1+Assumptions!B5))/(((Inputs!B4*1000)*Assumptions!B18*MAX(B15,0.01))))*100"
  );
  setFormula(summarySheet, "B32", `(((Inputs!B4*1000)*Assumptions!B11*(B30/100))*(1+Assumptions!B5)/((Inputs!B4*1000)*Assumptions!B18*MAX(B15,0.01)))*100`);
  setFormula(summarySheet, "B33", "Assumptions!B2");
  setFormula(summarySheet, "B34", "Assumptions!B3+Assumptions!B6");
  setFormula(
    summarySheet,
    "B35",
    "((((Assumptions!B7+Assumptions!B8+(Inputs!B4*1000)*(Assumptions!B9+Assumptions!B10+Assumptions!B12+Assumptions!B13+Assumptions!B14+Assumptions!B15+Assumptions!B16))+((Assumptions!B7+Assumptions!B8+(Inputs!B4*1000)*Assumptions!B9)*Assumptions!B17))/((Inputs!B4*1000)*Assumptions!B18*MAX(B15,0.01)))*100"
  );
  setFormula(
    summarySheet,
    "B36",
    "((((Assumptions!B7+Assumptions!B8+(Inputs!B4*1000)*(Assumptions!B9+Assumptions!B10+Assumptions!B12+Assumptions!B13+Assumptions!B14+Assumptions!B15+Assumptions!B16))+((Assumptions!B7+Assumptions!B8+(Inputs!B4*1000)*Assumptions!B9)*Assumptions!B17))*Assumptions!B5)/((Inputs!B4*1000)*Assumptions!B18*MAX(B15,0.01))*100"
  );
  setFormula(summarySheet, "B37", "Inputs!B10");
  setFormula(summarySheet, "B38", `IF(B37="", "", B37/1000 + B29/100 - Inputs!B7/100)`);

  for (let row = 2; row <= lastRow; row += 1) {
    setFormula(powerSheet, `G${row}`, `IF(C${row}="RTM",5/60,1)`);
    setFormula(powerSheet, `H${row}`, `--(AND(OR(Inputs!$B$8="All",TEXT(A${row},"yyyy")=Inputs!$B$8),OR(Inputs!$B$9="All",C${row}=Inputs!$B$9)))`);
    setFormula(powerSheet, `I${row}`, `--(B${row}<>2024)`);
    setFormula(powerSheet, `J${row}`, `IF(H${row}=0,"excluded",IF(F${row}>=Inputs!$B$6,"sell_back",IF(F${row}>=Inputs!$B$5,"curtail","compute")))`, "s");
    setFormula(powerSheet, `K${row}`, `Inputs!$B$4*G${row}*H${row}`);
    setFormula(powerSheet, `L${row}`, `IF(J${row}="compute",K${row},0)`);
    setFormula(powerSheet, `M${row}`, `IF(J${row}="curtail",K${row},0)`);
    setFormula(powerSheet, `N${row}`, `IF(J${row}="sell_back",K${row},0)`);
    setFormula(powerSheet, `O${row}`, `IF(J${row}="compute",F${row}*L${row},0)`);
    setFormula(powerSheet, `P${row}`, `IF(J${row}="sell_back",F${row}*N${row},0)`);
    setFormula(powerSheet, `Q${row}`, `IF(B${row}=2024,Assumptions!$B$4,Summary!$B$31)`);
    setFormula(powerSheet, `R${row}`, `Q${row}*10`);
    setFormula(powerSheet, `S${row}`, `IF(J${row}="compute",(F${row}+R${row})*L${row},0)`);
    setFormula(powerSheet, `T${row}`, `IF(J${row}="compute",(Inputs!$B$7/100)*L${row}*1000,0)`);
    setFormula(powerSheet, `U${row}`, `IF(J${row}="curtail",F${row}*M${row},0)`);
    setFormula(powerSheet, `V${row}`, `IF(J${row}="compute",-S${row}+T${row},IF(J${row}="sell_back",P${row},0))`);
  }

  summarySheet["!autofilter"] = { ref: "A13:B38" };
  powerSheet["!autofilter"] = { ref: `A1:V${lastRow}` };

  XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");
  XLSX.utils.book_append_sheet(workbook, inputsSheet, "Inputs");
  XLSX.utils.book_append_sheet(workbook, assumptionsSheet, "Assumptions");
  XLSX.utils.book_append_sheet(workbook, powerSheet, "Power_Data");
  XLSX.utils.book_append_sheet(workbook, notesSheet, "Notes");
  workbook.Workbook = { CalcPr: { fullCalcOnLoad: true } };

  await fs.mkdir(exportDir, { recursive: true });
  const outputPath = path.join(exportDir, `Clutch_Mining_Dashboard_Framework_${frameworkYear}.xlsx`);
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  await fs.writeFile(outputPath, buffer);
  console.log(outputPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
