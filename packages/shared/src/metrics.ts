// Minimal, dependency-free Prometheus metrics registry. Each process (web, worker) holds
// its own module-singleton registry — exactly how Prometheus expects per-instance scraping.
// We deliberately avoid prom-client: a tiny counter/gauge + text exposition is all we need
// and keeps the dependency surface (and air-gap risk) small. SKILLY_SPEC.md §14.

export type MetricType = "counter" | "gauge";
type Labels = Record<string, string>;

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(labels[k] ?? "")}"`)
    .join(",");
}

class Metric {
  readonly series = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string, readonly type: MetricType) {}

  add(delta: number, labels: Labels = {}): void {
    const key = seriesKey(labels);
    const cur = this.series.get(key);
    if (cur) cur.value += delta;
    else this.series.set(key, { labels, value: delta });
  }
  set(value: number, labels: Labels = {}): void {
    this.series.set(seriesKey(labels), { labels, value });
  }
}

/** A bound handle so callers don't repeat metric names. */
export class Counter {
  constructor(private readonly m: Metric) {}
  inc(labels?: Labels): void {
    this.m.add(1, labels);
  }
  add(n: number, labels?: Labels): void {
    this.m.add(n, labels);
  }
}
export class Gauge {
  constructor(private readonly m: Metric) {}
  set(value: number, labels?: Labels): void {
    this.m.set(value, labels);
  }
}

export class Registry {
  private readonly metrics = new Map<string, Metric>();

  private getOrCreate(name: string, help: string, type: MetricType): Metric {
    let m = this.metrics.get(name);
    if (!m) {
      m = new Metric(name, help, type);
      this.metrics.set(name, m);
    }
    return m;
  }
  counter(name: string, help: string): Counter {
    return new Counter(this.getOrCreate(name, help, "counter"));
  }
  gauge(name: string, help: string): Gauge {
    return new Gauge(this.getOrCreate(name, help, "gauge"));
  }

  /** Render the Prometheus text exposition format (version 0.0.4). */
  render(): string {
    const out: string[] = [];
    for (const m of this.metrics.values()) {
      out.push(`# HELP ${m.name} ${m.help}`);
      out.push(`# TYPE ${m.name} ${m.type}`);
      if (m.series.size === 0) {
        out.push(`${m.name} 0`);
        continue;
      }
      for (const s of m.series.values()) {
        const key = seriesKey(s.labels);
        out.push(key ? `${m.name}{${key}} ${s.value}` : `${m.name} ${s.value}`);
      }
    }
    return out.join("\n") + "\n";
  }
}

/** Process-wide registry singleton. */
export const metrics = new Registry();

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
