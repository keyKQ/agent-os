import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

// Global CSS (view-specific CSS is imported per-view later).
// Order mirrors the legacy template: fonts -> base -> components ->
// prism -> mobile. mobile.css MUST be imported LAST so its overrides win.
import './styles/fonts.css'
import './styles/base.css'
import './styles/components.css'
import './styles/prism-agentos.css'
import './styles/mobile.css'

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
