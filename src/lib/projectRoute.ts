const PROJECT_QUERY_PARAM = 'project'

export function getProjectIdFromUrl(href = window.location.href) {
  const value = new URL(href).searchParams.get(PROJECT_QUERY_PARAM)?.trim()
  return value || null
}

export function getProjectUrl(projectId: string | null, href = window.location.href) {
  const url = new URL(href)
  if (projectId) url.searchParams.set(PROJECT_QUERY_PARAM, projectId)
  else url.searchParams.delete(PROJECT_QUERY_PARAM)
  return `${url.pathname}${url.search}${url.hash}`
}

export function updateProjectUrl(projectId: string | null, replace = false) {
  const url = getProjectUrl(projectId)
  if (replace) {
    window.history.replaceState(null, '', url)
    return
  }
  window.history.pushState(null, '', url)
}
