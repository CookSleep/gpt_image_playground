export type ServiceWorkerRegistry = Pick<ServiceWorkerContainer, 'getRegistrations'>
export type CacheRegistry = Pick<CacheStorage, 'keys' | 'delete'>

export async function retireServiceWorkers(serviceWorkers: ServiceWorkerRegistry, cacheStorage?: CacheRegistry) {
  const registrations = await serviceWorkers.getRegistrations()
  await Promise.all(registrations.map((registration) => registration.unregister()))
  if (!cacheStorage) return
  const keys = await cacheStorage.keys()
  await Promise.all(keys.map((key) => cacheStorage.delete(key)))
}
