export function getAppLayer() {
  return document.getElementById('app-layer') ?? document.body
}

export function getTopDialog() {
  return document.getElementById('confirm-dialogs')?.lastElementChild
    ?? document.getElementById('app-dialogs')?.lastElementChild
}

// 两个容器的显示顺序由 index.html 固定，同一层最后打开的弹窗在最上方。
export function syncDialogLayers() {
  const top = getTopDialog()
  document.getElementById('app-layer')?.toggleAttribute('inert', Boolean(top))
  for (const dialog of document.querySelectorAll('#app-dialogs > *, #confirm-dialogs > *')) {
    dialog.toggleAttribute('inert', dialog !== top)
  }
}
