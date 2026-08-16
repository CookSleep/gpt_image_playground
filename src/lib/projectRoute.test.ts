import { describe, expect, it } from 'vitest'
import { getProjectIdFromUrl, getProjectUrl } from './projectRoute'

describe('project route', () => {
  it('reads the active project from the url', () => {
    expect(getProjectIdFromUrl('http://localhost:5173/?project=project-a')).toBe('project-a')
    expect(getProjectIdFromUrl('http://localhost:5173/')).toBeNull()
  })

  it('updates only the project query parameter', () => {
    expect(getProjectUrl('project a', 'http://localhost:5173/?theme=dark#view')).toBe('/?theme=dark&project=project+a#view')
    expect(getProjectUrl(null, 'http://localhost:5173/?theme=dark&project=project-a#view')).toBe('/?theme=dark#view')
  })
})
