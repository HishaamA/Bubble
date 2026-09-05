/**
 * Compatibility exports for tests and integrations that import the historical
 * route module. App.tsx imports the domain route modules directly so Vite can
 * keep Journal, capture, and memory experiences in separate lazy chunks.
 */
export { CaptureRoute } from './routes/CaptureRoute'
export { CapsulePhotoRoute, JournalRoute } from './routes/JournalRoutes'
export { MemoriesRoute, PanoramaRoute } from './routes/MemoriesRoutes'
