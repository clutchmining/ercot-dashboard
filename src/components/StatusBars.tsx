import type { IntervalDecision } from "../lib/types";

interface StatusBarsProps {
  decisions: IntervalDecision[];
}

const COLORS = {
  compute: "#73bf69",
  curtail: "#f2cc0c",
  sell_back: "#f2495c"
};

export function StatusBars({ decisions }: StatusBarsProps) {
  if (decisions.length === 0) {
    return <div className="empty-state">Upload ERCOT exports to see curtailment status by interval.</div>;
  }

  return (
    <div className="status-bars panel">
      <div className="panel-header">
        <h3>Dispatch Timeline</h3>
        <span>{decisions.length} intervals</span>
      </div>
      <div className="status-track">
        {decisions.slice(-288).map((item) => (
          <div
            key={item.id}
            className="status-segment"
            title={`${new Date(item.intervalStart).toLocaleString()} ${item.status} $${item.priceUsdPerMWh.toFixed(2)}`}
            style={{ backgroundColor: COLORS[item.status] }}
          />
        ))}
      </div>
    </div>
  );
}
