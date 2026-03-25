import type { IntervalDecision } from "../lib/types";

interface PriceTableProps {
  decisions: IntervalDecision[];
}

export function PriceTable({ decisions }: PriceTableProps) {
  const rows = decisions.slice(-24).reverse();

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Latest Intervals</h3>
        <span>last {rows.length}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Market</th>
              <th>Price</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={item.id}>
                <td>{new Date(item.intervalStart).toLocaleString()}</td>
                <td>{item.market}</td>
                <td>${item.priceUsdPerMWh.toFixed(2)}</td>
                <td className={`status-${item.status}`}>{item.status.replace("_", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
