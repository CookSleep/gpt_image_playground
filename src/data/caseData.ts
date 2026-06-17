import type { CaseRecord, CaseStyleLibrary } from '../types'

const CASES_URL = 'https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data/cases.json'
const STYLE_LIBRARY_URL = 'https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data/style-library.json'
const IMAGE_BASE = 'https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data/images'

let casesCache: CaseRecord[] | null = null
let styleLibraryCache: CaseStyleLibrary | null = null
let fetchPromise: Promise<CaseRecord[]> | null = null
let stylePromise: Promise<CaseStyleLibrary> | null = null

export async function fetchCases(): Promise<CaseRecord[]> {
  if (casesCache) return casesCache
  if (fetchPromise) return fetchPromise

  fetchPromise = fetch(CASES_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to fetch cases: ${res.status}`)
      return res.json()
    })
    .then((data) => {
      casesCache = (data.cases as CaseRecord[]).map((c) => ({
        ...c,
        image: `${IMAGE_BASE}/${c.image.replace(/^\/images\//, '')}`,
      }))
      return casesCache
    })
    .catch((err) => {
      fetchPromise = null
      throw err
    })

  return fetchPromise
}

export async function fetchStyleLibrary(): Promise<CaseStyleLibrary> {
  if (styleLibraryCache) return styleLibraryCache
  if (stylePromise) return stylePromise

  stylePromise = fetch(STYLE_LIBRARY_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to fetch style library: ${res.status}`)
      return res.json()
    })
    .then((data) => {
      styleLibraryCache = data as CaseStyleLibrary
      return styleLibraryCache
    })
    .catch((err) => {
      stylePromise = null
      throw err
    })

  return stylePromise
}

export function getImageUrl(imagePath: string): string {
  if (imagePath.startsWith('http')) return imagePath
  return `${IMAGE_BASE}/${imagePath.replace(/^\/images\//, '')}`
}
