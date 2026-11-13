export default function DragUploadOverlay({ visible, maxImages }: { visible: boolean; maxImages: number }) {
  if (!visible) return null

  return (
    <div className="fixed inset-0 z-[100] bg-white/60 dark:bg-gray-900/60 backdrop-blur-md flex flex-col items-center justify-center pointer-events-none">
      <div className="flex flex-col items-center gap-4 p-8 rounded-3xl">
        <div className="w-20 h-20 rounded-full border-2 border-dashed flex items-center justify-center bg-blue-50 dark:bg-blue-500/10 border-blue-400">
          <svg className="w-10 h-10 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-lg font-semibold text-gray-700 dark:text-gray-200">释放以上传图片</p>
          <p className="text-sm text-gray-400 mt-1">当前模型每次最多使用 {maxImages} 张，超限图片会保留并置灰</p>
        </div>
      </div>
    </div>
  )
}
