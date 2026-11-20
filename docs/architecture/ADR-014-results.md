# ADR-014 — Results are stable versioned objects

Each ResultDocument carries objective, findings with claim IDs, attempt provenance, citations, unresolved items and a quality state independent of chat history. DRAFT and PARTIAL are never automatically DELIVERABLE; READY_FOR_REVIEW still requires explicit acceptance. Revisions append documents, never mutate earlier versions.

CITATIONS: each finding carries citations resolved from its linked sources (provider, http(s) URI, retrieval time, publication date when known and captured response digest). A SUPPORTED claim without a verifiable citation is treated as unresolved for deliverable purposes; the assembler never marks such a document READY_FOR_REVIEW.

REVIEW/DELIVERY: delivery requires an operation in WAITING_APPROVAL, a READY_FOR_REVIEW document for the current revision, a specific APPROVED RESULT_REVIEW approval, all referenced claims currently SUPPORTED, an authorized/explicitly-free commercial order and a verifiable citation for every finding. Delivery appends a new immutable DELIVERABLE document version (prior version retained as READY_FOR_REVIEW), records reviewer identity/time, sets the order DELIVERED, transitions the operation to COMPLETED and emits RESULT_DELIVERED.

EXPORTS: JSON is canonical (sorted keys) so re-exports are byte-stable across storage round-trips; HTML escapes all untrusted content and renders citations as links only for http(s) URIs. Reconciliation regenerates only deterministic exports whose SHA-256 still matches the recorded artifact metadata; existing objects with a different digest are never overwritten and storage failures leave PENDING_UPLOAD for a later safe retry. S3-compatible storage remains private and uses unique workspace/operation/result IDs, SHA-256 digests and short-lived signed read grants. Artifact metadata is inserted as PENDING_UPLOAD before upload; only a digest-verified upload becomes AVAILABLE. A storage failure leaves PENDING_UPLOAD metadata for reconciliation and must never be presented as AVAILABLE.

No PDF/audio renderer is configured. Isolated QA verified the storage contract against a real MinIO service (private bucket, SHA-256 metadata, signed download expiry, tenant isolation, failed-upload recovery) and verified the fail-closed unconfigured path. Production object storage, bucket policy, encryption/KMS and lifecycle are NOT configured or certified; SSE-S3 is the default and an S3-compatible QA store may explicitly opt out.


## A07 amendment — Atlas reading order, one classifier, real PDF export

The customer-facing result is now the *Atlas reader* on the existing route
`/[lang]/missions/[id]/results/[documentId]`. No new application was created: the route, the
`ResultDocument` contract and the artifact delivery path are unchanged, and the reader is a
presentation of the same persisted document.

CLASSIFICATION IS DERIVED, NEVER STORED. `packages/application/src/result-classification.ts` maps a
finding status to exactly one of `VERIFIED`, `AI_INTERPRETATION`, `UNRESOLVED`,
`AWAITING_ASSESSMENT`. It is the single implementation used by the API view, the HTML export, the PDF
export and the reader, so the screen and the downloaded artefact cannot disagree. Two properties are
load-bearing:

- it can only **demote**. A `SUPPORTED` finding whose citations contain no verifiable http(s) URI
  (or whose URIs carry embedded credentials) becomes `UNRESOLVED` with blocker
  `NO_VERIFIABLE_CITATION`. Nothing is ever promoted by classification; promotion to a conclusion
  requires the human review and delivery flow in the preceding section.
- it is **total**. An unknown future status falls back to `AWAITING_ASSESSMENT`, never to verified.

`AWAITING_ASSESSMENT` (`UNVERIFIED`) is a claim, not a finding, and is never rendered inside the
verified section. The derived document verdict is stated once, per document, from
`documentVerdict()`; a document that is not `DELIVERABLE` cannot produce a reviewed-conclusion
sentence, and a `DELIVERABLE` document with no verified finding says so explicitly rather than
showing an empty list.

SURFACES. `GET /v1/operations/:operationId/documents/:documentId/atlas` returns the derived
classification (`counts`, `deliverable`, `verdict` and the four finding groups) for the same
tenant-guarded document the existing read returns. The reader renders verdict → scope → verified →
unresolved → awaiting assessment → AI interpretation → limitations → provenance → review/version, with
provenance and review always present even when empty. Class identity is carried by a heading and a
text label, never by colour alone, so it survives high-contrast mode, greyscale printing and a screen
reader.

EXPORTS ARE NOW THREE. `POST .../export/{json|html|pdf}`. JSON stays canonical and byte-stable because
artifact reconciliation re-derives and digest-compares it. HTML stays self-contained and printable.
PDF is generated with `pdf-lib`, pinned metadata (fixed title/producer/creator, no timestamps, no
random ids, standard fonts, `useObjectStreams:false`) so it is deterministic and `reconcilePending`
can safely re-derive `application/pdf` artifacts too.

Two PDF-specific constraints are documented rather than hidden:

- The standard PDF fonts can only encode WinAnsi. Text outside it (Greek, CJK, emoji) is replaced by
  `?`, counted, and disclosed on the exported page ("Encoding notice: N characters could not be
  rendered…"). The HTML and JSON exports always carry the exact original text. The export never
  throws and never silently drops content.
- Embedded credentials in a citation URI are redacted everywhere they are displayed (reader, HTML,
  PDF), and such a URI is never made clickable.

NOT CERTIFIED. These checks ran against generators and an isolated database, not a browser or a PDF
viewer. PDF visual fidelity, print pagination, signed-URL expiry against a real S3 endpoint and
production object storage remain NOT VERIFIED; `qa:storage` stays BLOCKED in this environment.
