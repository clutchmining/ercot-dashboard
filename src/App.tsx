import { useEffect, useState } from "react";
import { MetricCard } from "./components/MetricCard";
import { StatusBars } from "./components/StatusBars";
import { deriveDecisions, summarizeDecisions } from "./lib/logic";
import type { DashboardPayload, StrikeConfig } from "./lib/types";
import clutchLogo from "./assets/clutch-logo-2026.png";

const emptyConfig: StrikeConfig = {
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

function isFourCpManagedInterval(intervalStart: string) {
  return !intervalStart.startsWith("2024");
}

function averageHours(
  decisions: ReturnType<typeof deriveDecisions>,
  predicate: (item: ReturnType<typeof deriveDecisions>[number]) => boolean
) {
  const matchingHours = decisions.reduce((sum, item) => {
    if (!predicate(item)) {
      return sum;
    }
    return sum + (item.market === "RTM" ? 5 / 60 : 1);
  }, 0);

  const totalHours = decisions.reduce((sum, item) => sum + (item.market === "RTM" ? 5 / 60 : 1), 0);
  return totalHours === 0 ? 0 : matchingHours / totalHours;
}

function calculateModernAdderModel(siteLoadMw: number, computeUptimePct: number, fourCpEligibilityShare: number) {
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
      computeKWhPerMonth,
    tdspDemandUsdPerKWh: demandChargesUsdPerMonth / computeKWhPerMonth,
    fixedRetailUsdPerKWh: billAdderModel.fixedRetailAdderUsdPerKWh,
    marketPassThroughUsdPerKWh: billAdderModel.marketPassThroughUsdPerKWh,
    eecrfUsdPerKWh: aepPrimaryDeliveryTariff.eecrfUsdPerKWh,
    taxesUsdPerKWh: taxesAfterFourCpUsdPerMonth / computeKWhPerMonth
  };
}

