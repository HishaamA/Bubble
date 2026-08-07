import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import './index.css'
import App from './App.tsx'
import { installNativeViewportGeometrySync } from './app/nativeViewportGeometry'
import { clerkConfigured } from './features/auth'

installNativeViewportGeometrySync()

const app = clerkConfigured ? (
  <ClerkProvider>
    <App />
  </ClerkProvider>
) : (
  <App />
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {app}
  </StrictMode>,
)
