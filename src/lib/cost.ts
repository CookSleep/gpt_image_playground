export function formatActualCost(cost: number) {
  return `$${cost.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`
}
