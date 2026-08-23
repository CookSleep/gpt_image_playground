import { useCallback, useRef, useState, type DragEvent } from 'react'
import { uploadMaterialFile, type MaterialItem } from '../lib/materialApi'

export function useMaterialDropUpload(options: {
  onUploaded: (items: MaterialItem[]) => void | Promise<void>
  onError: (message: string) => void
}) {
  const [uploading, setUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragDepthRef = useRef(0)
  const uploadingRef = useRef(false)

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    if (uploadingRef.current) return
    const values = Array.from(files)
    const imageFiles = values.filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length === 0) {
      options.onError('只支持上传图片文件')
      return
    }

    uploadingRef.current = true
    setUploading(true)
    options.onError('')
    try {
      const uploaded: MaterialItem[] = []
      for (const file of imageFiles) uploaded.push(await uploadMaterialFile(file))
      await options.onUploaded(uploaded)
      if (imageFiles.length < values.length) {
        options.onError(`已忽略 ${values.length - imageFiles.length} 个非图片文件`)
      }
    } catch (err) {
      options.onError(err instanceof Error ? err.message : String(err))
    } finally {
      uploadingRef.current = false
      setUploading(false)
    }
  }, [options.onError, options.onUploaded])

  const hasFiles = (event: DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes('Files')

  const onDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current += 1
    setIsDragging(true)
  }, [])

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (dragDepthRef.current === 0) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDragging(false)
  }, [])

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasFiles(event) && event.dataTransfer.files.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setIsDragging(false)
    void uploadFiles(event.dataTransfer.files)
  }, [uploadFiles])

  return {
    uploading,
    isDragging,
    uploadFiles,
    dropZoneProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
