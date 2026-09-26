const KEY = 'gpt-image-batch-size'

export function readImageBatchSize() {
  try {
    const value = Number(localStorage.getItem(KEY))
    if (Number.isFinite(value) && value >= 1) return Math.floor(value)
  } catch {
    // Keep the default when storage is unavailable.
  }
  return 4
}

export function writeImageBatchSize(value: number) {
  const next = Number.isFinite(value) && value >= 1 ? Math.floor(value) : 4
  try {
    localStorage.setItem(KEY, String(next))
  } catch {
    // The current page still uses the value held by the input.
  }
  return next
}

export function batchCount(total: number, size: number) {
  if (total <= 0) return 0
  const batch = size > 0 ? Math.floor(size) : total
  return Math.ceil(total / batch)
}

export async function runInBatches<T>(items: T[], size: number, worker: (item: T) => Promise<unknown>) {
  const batch = size > 0 ? Math.floor(size) : items.length || 1
  for (let index = 0; index < items.length; index += batch) {
    await Promise.all(items.slice(index, index + batch).map((item) => worker(item)))
  }
}
