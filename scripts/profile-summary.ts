export interface CPUProfile {
  nodes: {
    id: number;
    callFrame: { functionName: string; url?: string };
    children?: number[];
  }[];
  samples?: number[];
  timeDeltas?: number[];
}
export function summarizeProfile(profile: CPUProfile) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id);
  const self = new Map<number, number>(),
    inclusive = new Map<number, number>();
  const buckets = new Map<string, number>();
  const category = (name: string) => {
    if (/json|write__result__(cell|row)/i.test(name)) return "JSON";
    if (/find__binding|find__context|resolve__context|identifier/.test(name))
      return "column resolution";
    if (
      /row__environment|affinity__name|integer__primary|primary__key/.test(name)
    )
      return "row environments";
    if (/copy__store|database__clone/.test(name)) return "write backup";
    if (/sort|partition|compare__stored/i.test(name)) return "sort / compare";
    if (/lex|Parser|parse__statement/.test(name)) return "SQL parser";
    if (/garbage collector/i.test(name)) return "GC";
    return undefined;
  };
  let sampledMs = 0;
  for (const [i, id] of (profile.samples ?? []).entries()) {
    const ms = (profile.timeDeltas?.[i] ?? 0) / 1000;
    sampledMs += ms;
    self.set(id, (self.get(id) ?? 0) + ms);
    let current: number | undefined = id,
      bucket: string | undefined;
    while (current !== undefined) {
      const node = nodes.get(current);
      if (!node) throw Error(`unknown profile node: ${current}`);
      inclusive.set(current, (inclusive.get(current) ?? 0) + ms);
      bucket ??= category(node.callFrame.functionName);
      current = parents.get(current);
    }
    const name = bucket ?? "other";
    buckets.set(name, (buckets.get(name) ?? 0) + ms);
  }
  return {
    sampledMs,
    samples: profile.samples?.length ?? 0,
    categories: [...buckets]
      .map(([name, milliseconds]) => ({
        name,
        milliseconds,
        percent: (milliseconds / sampledMs) * 100,
      }))
      .sort((a, b) => b.milliseconds - a.milliseconds),
    topFunctions: profile.nodes
      .map((node) => ({
        name: node.callFrame.functionName,
        url: node.callFrame.url,
        selfMs: self.get(node.id) ?? 0,
        inclusiveMs: inclusive.get(node.id) ?? 0,
        selfPercent: ((self.get(node.id) ?? 0) / sampledMs) * 100,
      }))
      .filter((f) => f.selfMs > 0)
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 30),
  };
}
