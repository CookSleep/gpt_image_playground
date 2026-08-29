let completionAudio: HTMLAudioElement | null = null

function getCompletionAudio() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  if (completionAudio) return completionAudio

  try {
    completionAudio = new Audio(new URL('y2181.wav', document.baseURI).toString())
    completionAudio.preload = 'auto'
    completionAudio.volume = 1
    return completionAudio
  } catch {
    return null
  }
}

function unlockCompletionAudio() {
  const audio = getCompletionAudio()
  if (!audio) return
  audio.muted = true
  void audio.play().then(() => {
    audio.pause()
    audio.currentTime = 0
    audio.muted = false
  }).catch(() => {
    audio.muted = false
  })
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlockCompletionAudio, { once: true, passive: true })
  window.addEventListener('keydown', unlockCompletionAudio, { once: true })
}

export function playCompletionSound() {
  const audio = getCompletionAudio()
  if (!audio) return
  audio.currentTime = 0
  audio.muted = false
  void audio.play().catch(() => {})
}
