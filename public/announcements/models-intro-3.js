// 应用通过 ?theme= 告知颜色模式
const theme = new URLSearchParams(location.search).get('theme')
if (theme) document.documentElement.dataset.theme = theme
