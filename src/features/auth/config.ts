/** Whether this build contains a usable Clerk publishable key. */
export const clerkConfigured = Boolean(
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim(),
)
