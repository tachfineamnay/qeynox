# Chatwoot support integration — architecture and live verification

Status: **implemented, contract-tested against fixtures, NOT live-verified.** The support surfaces (customer "Support" tab in Web, operator "Support inbox" in Control, `/v1/support/*` and `/v1/platform/support/*` in the API) ship fail-closed: until the procedure in [Live verification](#live-verification) is completed by an operator against a real Chatwoot instance, the API reports `NOT_CONFIGURED` and every support action is refused with `503 NOT_CONFIGURED`.

No fixture result in this repository is evidence of live integration. This document is the procedure that closes the gap.

## What QeyNox does with Chatwoot

Chatwoot is the single external support engine. QeyNox never mirrors conversations or messages into PostgreSQL. The only persisted support data is:

- `support_chatwoot_links` — the authorization mapping `(user_id, workspace_id) ↔ (chatwoot_contact_id, chatwoot_conversation_id)`, plus a `state` column (`ACTIVE` | `ORPHANED`). A link is what lets a workspace session reach a specific remote conversation — nothing else is accepted as an identifier.
- `support_intents` — the durable reconciliation bookkeeping for an open request: the deterministic `intent_ref` (the client's `requestId`), the resolved remote ids, the state machine (`PENDING_CONTACT → PENDING_CONVERSATION → LINKED`, or `FAILED`), and a `failure_code`. No message content is stored. Scoped unique index `(workspace_id, user_id, intent_ref)` — an intent key is never resolved across tenants.

## Capability gate

`apps/api/src/support/chatwoot.client.ts` computes the capability:

| Variables | Result |
|---|---|
| any of `QEYNOX_CHATWOOT_BASE_URL`, `QEYNOX_CHATWOOT_API_TOKEN`, `QEYNOX_CHATWOOT_ACCOUNT_ID`, `QEYNOX_CHATWOOT_INBOX_ID` missing/invalid | `NOT_CONFIGURED`, reason lists the missing keys |
| base URL is not HTTPS (plain HTTP is only accepted for loopback) | `NOT_CONFIGURED` / `QEYNOX_CHATWOOT_BASE_URL_INSECURE` / `_INVALID` |
| account/inbox ids not numeric | `NOT_CONFIGURED` / `QEYNOX_CHATWOOT_ACCOUNT_OR_INBOX_INVALID` |
| all of the above valid **but** `QEYNOX_CHATWOOT_LIVE_VERIFIED` ≠ `true` | `NOT_CONFIGURED` / `CHATWOOT_LIVE_VERIFICATION_REQUIRED` |
| all valid **and** `QEYNOX_CHATWOOT_LIVE_VERIFIED=true` | `CONFIGURED` |

`QEYNOX_CHATWOOT_LIVE_VERIFIED` must only be set by an operator **after** the [live verification](#live-verification) checklist below has been executed against the real instance. Setting it against a guessed or fixture configuration is a deliberate falsehood, not a workaround, and audits will not corroborate it.

`inboxConfigured: true` and `webhooksRequired: false` are reported when credentials are present: QeyNox reads conversations live and does not use Chatwoot webhooks.

## Documented remote contract (verified against the Chatwoot source, branch `develop`)

- Conversation create: `POST /api/v1/accounts/{accountId}/conversations` with `inbox_id`, `contact_id`, `source_id`, `status`. When both ids are present, Chatwoot builds the contact-inbox through `ContactInboxBuilder` (`first_or_create!` on `(contact_id, inbox_id, source_id)`, with a race retry), so a retried create converges instead of duplicating — **for the same contact**.
- Message create: `POST .../conversations/{displayId}/messages` passes `source_id` straight into `messages.source_id` (indexed). Retried sends with the same `source_id` are therefore detectable by reading history.
- Routes use Chatwoot's `display_id` (the owner-facing conversation number), which is what normalization reports as the conversation id. `json.id` is the display id.
- List: `GET .../conversations` honours `status` (default `open`; `all` disables the filter), `assignee_type`, `page`, and `source_id` (`filter_by_source_id`, joining contact_inboxes). Response envelope: `{ data: { meta: { all_count, ... }, payload: [...] } }`, 25 per page.
- Messages: `message_type` enum `incoming=0, outgoing=1, activity=2, template=3`. The customer view carries only `private === false` **and** type `incoming`/`outgoing`. **A message whose `private` flag is not exactly `false` is treated as private** — unknown visibility is never shown to a customer.
- `toggle_status` answers with an empty body; callers re-read the conversation for the authoritative state.
- Contacts have `identifier` (string, unique per account-scoped create); QeyNox uses the deterministic identifier `qeynox:{userId}:{workspaceId}` and searches it via `/contacts/search?q=` for reconciliation. Search is substring-based, so the adapter filters to exact-identifier matches and picks the lowest id on duplicates.
- Chatwoot offers **no remote idempotency guarantee**. A timeout or 5xx means *outcome unknown*, not *failed*. The design never blindly retries a write whose outcome is ambiguous.

## Reconciliation state machine

Every open request runs this sequence (`SupportService.open`):

1. **Intent first.** A `support_intents` row is inserted before any remote write, keyed by `(workspace_id, user_id, intent_ref)` where `intent_ref` is the client's `requestId` (the first-party UIs send a per-form-render UUID; API callers may send their own 8–200 char key). A duplicate key means "twin request": the twin waits up to 1.5 s for the in-flight request and, once it is `LINKED`, replays its result — no second remote write.
2. **Contact resolution.** Reuse the ACTIVE link's contact, else search the deterministic identifier, else create. An ambiguous create (network/5xx) is reconciled once by re-searching the identifier; failure marks the intent `FAILED` (`CONTACT_AMBIGUOUS`).
3. **Conversation resolution.** Before creating anything, adopt: `findConversationsBySourceId(intent_ref)` **filtered to the tenant's contact** — adoption never crosses tenants. Zero match → create (Chatwoot then dedupes the contact-inbox on `(contact, inbox, source_id)`). One match → adopt. Several matches (same tenant, same contact) → adopt the lowest display id deterministically and record `DUPLICATE_CONVERSATIONS_DETECTED` on the intent.
4. **Link + LINKED in one transaction.** The authorization link and the `LINKED` transition commit atomically (`createLink`).
5. **First message** carries `source_id = {intent_ref}:first`. Ambiguous send → look for `source_id` in history (adopt) → else one bounded retry → else mark `MESSAGE_AMBIGUOUS` and throw `UNKNOWN_OUTCOME` with a message telling the operator the conversation was kept and linked. Never a silent duplicate.

Replies carry `source_id = reply:{requestId}` / `agent-reply:{requestId}` with the same history-check-then-bounded-retry semantics (operator replies also write an audit row; a deduplicated replay is audited as `SUCCESS` with `deduplicated: true`).

## Orphaned and duplicate links

- **Orphan:** `getConversation` returning 404 marks the link `ORPHANED` (`state` on `support_chatwoot_links`). An orphaned link authorizes nothing on any customer surface.
- **Duplicate:** one remote conversation mapped to more than one distinct `(user_id, workspace_id)` pair is an isolation breach. It is detected (`findDuplicatedConversationIds`) and both sides fail closed: customers get `CONFLICT`, the operator list hides the conversation and writes a `DENIED`/`DUPLICATE_LINK_DETECTED` audit row naming the offending ids, and operator read/reply/status on it are refused with `CONFLICT` until an operator remediates (see runbook).
- **Duplicate conversations** (same `source_id`, same contact) are adopted earliest-first and flagged on the intent; nothing is linked to the extra conversation. Drift that produced contact-level or cross-contact duplicates (e.g. twin creates that both landed before either could reconcile) leaves conversations untracked in Chatwoot; discovery and cleanup belong to the operator runbook below — QeyNox never auto-deletes remote data.

## Isolation model

- Customer routes (`/v1/support/*`): every conversation is reached only through the caller's `(userId, workspaceId)` ACTIVE link. Another tenant's `requestId`, conversation id or contact id is worthless — intent scoping and contact-scoped adoption make cross-tenant replay/adoption impossible (regression-tested in `qa-chatwoot-http.ts` and `qa-support-reconciliation.ts`).
- Platform routes (`/v1/platform/support/*`): require the existing `SUPPORT` permission; every mutation (`REPLY_SUPPORT_CONVERSATION`, `UPDATE_SUPPORT_STATUS`) requires a 10–500 character justification, is audited (`SUCCESS`/`ERROR`/`DENIED`, with justification in `detail`), and deduplicates retries carrying the same `requestId`. Schema-rejected input is audited too (`INVALID_INPUT`). These routes are the only ones that may see private notes.
- The customer view filters to `private === false` chat messages. Operator views include private notes. Notes are never persisted by QeyNox, so this is a read-time filter, not a storage boundary.
- The Chatwoot API token is server-only; browsers and Server Actions never see it.

## Status transitions, pagination, direction

- Operator status filter (`open`|`pending`|`resolved`|`snoozed`|`all`) is passed to Chatwoot; `all` disables the remote filter. The operator list is paginated (`page`, 25/page, `hasMore` from `meta.all_count`).
- `toggle_status` returns no body: after a transition the API re-reads the conversation and audits the re-read state.
- Direction is enforced end-to-end: customer → `incoming`, operator → `outgoing`; the HTTP-level suites assert request bodies and remote state.

## Failure semantics

| Situation | API outcome |
|---|---|
| credentials missing/invalid | `503 NOT_CONFIGURED` |
| credentials valid, live verification not done | `503 NOT_CONFIGURED` (`CHATWOOT_LIVE_VERIFICATION_REQUIRED`) |
| Chatwoot reachable, remote 4xx | `502 UNAVAILABLE` (never retried blindly) |
| Chatwoot timeout / network / 5xx | `409 UNKNOWN_OUTCOME` — reconciled via `source_id`; client/operator must not re-send blindly |
| remote conversation 404 | customer: `404 NOT_FOUND` + link marked `ORPHANED`; operator: `404 NOT_FOUND` (+ orphan marking) |
| ambiguous mapping (duplicate links) | `409 CONFLICT` everywhere, `DUPLICATE_LINK_DETECTED` audit row |

## QA evidence (all against fixtures / disposable PostgreSQL — never a live Chatwoot)

| Suite | Proves |
|---|---|
| `pnpm qa:chatwoot` | Wire contract vs fixture: capability gate, envelopes, pagination, direction, private notes, idempotent replay, ambiguous create/send self-healing, cross-tenant non-adoption, 404→null. 42 assertions. |
| `pnpm qa:support-concurrency` | Double-click/twin-request opens converge: one conversation, one message, one link — including lost-response cases. 11 assertions. |
| `pnpm qa:support-isolation` | Link scoping, orphan rules, duplicate fail-closed, direction, outage propagation. |
| `pnpm qa:support-private` | Customer private-note/activity/template non-disclosure. |
| `pnpm qa:support-reconciliation` | Real migrations + store against disposable PostgreSQL: intent lifecycle, link transaction, orphan marking, duplicate fail-closed + DENIED audit, audited operator actions, cross-tenant requestId isolation. 33 assertions. |

These suites never touch the network beyond the in-process fixture and never claim the live integration works.

## Known limitations

- A twin request racing the winning create beyond the 1.5 s head start can still produce a remote conversation that then fails adoption (or a cross-contact duplicate); QeyNox links the earliest deterministic candidate when possible and otherwise leaves the extra conversation untracked. Detection is by operator audit (`DUPLICATE_CONVERSATIONS_DETECTED`, link duplication checks); cleanup is manual in Chatwoot. QeyNox never deletes remote data automatically.
- The 10 s fetch timeout bounds each remote call; a stalled Chatwoot surfaces as `UNKNOWN_OUTCOME`, honest but potentially confusing to end users.
- Pagination is Chatwoot's 25/page; deep history of a single conversation is returned by Chatwoot's message endpoint in its own window.

## Live verification

**Required before `QEYNOX_CHATWOOT_LIVE_VERIFIED=true` is set anywhere.** Perform against a staging/test Chatwoot account with its own inbox, created for this check; production verification should follow the same steps once staging passes. Never verify against production data.

1. **Prerequisites.** A reachable HTTPS Chatwoot (API and app). An agency/agent API token with access to one dedicated inbox. Numeric account id and inbox id. Note them; do not paste them into this repository.
2. **Provision a test contact and empty inbox state.** Create one throwaway customer account + workspace in QeyNox staging. Ensure the Chatwoot inbox contains no production conversations.
3. **Configure and restart.** Set `QEYNOX_CHATWOOT_BASE_URL`, `QEYNOX_CHATWOOT_API_TOKEN`, `QEYNOX_CHATWOOT_ACCOUNT_ID`, `QEYNOX_CHATWOOT_INBOX_ID` on the staging API. Leave `QEYNOX_CHATWOOT_LIVE_VERIFIED` unset. Restart the API.
4. **Confirm the fail-closed gate.** `GET /v1/support/status` → `{ status: 'NOT_CONFIGURED', reason: 'CHATWOOT_LIVE_VERIFICATION_REQUIRED' }`. Any support action → `503 NOT_CONFIGURED`. Operator center likewise.
5. **Set `QEYNOX_CHATWOOT_LIVE_VERIFIED=true`**, restart, and confirm `{ status: 'CONFIGURED' }`.
6. **Customer journey.** From the Web UI as the test customer: open a conversation with a unique marker sentence (e.g. `qa-live-<date>`). Verify: a contact with identifier `qeynox:{userId}:{workspaceId}` exists in Chatwoot; one conversation in the inbox with `source_id` equal to the sent requestId (inspect via the Chatwoot console or API with your token); the message is `incoming`. Re-submit the same form (same idempotency key) and confirm **no** second conversation/message appears.
7. **Operator journey.** From the Control UI as an operator with the SUPPORT permission: filter `open`, open the thread, reply once with a justification (≥10 chars) — confirm `outgoing` in Chatwoot and an `REPLY_SUPPORT_CONVERSATION` SUCCESS row in the platform audit; set status `pending`, then `resolved` — confirm Chatwoot reflects it and `UPDATE_SUPPORT_STATUS` SUCCESS audit rows exist. Reply *without* the justification and with 9 chars — confirm `400 INVALID_INPUT` and a denied-input audit row. With an operator lacking SUPPORT — confirm `403 DENIED` and a DENIED audit row.
8. **Isolation probes.** As a second customer, confirm `/v1/support/conversations/{foreignId}` → `404`. Confirm the second customer's identical `requestId` opens an independent conversation, not a replay of the first.
9. **Resilience drill (strongly recommended).** On the staging API, temporarily block egress to Chatwoot after one conversation is created (firewall rule or a proxy that drops responses for `POST /conversations`), submit a new customer request, and verify the API reports `409 UNKNOWN_OUTCOME` and that after unblocking, re-sending the same request adopts the orphaned conversation rather than creating a duplicate. Revert the block. Record the outcome.
10. **Private notes.** Post a private note as an operator in Chatwoot; confirm it is visible in the Control thread and absent from the customer thread.
11. **Cleanup.** Delete the test conversations/contact/inbox from Chatwoot; delete the QA intents/links from the staging database (`DELETE FROM support_intents WHERE intent_ref LIKE 'qa-live-%';` likewise `support_chatwoot_links`) only if the staging inbox is otherwise disposable. Revoke the API token used for verification. Record who ran each step, when, and the observed ids in the change record for this capability.
12. **Only then** keep `QEYNOX_CHATWOOT_LIVE_VERIFIED=true` for that environment and note it in the release notes for the capability. The capability is still not a guarantee of exactly-once delivery — see *Known limitations*.

**Rollback.** Set `QEYNOX_CHATWOOT_LIVE_VERIFIED=false` (or unset) and restart: every support surface returns `NOT_CONFIGURED` immediately; mappings and intents are preserved for a later re-enable.

**Operator remediation runbook (duplicate/orphan mappings).** If `DUPLICATE_LINK_DETECTED` audit rows appear: identify the conversation id in the audit detail; in Chatwoot, determine the correct conversation and close/merge the other; then have a DBA set the superseded `support_chatwoot_links.state` to `ORPHANED` (it authorizes nothing afterwards) or correct the mapping; re-run the operator list and confirm the conversation reappears or stays hidden consistently. Never edit Chatwoot ids by hand inside automation.
