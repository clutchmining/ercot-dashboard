import { Sparkline } from "./Sparkline";

interface MetricCardProps {
  label: string;
  value: string;
  detail: string;
  values?: number[];
}

export function MetricCard({ label, value, detail, values = [] }: MetricCardProps) {
  return (
    <section className="panel metric-card">
      <div className="metric-head">
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
      <Sparkline values={values} />
    </section>
  );
}
