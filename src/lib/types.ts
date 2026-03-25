export type Market = "RTM" | "DAM";
export type IntervalStatus = "compute" | "curtail" | "sell_back";

export interface PricePoint {
  id: string;
  intervalStart: string;
  settlementPoint: string;
  market: Market;
  priceUsdPerMWh: number;
  source: string;
}

export interface LivePrice {
  settlementPoint: string;
  priceUsdPerMWh: number;
  publishedAt: string;
  source: string;
}

export interface StrikeConfig {
  siteLoadMw: number;
  curtailStrikeUsdPerMWh: number;
  sellBackStrikeUsdPerMWh: number;
}

export interface DocumentRecord {
  id: string;
  name: string;
  uploadedAt: string;
  path: string;
  type: "aep" | "ercot";
}

export interface IntervalDecision extends PricePoint {
  status: IntervalStatus;
  estimatedValueUsd: number;
}

export interface DashboardPayload {
  livePrice: LivePrice | null;
  priceHistory: PricePoint[];
  strikeConfig: StrikeConfig;
  documents: DocumentRecord[];
  availableYears: string[];
}
