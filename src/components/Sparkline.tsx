interface SparklineProps {
  values: number[];
}

export function Sparkline({ values }: SparklineProps) {
  if (values.length === 0) {
    return <div className="empty-state">No points yet</div>;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * 100;
      const y = 100 - ((value - min) / range) * 100;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox="0 0 100 100" className="sparkline" preserveAspectRatio="none">
      <polyline fill="none" stroke="currentColor" strokeWidth="2" points={points} />
    </svg>
  );
}
