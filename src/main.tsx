import 'core-js/actual/array/at'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { retireServiceWorkers } from './lib/serviceWorker'
import './index.css'

if ('serviceWorker' in navigator) {
  void retireServiceWorkers(navigator.serviceWorker, 'caches' in window ? window.caches : undefined)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
