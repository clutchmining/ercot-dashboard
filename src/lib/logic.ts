import type { IntervalDecision, PricePoint, StrikeConfig } from "./types";

function getIntervalHours(point: Pick<PricePoint, "market">) {
  return point.market === "RTM" ? 5 / 60 : 1;
}

export function deriveDecision(point: PricePoint, config: StrikeConfig): IntervalDecision {
  const intervalHours = getIntervalHours(point);
  const estimatedValueUsd = point.priceUsdPerMWh * config.siteLoadMw * intervalHours;

  let status: IntervalDecision["status"] = "compute";
  if (point.priceUsdPerMWh >= config.sellBackStrikeUsdPerMWh) {
    status = "sell_back";
  } else if (point.priceUsdPerMWh >= config.curtailStrikeUsdPerMWh) {
    status = "curtail";
  }

  return { ...point, status, estimatedValueUsd };
}

export function deriveDecisions(points: PricePoint[], config: StrikeConfig): IntervalDecision[] {
  return points.map((point) => deriveDecision(point, config));
}

export function summarizeDecisions(decisions: IntervalDecision[], siteLoadMw: number) {
  const totalIntervals = decisions.length;
  const totals = decisions.reduce(
    (acc, item) => {
      const intervalHours = getIntervalHours(item);
      const intervalMWh = intervalHours * siteLoadMw;

      acc.totalHours += intervalHours;
      acc.volumeWeightedPrice += item.priceUsdPerMWh * intervalHours;

      if (item.status === "compute") {
        acc.computeIntervals += 1;
        acc.computeHours += intervalHours;
        acc.computeMWh += intervalMWh;
        acc.computeCostUsd += item.priceUsdPerMWh * intervalMWh;
      } else if (item.status === "curtail") {
        acc.curtailIntervals += 1;
        acc.curtailHours += intervalHours;
        acc.curtailedMWh += intervalMWh;
        acc.curtailedExposureUsd += item.priceUsdPerMWh * intervalMWh;
      } else {
        acc.sellBackIntervals += 1;
        acc.sellBackHours += intervalHours;
        acc.sellBackMWh += intervalMWh;
        acc.sellBackRevenueUsd += item.priceUsdPerMWh * intervalMWh;
      }

      return acc;
    },
    {
      totalHours: 0,
      volumeWeightedPrice: 0,
      computeIntervals: 0,
      curtailIntervals: 0,
      sellBackIntervals: 0,
      computeHours: 0,
      curtailHours: 0,
      sellBackHours: 0,
      computeMWh: 0,
      curtailedMWh: 0,
      sellBackMWh: 0,
      computeCostUsd: 0,
      sellBackRevenueUsd: 0,
      curtailedExposureUsd: 0
    }
  );

  const averagePriceUsdPerMWh =
    totals.totalHours === 0 ? 0 : totals.volumeWeightedPrice / totals.totalHours;
  const effectiveComputeRateUsdPerMWh =
    totals.computeMWh === 0 ? 0 : totals.computeCostUsd / totals.computeMWh;
  const netEffectiveRateUsdPerMWh =
    totals.computeMWh === 0
      ? 0
      : (totals.computeCostUsd - totals.sellBackRevenueUsd) / totals.computeMWh;

  return {
    totalIntervals,
    totalHours: totals.totalHours,
    computeIntervals: totals.computeIntervals,
    curtailIntervals: totals.curtailIntervals,
    sellBackIntervals: totals.sellBackIntervals,
    computeHours: totals.computeHours,
    curtailHours: totals.curtailHours,
    sellBackHours: totals.sellBackHours,
    computeUptimePct: totals.totalHours === 0 ? 0 : (totals.computeHours / totals.totalHours) * 100,
    averagePriceUsdPerMWh,
    computeMWh: totals.computeMWh,
    curtailedMWh: totals.curtailedMWh,
    sellBackMWh: totals.sellBackMWh,
    computeCostUsd: totals.computeCostUsd,
    sellBackRevenueUsd: totals.sellBackRevenueUsd,
    curtailedExposureUsd: totals.curtailedExposureUsd,
    effectiveComputeRateUsdPerMWh,
    effectiveComputeRateUsdPerKWh: effectiveComputeRateUsdPerMWh / 1000,
    netEffectiveRateUsdPerMWh,
    netEffectiveRateUsdPerKWh: netEffectiveRateUsdPerMWh / 1000,
    netPowerOutcomeUsd: totals.sellBackRevenueUsd - totals.computeCostUsd
  };
}
