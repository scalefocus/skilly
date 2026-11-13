// The holders line on a skill's expanded usage row (SKILLY_SPEC.md §21 "Plugin deliveries are not
// adoption"): how many people hold the skill, and how many of them only through a plugin
// marketplace delivery. It is why a skill's install count can be far above its maintainers'
// installs received. Pure, so the wording is unit-tested.

export interface Holders {
  total: number;
  pluginOnly: number;
}

/** "Held by 45 people · 40 by plugin only"; just "Held by 3 people" when none are plugin-only. */
export function holdersLine(h: Holders): string {
  const people = `Held by ${h.total} ${h.total === 1 ? "person" : "people"}`;
  return h.pluginOnly > 0 ? `${people} · ${h.pluginOnly} by plugin only` : people;
}