export function App() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [config, setConfig] = useState<StrikeConfig>(emptyConfig);
  const [ersOffsetUsdPerKWh, setErsOffsetUsdPerKWh] = useState(defaultErsOffsetUsdPerKWh);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [selectedYear, setSelectedYear] = useState<string>("2026");
  const [selectedMarket, setSelectedMarket] = useState<"all" | "RTM" | "DAM">("all");

  async function loadDashboard(year = selectedYear, market = selectedMarket) {
    const response = await fetch(`/api/dashboard?year=${year}&market=${market}`);
    const payload: DashboardPayload = await response.json();
    setData(payload);
    setConfig(payload.strikeConfig);
    if (year !== "all" && !payload.availableYears.includes(year)) {
      setSelectedYear(payload.availableYears.at(-1) ?? "all");
    }
  }

  useEffect(() => {
    loadDashboard().catch((error) => {
      setMessage(error instanceof Error ? error.message : "Failed to load dashboard.");
    });
  }, [selectedYear, selectedMarket]);

  const availableYears = data ? ["all", ...data.availableYears] : ["all"];
  const decisions = deriveDecisions(data?.priceHistory ?? [], config);
  const summary = summarizeDecisions(decisions, config.siteLoadMw);
  const prices = decisions.map((item) => item.priceUsdPerMWh);
  const sellBackOpportunities = decisions
    .filter((item) => item.status === "sell_back")
    .sort((a, b) => b.priceUsdPerMWh - a.priceUsdPerMWh)
    .slice(0, 8);
  const dateRange =
    decisions.length === 0
      ? "No imported history"
      : `${new Date(decisions[0].intervalStart).toLocaleDateString()} - ${new Date(
          decisions[decisions.length - 1].intervalStart
        ).toLocaleDateString()}`;
  const modernYearShare = averageHours(decisions, (item) => !item.intervalStart.startsWith("2024"));
  const fourCpEligibilityShare = averageHours(decisions, (item) => isFourCpManagedInterval(item.intervalStart));
  const modernAdderModel = calculateModernAdderModel(
    config.siteLoadMw,
    summary.computeUptimePct,
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
  const weightedFourCpCreditUsdPerKWh = modernAdderModel.fourCpCreditUsdPerKWh * modernYearShare;
  const ersOffsetUsd = summary.computeMWh * 1000 * ersOffsetUsdPerKWh;
  const computeAllInCostUsd = decisions
    .filter((item) => item.status === "compute")
    .reduce((sum, item) => {
      const intervalHours = item.market === "RTM" ? 5 / 60 : 1;
      const intervalMWh = config.siteLoadMw * intervalHours;
      const intervalAdderUsdPerMWh =
        (item.intervalStart.startsWith("2024")
          ? legacyDeliveredAdderUsdPerKWh
          : modernAdderModel.deliveredAdderAfterFourCpUsdPerKWh) * 1000;
      return sum + (item.priceUsdPerMWh + intervalAdderUsdPerMWh) * intervalMWh;
    }, 0);
  const allInComputeRateUsdPerKWh =
    summary.computeMWh === 0 ? 0 : (computeAllInCostUsd - ersOffsetUsd) / (summary.computeMWh * 1000);
  const netAllInMiningRateUsdPerKWh =
    summary.computeMWh === 0
      ? 0
      : (computeAllInCostUsd - summary.sellBackRevenueUsd - ersOffsetUsd) / (summary.computeMWh * 1000);
  const liveAllInRateUsdPerKWh = data?.livePrice
    ? data.livePrice.priceUsdPerMWh / 1000 +
      modernAdderModel.deliveredAdderAfterFourCpUsdPerKWh -
      ersOffsetUsdPerKWh
    : 0;

  async function saveConfig() {
    setBusy(true);
    setMessage("");
    try {
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      await loadDashboard();
      setMessage("Strike logic updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save strike config.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(endpoint: string, file: File | null) {
    if (!file) return;
    setBusy(true);
    setMessage("");

    try {
      const formData = new FormData();
      formData.append("file", file);
      await fetch(endpoint, { method: "POST", body: formData });
      await loadDashboard();
      setMessage(`${file.name} imported.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  function renderSlider(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    update: (value: number) => void,
    unit: string
  ) {
    return (
      <label className="slider-field">
        <span className="slider-label">
          <span>{label}</span>
          <strong>
            {value.toLocaleString()}
            {unit}
          </strong>
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => update(Number(event.target.value))}
        />
        <input type="number" value={value} onChange={(event) => update(Number(event.target.value))} />
      </label>
    );
  }

  return (
    <main className="app-shell">
      <section className="content content-wide">
        <header className="brand-block panel">
          <div className="brand-row">
            <img src={clutchLogo} alt="Clutch Mining logo" className="brand-logo" />
            <div>
              <p className="eyebrow">Clutch Mining</p>
              <h1>ERCOT Dispatch Desk</h1>
            </div>
          </div>
          <p className="muted">
            Clean operator view for `LZ_SOUTH` pricing, mining thresholds, modeled sell-back
            windows, and uptime at the Lolita site.
          </p>
          <div className="header-meta">
            <div>
              <span className="muted small">Live market</span>
              <strong>
                {data?.livePrice ? `$${data.livePrice.priceUsdPerMWh.toFixed(2)}/MWh` : "Unavailable"}
              </strong>
            </div>
            <div>
              <span className="muted small">Live all-in</span>
              <strong>{data?.livePrice ? `$${liveAllInRateUsdPerKWh.toFixed(4)}/kWh` : "Unavailable"}</strong>
            </div>
            <div>
              <span className="muted small">Coverage</span>
              <strong>{dateRange}</strong>
            </div>
          </div>
          <a
            className="brand-link"
            href="https://clutchmining.com"
            target="_blank"
            rel="noreferrer"
          >
            clutchmining.com
          </a>
        </header>

        <section className="panel controls-panel">
          <div className="filter-group">
            <span className="muted small">Year</span>
            <div className="chip-row">
              {availableYears.map((year) => (
                <button
                  key={year}
                  className={`chip ${selectedYear === year ? "chip-active" : ""}`}
                  onClick={() => setSelectedYear(year)}
                >
                  {year === "all" ? "All" : year}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-group compact-group">
            <span className="muted small">Market</span>
            <div className="chip-row">
              {(["all", "RTM", "DAM"] as const).map((market) => (
                <button
                  key={market}
                  className={`chip ${selectedMarket === market ? "chip-active" : ""}`}
                  onClick={() => setSelectedMarket(market)}
                >
                  {market}
                </button>
              ))}
            </div>
          </div>
          <div className="slider-grid">
            {renderSlider("Load", config.siteLoadMw, 1, 250, 1, (value) =>
              setConfig((current) => ({ ...current, siteLoadMw: value })), " MW")}
            {renderSlider("Curtail", config.curtailStrikeUsdPerMWh, -50, 5000, 1, (value) =>
              setConfig((current) => ({
                ...current,
                curtailStrikeUsdPerMWh: value,
                sellBackStrikeUsdPerMWh:
                  current.sellBackStrikeUsdPerMWh < value ? value : current.sellBackStrikeUsdPerMWh
              })), " $/MWh")}
            {renderSlider(
              "Sell-back",
              config.sellBackStrikeUsdPerMWh,
              -50,
              5000,
              1,
              (value) =>
                setConfig((current) => ({
                  ...current,
                  sellBackStrikeUsdPerMWh:
                    value < current.curtailStrikeUsdPerMWh ? current.curtailStrikeUsdPerMWh : value
                })),
              " $/MWh"
            )}
            {renderSlider(
              "ERS offset",
              Number((ersOffsetUsdPerKWh * 100).toFixed(3)),
              0,
              2,
              0.001,
              (value) => setErsOffsetUsdPerKWh(value / 100),
              " ¢/kWh"
            )}
          </div>
          <div className="controls-footer">
            <div>
              <p className="muted small">
                Sliders update the scenario immediately. Save only if you want the thresholds persisted.
              </p>
              <p className="muted small">
                ERS offset is a net credit assumption from realized program revenue minus ERS-related charges shown in the 2025-2026 bills.
              </p>
            </div>
            <button onClick={saveConfig} disabled={busy}>
              Save
            </button>
          </div>
        </section>

        <section className="summary-strip">
          <div className="summary-pill panel">
            <span className="muted small">Mining Uptime</span>
            <strong>{summary.computeUptimePct.toFixed(1)}%</strong>
          </div>
          <div className="summary-pill panel">
            <span className="muted small">All-In Net Mining Cost</span>
            <strong>${netAllInMiningRateUsdPerKWh.toFixed(4)}/kWh</strong>
          </div>
          <div className="summary-pill panel">
            <span className="muted small">Sell-Back Revenue</span>
            <strong>${summary.sellBackRevenueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
          </div>
          <div className="summary-pill panel">
            <span className="muted small">Hours Sold Back</span>
            <strong>{summary.sellBackHours.toFixed(0)} h</strong>
          </div>
        </section>

        <section className="metrics-grid">
          <MetricCard
            label="Market Energy"
            value={data?.livePrice ? `$${data.livePrice.priceUsdPerMWh.toFixed(2)}` : "N/A"}
            detail="Current LZ_SOUTH market-only price in $/MWh"
            values={prices}
          />
          <MetricCard
            label="Delivered Adders"
            value={`${(deliveredAdderAfterCreditUsdPerKWh * 100).toFixed(2)}¢`}
            detail="After delivery-side credits, using 2025-2026 forward invoice calibration plus modeled 4CP-sensitive TCRF savings"
            values={prices}
          />
          <MetricCard
            label="4CP Credit"
            value={`${(weightedFourCpCreditUsdPerKWh * 100).toFixed(2)}¢`}
            detail="Modeled TCRF savings from holding Avg 4CP demand near zero in 2025-2026"
            values={decisions.map((item) => (item.status === "curtail" ? item.priceUsdPerMWh : 0))}
          />
          <MetricCard
            label="All-In Net Rate"
            value={`$${netAllInMiningRateUsdPerKWh.toFixed(4)}`}
            detail="All power costs net of delivery credits, realized ERS offset, and modeled sell-back revenue"
            values={decisions.map((item) => (item.status === "sell_back" ? item.priceUsdPerMWh : 0))}
          />
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>Dispatch Timeline</h3>
            <span>{summary.totalHours.toFixed(0)} hours modeled</span>
          </div>
          <StatusBars decisions={decisions} />
          <p className="muted small contract-note">
            Retail agreement review indicates hourly usage above or below the contracted block can be
            bought or sold at applicable RTM SPP, but this should still be treated as a block-settlement
            mechanism rather than an unrestricted merchant export right for every curtailed MWh.
          </p>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>All-In Rate Stack</h3>
            <span>2025-2026 forward calibration</span>
          </div>
          <div className="opportunity-metrics">
            <div>
              <span className="muted small">Retail consulting adder</span>
              <strong>{(modernAdderModel.fixedRetailUsdPerKWh * 100).toFixed(2)}¢/kWh</strong>
            </div>
            <div>
              <span className="muted small">Other market pass-throughs</span>
              <strong>
                {((modernAdderModel.marketPassThroughUsdPerKWh + modernAdderModel.eecrfUsdPerKWh) * 100).toFixed(2)}
                ¢/kWh
              </strong>
            </div>
            <div>
              <span className="muted small">Realized ERS offset</span>
              <strong>{(ersOffsetUsdPerKWh * 100).toFixed(2)}¢/kWh</strong>
            </div>
            <div>
              <span className="muted small">TDSP / delivery at current load</span>
              <strong>{(modernAdderModel.tdspDemandUsdPerKWh * 100).toFixed(2)}¢/kWh</strong>
            </div>
            <div>
              <span className="muted small">Taxes and PUC</span>
              <strong>{(modernAdderModel.taxesUsdPerKWh * 100).toFixed(2)}¢/kWh</strong>
            </div>
          </div>
        </section>

        <section className="opportunity-grid single-emphasis">
          <section className="panel">
            <div className="panel-header">
              <h3>Sell-Back Summary</h3>
              <span>{summary.sellBackIntervals} intervals</span>
            </div>
            <div className="opportunity-metrics">
              <div>
                <span className="muted small">Revenue opportunity</span>
                <strong>${summary.sellBackRevenueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
              </div>
              <div>
                <span className="muted small">Hours sold back</span>
                <strong>{summary.sellBackHours.toFixed(0)} h</strong>
              </div>
              <div>
                <span className="muted small">Energy sold back</span>
                <strong>{summary.sellBackMWh.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh</strong>
              </div>
              <div>
                <span className="muted small">Best interval</span>
                <strong>${sellBackOpportunities[0]?.priceUsdPerMWh.toFixed(2) ?? "0.00"}/MWh</strong>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h3>Top Sell-Back Windows</h3>
              <span>gross modeled value</span>
            </div>
            <div className="sellback-list">
              {sellBackOpportunities.slice(0, 5).map((item) => (
                <div key={item.id} className="sellback-row">
                  <div>
                    <strong>{new Date(item.intervalStart).toLocaleString()}</strong>
                    <p className="muted small">{item.market}</p>
                  </div>
                  <div className="right">
                    <strong>${item.priceUsdPerMWh.toFixed(2)}/MWh</strong>
                    <p className="muted small">
                      ${item.estimatedValueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} gross
                    </p>
                  </div>
                </div>
              ))}
              {sellBackOpportunities.length === 0 ? (
                <div className="empty-state">Current strike settings produce no sell-back opportunities.</div>
              ) : null}
            </div>
          </section>
        </section>

        <section className="panel minimal-admin">
          <div className="panel-header">
            <h3>Admin</h3>
            <span>{data?.documents.length ?? 0} stored files</span>
          </div>
          <div className="admin-actions">
            <label>
              ERCOT import
              <input
                type="file"
                accept=".csv,.xlsx"
                onChange={(e) => uploadFile("/api/import/ercot", e.target.files?.[0] ?? null)}
              />
            </label>
            <label>
              Agreement upload
              <input type="file" onChange={(e) => uploadFile("/api/import/aep", e.target.files?.[0] ?? null)} />
            </label>
          </div>
          {message ? <div className="notice">{message}</div> : null}
        </section>
      </section>
    </main>
  );
}
