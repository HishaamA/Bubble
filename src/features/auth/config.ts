export const clerkConfigured = Boolean(
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim(),
)
