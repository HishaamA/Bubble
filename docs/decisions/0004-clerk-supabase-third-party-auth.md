# 0004 — Use Clerk native third-party auth with Supabase

## Status

Accepted for the persistent MVP.

## Context

Bubble uses Clerk for account sessions and Supabase for Postgres, private
Storage, Realtime, and server-time workflows. Clerk user subjects are strings
such as `user_...`; they are not UUID rows in Supabase's managed `auth.users`
table. The previous schema coupled application ownership directly to
`auth.users(id)` and used `auth.uid()`, which cannot represent a Clerk subject.

The old Clerk Supabase JWT-template integration is deprecated. Sharing a
Supabase JWT secret with Clerk is not acceptable for a new deployment.

## Decision

- Enable Clerk's native Supabase integration and add Clerk as a Supabase
  third-party auth provider. The browser passes the current Clerk session token
  through Supabase JS's `accessToken` callback.
- Derive the external identity only from the verified `auth.jwt()->>'sub'`
  claim. Never accept a subject from a client RPC argument.
- Map that subject to one stable internal UUID in the private
  `app_identities` table. Existing application foreign keys keep UUIDs and are
  repointed to `profiles(id)` with their original delete semantics.
- Bootstrap a profile and private preferences idempotently on the first
  authenticated database request. Clerk third-party auth does not create a row
  in `auth.users`, so an auth trigger alone is insufficient.
- Keep email in a no-client-grant `profile_private` table. Circle members may
  read public display profiles but cannot read another member's email or OIDC
  subject mapping. Email received from the browser is display-only and
  unverified; it cannot drive authorization or outbound contact until a trusted
  Clerk webhook or verified JWT claim supplies it.
- Namespace IndexedDB moments and local event/reminder keys by Clerk subject.
  A session must never render another account's offline family data on the same
  browser profile.
- Enforce the MVP's one-active-family rule with a partial unique membership
  index and per-user transactional locks. Pending requests may coexist, but
  family creation, join submission after approval, and a second approval fail
  with `already_a_member` instead of choosing an arbitrary oldest family.

## Required dashboard configuration

1. In Clerk, activate the Supabase integration for the intended Clerk instance.
2. Copy the exact Clerk domain shown by that setup.
3. In Supabase, open Authentication → Sign In / Providers, add Clerk as a
   third-party provider, and paste that domain.
4. Configure the client-safe Clerk publishable key, Supabase project URL, and
   Supabase publishable key. Do not place Clerk secret keys, Supabase secret
   keys, service-role keys, or JWT signing secrets in Vite variables.
5. For local Supabase CLI testing, uncomment `[auth.third_party.clerk]` in
   `supabase/config.toml` and replace the documented placeholder with the exact
   development Clerk domain.

References:

- <https://supabase.com/docs/guides/auth/third-party/clerk>
- <https://clerk.com/docs/guides/development/integrations/databases/supabase>

## Consequences

- Authentication and authorization remain separate: Clerk proves identity;
  Postgres membership rows decide family access.
- Profile/bootstrap metadata supplied by the client is display-only and is
  never used for authorization. In particular, the private email field is not
  independently verified and must not be used as a trusted contact address.
- Legacy Supabase Auth inserts and deletes remain mirrored into app profiles;
  the delete trigger preserves the declared cascade/restrict lifecycle after
  removing the direct `profiles(id) -> auth.users(id)` foreign key.
- Existing databases with multiple approved memberships must be resolved
  deliberately before this migration; it fails atomically rather than deleting
  or silently selecting one family.
- Account deletion requires a trusted Clerk webhook or administrative job that
  deletes the mapped profile according to the product's retention policy.
- Old global browser caches are no longer read. A later cleanup task may delete
  the inaccessible legacy IndexedDB database after an appropriate retention
  window.
