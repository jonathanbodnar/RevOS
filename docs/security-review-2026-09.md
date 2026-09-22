# September 2026 security findings

This records the disposition of the Aikido screenshots supplied on September
22, 2026. Scanner status still needs a rescan of the merged commit; this file
does not suppress any findings.

## Dependency updates

The lockfile resolves Next.js 15.5.25, next-auth 4.24.15, sharp 0.35.4,
Zod 4.6.5, and jose 4.15.9. Next.js and NextAuth remain on their existing major
versions, with React 18 retained. The Next.js PostCSS dependency is overridden
to the same patched PostCSS 8 version used by the build; otherwise Next 15
still installs a vulnerable pinned copy. Compatible updates also address the
audit findings in browserslist, baseline-browser-mapping, nanoid, esbuild, and
postcss-selector-parser.

Upstream references: [Next.js security release](https://github.com/vercel/next.js/releases/tag/v15.5.24),
[NextAuth security release](https://github.com/nextauthjs/next-auth/releases/tag/next-auth@4.24.15),
[sharp release](https://github.com/lovell/sharp/releases/tag/v0.35.4).

## Query validation

RevOS uses Prisma with PostgreSQL. The scanner's “NoSQL injection” label refers
to passing objects into query filters; no NoSQL database is involved. Runtime
validation and explicit scalar equality filters now protect these paths:

| Finding | Change and preserved behavior |
| --- | --- |
| Charge follow-up | Validate the path id and persisted customer id before writes. Cascades still target only that patient's other failed charges with untouched follow-up. |
| Vaulted-card deduplication | Validate customer id and all card metadata at the shared function boundary. Default-card changes remain scoped to the customer. A vault id owned by another customer is rejected before any write. |
| Move customer: schedules and advanced costs | Build every related-record filter from the validated customer id and destination clinic id. All history still moves in one transaction; old provider assignments are removed. |
| InBody device assignment | Validate the serial and nonempty clinic id. Existing-scan updates still fill only missing clinic assignments for that serial. Clearing the device clinic remains supported with `null`. |
| Subscription restart cleanup | Delete only the claim matching the validated subscription id when the processor call fails. The existing concurrency guard and future billing date behavior remain intact. |

## Training content

`src/lib/markdown.ts` now produces React elements and text nodes. The learning
page no longer uses `dangerouslySetInnerHTML`. Headings, paragraphs, ordered
and unordered lists, bold, italic, inline code, HTTP(S) links, and HTTPS video
embeds remain supported. Raw HTML remains visible text; URLs are React
attributes and are never reinterpreted as Markdown formatting.

## Findings requiring scanner disposition or follow-up

- **TOTP test secret:** a public [RFC 6238 Appendix B](https://www.rfc-editor.org/rfc/rfc6238#appendix-B)
  known-answer fixture, not a production credential. The test now cites its
  source explicitly. Mark this individual finding as a test fixture in Aikido;
  do not exclude the whole test directory from secret scanning.
- **Generic API key in `e2e-smoke.mjs`:** the current file contains no hardcoded
  admin credential or API key. It requires `SMOKE_ADMIN_PASSWORD`, and now uses
  cryptographic randomness for temporary clinic passwords. A previous literal
  was removed in commit `09e833f`. Removal does not prove revocation: confirm
  that historical credential was rotated before closing a history-based alert.
  No production credentials were changed by this patch.
- **GitHub organization IP allow list:** GitHub's repository API identifies
  `jonathanbodnar/RevOS` as a public repository owned by a `User`, not an
  organization. [IP allow lists require a GitHub Enterprise Cloud organization](https://docs.github.com/en/enterprise-cloud@latest/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/managing-allowed-ip-addresses-for-your-organization).
  This organization-specific finding is not applicable to the present owner.
  A future organization migration would need approved office/VPN and deployment
  addresses before enforcement.
- **Next.js support lifecycle:** Next 15 is still Maintenance LTS on the review
  date. Its two-year support window ends October 21, 2026 according to the
  [Next.js support policy](https://nextjs.org/support-policy). This patch fixes
  current vulnerabilities on the existing major; a separately tested Next 16
  migration is still needed before that date.

## Verification

`npm test` includes malicious query inputs, unchanged valid admin operations,
card ownership/deduplication, and Markdown XSS/formatting regressions. Route
tests replace all Prisma delegates with in-memory stubs that throw on
unexpected calls and mock payment operations. No real cards or patient data
are used. Run `npm ci`, `npm test`, `npm run build`, and `npm audit` when
reproducing the dependency checks.

Validation on September 22: clean `npm ci`, 55 passing tests, successful
production build/type checking, and zero npm audit vulnerabilities. Local
production HTTP checks passed for login, anonymous admin redirects, session
and CSRF endpoints, denied unauthenticated writes, and Next.js image
optimization with database/payment credentials disabled. Sharp also passed
JPEG, WebP, and AVIF resize/decoding checks. Real payment processing was not
exercised.
