/** `data-*` attributes, which every kit component passes to its root element: hooks for tests and styles. */
export type DataAttributes = { [K in `data-${string}`]?: string | number | boolean | undefined };

/** The `data-*` entries of `props`, to spread on a component's root element. */
export function dataAttributes(props: object): DataAttributes {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) if (key.startsWith('data-')) out[key] = value;
  return out as DataAttributes;
}
