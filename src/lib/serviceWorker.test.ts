import { describe, expect, it, vi } from 'vitest'
import { retireServiceWorkers } from './serviceWorker'

describe('service worker retirement', () => {
  it('unregisters workers and clears caches without navigating the page', async () => {
    const unregister = vi.fn().mockResolvedValue(true)
    const getRegistrations = vi.fn().mockResolvedValue([{ unregister }])
    const keys = vi.fn().mockResolvedValue(['old-shell', 'old-api'])
    const remove = vi.fn().mockResolvedValue(true)

    await retireServiceWorkers({ getRegistrations }, { keys, delete: remove })

    expect(getRegistrations).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledTimes(2)
  })
})
