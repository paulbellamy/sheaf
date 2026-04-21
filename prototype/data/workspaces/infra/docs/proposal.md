# RPC rate-limit proposal

## §1. Motivation

Our public API is seeing burst traffic from a handful of unauthenticated
clients. Current throttling is per-IP at the edge, which collapses under
shared egress and over-counts for users behind carrier NAT.

## §2. Goals

- Per-account limits for authenticated traffic, with a cheap default.
- A dedicated bucket for unauth traffic, billed against the origin ASN.
- No new hot-path dependencies.

## §3. Design

We introduce a token-bucket at the gateway, keyed by `account_id` when a
bearer token is present and by `asn` otherwise. Buckets live in the existing
Redis fleet, refilled on a 1s tick. Exceeded calls return 429 with a
`Retry-After` header derived from the bucket's next-refill time.

The implementation reuses the middleware stack we already run for auth, so
no new hot-path dependencies are required.

## §4. Rollout

Shadow mode for two weeks; real enforcement behind a feature flag, rolled
from 1% → 10% → 100% over a week.
