/** Operator ceilings in the operation budget's currency minor units, never a provider tariff. */
export function providerCostCeilingIssues(ceilings: unknown, providerKeys: readonly string[]): string[] {
  const values = ceilings && typeof ceilings === 'object' && !Array.isArray(ceilings) ? ceilings as Record<string, unknown> : {};
  return [...new Set(providerKeys)].filter(key => {
    const value = values[key];
    return typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || (key === 'brave-search:web@1' && value === 0);
  });
}
