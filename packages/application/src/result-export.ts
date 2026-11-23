import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { ResultCitation, ResultDocument } from './result-document';
import {
  BLOCKER_LABEL, FINDING_CLASS_LABEL, classifyDocument, documentVerdict, isVerifiableUri,
  type ClassifiedFinding, type DocumentClassification,
} from './result-classification';

/**
 * MISSION A07 — result exports.
 *
 * Three formats, one classification. JSON stays canonical and byte-stable (it is what artifact
 * reconciliation re-derives and digest-compares), HTML stays self-contained and printable, and PDF is
 * a real PDF built from the same facts.
 *
 * Hard rules enforced here, because an export is the artefact that leaves the product:
 * - an unreviewed claim is never printed as a conclusion;
 * - every finding is labelled with what it actually is;
 * - provenance, review decision and version are always present, even when empty;
 * - no source, metric or recommendation is ever synthesised.
 */

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

/** Only http(s) with no embedded credentials may become a clickable link, in HTML or in the UI. */
const safeHref = (uri?: string): string | undefined => (isVerifiableUri(uri) ? uri : undefined);

/**
 * Display form of a URI that is *not* verifiable. Embedded credentials are stripped: an export must
 * never reproduce somebody's password because a provider handed back a userinfo-bearing URL. The
 * non-verifiable marker stays, so redaction never makes a weak citation look stronger.
 */
function redactUri(uri: string): string {
  try {
    const url = new URL(uri);
    if (!url.username && !url.password) return uri;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return uri;
  }
}

function citationListHtml(citations: readonly ResultCitation[]): string {
  if (!citations.length) return '<p class="muted">No source was recorded for this finding.</p>';
  const items = citations.map(citation => {
    const href = safeHref(citation.uri);
    const target = href
      ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(href)}</a>`
      : `<span>${escapeHtml(citation.uri ? redactUri(citation.uri) : 'No citation URI recorded')} <strong>(not verifiable)</strong></span>`;
    const published = citation.publishedAt
      ? `published ${escapeHtml(citation.publishedAt)}`
      : 'publication date unknown';
    const digest = citation.fingerprint
      ? `<br><span class="digest">captured response SHA-256 ${escapeHtml(citation.fingerprint)}</span>`
      : '<br><span class="digest">no captured digest recorded</span>';
    return `<li><strong>${escapeHtml(citation.provider)}</strong> — ${target}<br><span class="meta">retrieved ${escapeHtml(citation.retrievedAt)}; ${published}</span>${digest}</li>`;
  });
  return `<ul class="citations">${items.join('')}</ul>`;
}

function findingHtml(entry: ClassifiedFinding): string {
  const { finding, findingClass, blockers } = entry;
  const blockerText = blockers.length
    ? `<p class="muted">Why this is not a conclusion: ${blockers.map(b => escapeHtml(BLOCKER_LABEL[b])).join('; ')}.</p>`
    : '';
  return [
    '<li class="finding" data-class="' + findingClass + '">',
    `<h3>${escapeHtml(finding.statement)}</h3>`,
    `<p class="label">${escapeHtml(FINDING_CLASS_LABEL[findingClass])}</p>`,
    blockerText,
    finding.limitations.length ? `<ul class="limits">${finding.limitations.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '',
    citationListHtml(finding.citations),
    '</li>',
  ].join('');
}

function sectionHtml(title: string, entries: readonly ClassifiedFinding[], empty: string): string {
  if (!entries.length) return `<section><h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(empty)}</p></section>`;
  return `<section><h2>${escapeHtml(title)}</h2><ol>${entries.map(findingHtml).join('')}</ol></section>`;
}

/** P09: business-pack synthesis is labelled AI interpretation; otherwise the classified section is used. */
function interpretationsHtml(doc: ResultDocument, classified: readonly ClassifiedFinding[]): string {
  if (!doc.interpretations?.length) return sectionHtml('AI interpretation', classified, 'No AI interpretation is recorded.');
  return `<section><h2>AI interpretation</h2><p class="muted">The agent’s own synthesis. Never evidence on its own.</p><ul>${
    doc.interpretations.map(text => `<li>${escapeHtml(text)}</li>`).join('')
  }</ul></section>`;
}

function reviewHtml(doc: ResultDocument): string {
  const reviewed = doc.reviewedAt
    ? `<p>Reviewed ${escapeHtml(doc.reviewedAt)}${doc.reviewedBy ? ` by ${escapeHtml(doc.reviewedBy)}` : ''}.</p>`
    : '<p class="muted">Not reviewed. This document has not been approved by a human.</p>';
  return `<section><h2>Review and version</h2><p>Version ${doc.version} · status ${escapeHtml(doc.status)}.</p>${reviewed}${
    doc.priorId ? `<p class="muted">Supersedes the previous version of this document.</p>` : ''
  }</section>`;
}

/**
 * Self-contained printable HTML. No external stylesheet, no network font, no script: it must render
 * identically offline and inside an e-mail attachment, and it must survive being printed to paper.
 */
export function exportHtml(doc: ResultDocument): Uint8Array {
  const classification = classifyDocument(doc);
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(doc.title)}</title>`,
    '<style>',
    'body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;margin:0;padding:32px;background:#fff}',
    'main{max-width:52rem;margin:0 auto}h1{font-size:1.7rem;line-height:1.2;margin:0 0 .3em}',
    'h2{font-size:1.15rem;margin:1.8em 0 .5em}h3{font-size:1rem;margin:0 0 .35em}',
    '.verdict{border-left:4px solid #1d4ed8;background:#eff6ff;padding:12px 16px;margin:1em 0}',
    '.label{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:#334155;margin:0 0 .5em}',
    '.muted{color:#475569}.meta,.digest{font-size:.82rem;color:#475569}',
    'ol,ul{padding-left:1.2em}li{margin:.4em 0}.finding{border-top:1px solid #e2e8f0;padding-top:1em;margin-top:1em}',
    'a{color:#1d4ed8;word-break:break-word}code{font-size:.85em}',
    '@media print{body{padding:0}a{color:#0f172a;text-decoration:none}}',
    '</style></head><body><main>',
    `<h1>${escapeHtml(doc.title)}</h1>`,
    `<p>${escapeHtml(doc.objective)}</p>`,
    `<div class="verdict"><strong>${escapeHtml(documentVerdict(doc, classification))}</strong></div>`,
    `<section><h2>Scope</h2>${doc.scope.length ? `<ul>${doc.scope.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : '<p class="muted">No scope was recorded.</p>'}</section>`,
    sectionHtml('Evidence-supported findings', classification.verified, 'No finding is evidence-supported.'),
    sectionHtml('Unresolved findings', classification.unresolved, 'No unresolved findings.'),
    sectionHtml('Awaiting assessment', classification.awaitingAssessment, 'No findings are awaiting assessment.'),
    interpretationsHtml(doc, classification.interpretations),
    `<section><h2>Limitations</h2>${doc.limitations.length ? `<ul>${doc.limitations.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '<p class="muted">No limitation was recorded.</p>'}</section>`,
    `<section><h2>Unresolved claim identifiers</h2>${doc.unresolved.length ? `<ul>${doc.unresolved.map(u => `<li><code>${escapeHtml(u)}</code></li>`).join('')}</ul>` : '<p class="muted">None.</p>'}</section>`,
    reviewHtml(doc),
    `<section><h2>All sources</h2>${citationListHtml(doc.citations)}</section>`,
    '</main></body></html>',
  ].join('');
  return Buffer.from(html, 'utf8');
}

/**
 * PDF export.
 *
 * Deterministic by construction: no creation date, no random document id, no font download. The same
 * document therefore produces the same bytes, which is what lets artifact reconciliation re-derive a
 * pending upload and compare digests instead of re-uploading blindly.
 *
 * Encoding is deliberately explicit rather than silent. The standard PDF fonts can only represent
 * WinAnsi (roughly CP1252), so text in any other script would either throw mid-export or, worse, be
 * dropped a character at a time into a document that looks complete. Instead every unrepresentable
 * character is replaced by '?' and the export states, on the page and in the text, how many
 * characters it could not render. Nothing is invented and nothing is quietly lost — the HTML and JSON
 * exports always carry the exact original text.
 */
export async function exportPdf(doc: ResultDocument): Promise<Uint8Array> {
  const classification: DocumentClassification = classifyDocument(doc);
  const pdf = await PDFDocument.create();
  // Fixed metadata: a timestamp here would make the bytes differ on every export.
  pdf.setTitle(doc.title);
  pdf.setProducer('QeyNox');
  pdf.setCreator('QeyNox');
  // pdf-lib stamps CreationDate/ModDate with wall-clock time when the document is created, and an
  // unpinned date makes every export byte-different — which silently breaks digest-based artifact
  // reconciliation (re-derivation can never match a recorded SHA-256 across a second boundary).
  // Both dates derive from the document itself so re-derivation is byte-stable.
  const pinnedDate = new Date(doc.reviewedAt ?? doc.createdAt);
  pdf.setCreationDate(Number.isFinite(pinnedDate.getTime()) ? pinnedDate : new Date(0));
  pdf.setModificationDate(Number.isFinite(pinnedDate.getTime()) ? pinnedDate : new Date(0));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  // Counted per export so the document can disclose its own limitation instead of hiding it.
  let unrenderable = 0;
  /** WinAnsi-representable text, or U+FFFD with the loss counted. Never throws, never drops silently. */
  const encodable = (value: string): string => {
    let output = '';
    for (const character of value) {
      try {
        font.widthOfTextAtSize(character, 10);
        output += character;
      } catch {
        unrenderable++;
        // '?' is the only honest substitute available: U+FFFD is itself outside WinAnsi.
        output += '?';
      }
    }
    return output;
  };
  const pageWidth = 595.28, pageHeight = 841.89, margin = 56, maxWidth = pageWidth - margin * 2;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.28, 0.33, 0.41);
  const accent = rgb(0.11, 0.31, 0.85);

  const newPage = () => { page = pdf.addPage([pageWidth, pageHeight]); y = pageHeight - margin; };
  const space = (points: number) => { y -= points; if (y < margin) newPage(); };

  /** PDF has no text wrapping: break on words, and hard-break a single overlong token. */
  const wrap = (text: string, size: number, width: number): string[] => {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) { line = candidate; continue; }
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= width) { line = word; continue; }
      // A single token wider than the page: split it by characters rather than let it overflow.
      let chunk = '';
      for (const character of word) {
        if (font.widthOfTextAtSize(chunk + character, size) > width) { lines.push(chunk); chunk = character; }
        else chunk += character;
      }
      line = chunk;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  };

  const write = (raw: string, options: { size?: number; bold?: boolean; color?: typeof ink; indent?: number; gapAfter?: number } = {}) => {
    const size = options.size ?? 10.5;
    const indent = options.indent ?? 0;
    // A line break inside a statement must not collapse the rest of the finding into one run-on line.
    const lines = raw.split(/\r?\n/).flatMap(paragraph => wrap(encodable(paragraph), size, maxWidth - indent));
    for (const line of lines) {
      // Start a new page rather than draw into the bottom margin: a line rendered below the margin is
      // invisible on paper, which would silently drop content the reader is entitled to see.
      if (y < margin + size * 1.35) newPage();
      page.drawText(line, { x: margin + indent, y, size, font: options.bold ? bold : font, color: options.color ?? ink });
      y -= size * 1.35;
    }
    if (options.gapAfter) space(options.gapAfter);
  };

  // Header + the single verdict line, always first.
  write(doc.title, { size: 17, bold: true });
  write(doc.objective, { size: 10.5, color: muted, gapAfter: 6 });
  page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 2, color: accent });
  space(14);
  write(documentVerdict(doc, classification), { size: 10.5, bold: true, color: accent, gapAfter: 4 });

  write(`Version ${doc.version} · status ${doc.status}${doc.reviewedAt ? ` · reviewed ${doc.reviewedAt}` : ' · not reviewed'}`, { size: 9, color: muted, gapAfter: 10 });

  write('Scope', { size: 12, bold: true, gapAfter: 2 });
  if (doc.scope.length) for (const item of doc.scope) write('• ' + item, { indent: 10 });
  else write('No scope was recorded.', { color: muted, indent: 10 });
  space(8);

  const section = (title: string, entries: readonly ClassifiedFinding[], empty: string) => {
    write(title, { size: 12, bold: true, gapAfter: 2 });
    if (!entries.length) { write(empty, { color: muted, indent: 10, gapAfter: 8 }); return; }
    for (const entry of entries) {
      const { finding, findingClass, blockers } = entry;
      write(finding.statement, { size: 10.5, bold: true, indent: 10 });
      write(FINDING_CLASS_LABEL[findingClass], { size: 8.5, color: muted, indent: 10 });
      if (blockers.length) write('Not a conclusion: ' + blockers.map(b => BLOCKER_LABEL[b]).join('; '), { size: 8.5, color: muted, indent: 10 });
      for (const limitation of finding.limitations) write('• ' + limitation, { size: 9, indent: 18 });
      if (!finding.citations.length) write('No source recorded for this finding.', { size: 8.5, color: muted, indent: 10 });
      for (const citation of finding.citations) {
        const uri = citation.uri ? redactUri(citation.uri) : 'no citation URI';
        write(`${citation.provider} — ${uri}${safeHref(citation.uri) ? '' : ' (not verifiable)'}`, { size: 8.5, indent: 10 });
        write(`retrieved ${citation.retrievedAt}; ${citation.publishedAt ? 'published ' + citation.publishedAt : 'publication date unknown'}`, { size: 8, color: muted, indent: 10 });
      }
      space(6);
    }
    space(2);
  };

  section('Evidence-supported findings', classification.verified, 'No finding is evidence-supported.');
  section('Unresolved findings', classification.unresolved, 'No unresolved findings.');
  section('Awaiting assessment', classification.awaitingAssessment, 'No findings are awaiting assessment.');
  if (doc.interpretations?.length) {
    // P09: business-pack synthesis is labelled as AI interpretation, never presented as a finding.
    write('AI interpretation', { size: 12, bold: true, gapAfter: 2 });
    write('The agent’s own synthesis. Never evidence on its own.', { size: 8.5, color: muted, indent: 10 });
    for (const text of doc.interpretations) write('• ' + text, { size: 10, indent: 10 });
    space(8);
  } else {
    section('AI interpretation', classification.interpretations, 'No AI interpretation is recorded.');
  }

  write('Limitations', { size: 12, bold: true, gapAfter: 2 });
  if (doc.limitations.length) for (const limitation of doc.limitations) write('• ' + limitation, { indent: 10 });
  else write('No limitation was recorded.', { color: muted, indent: 10 });
  space(8);

  write('Next actions', { size: 12, bold: true, gapAfter: 2 });
  if (doc.nextActions.length) for (const action of doc.nextActions) write('• ' + action, { indent: 10 });
  else write('No next action was recorded.', { color: muted, indent: 10 });
  space(8);

  write('All sources', { size: 12, bold: true, gapAfter: 2 });
  if (doc.citations.length) {
    for (const citation of doc.citations) {
      write(`${citation.provider} — ${citation.uri ? redactUri(citation.uri) : 'no citation URI'}`, { size: 8.5, indent: 10 });
      write(`retrieved ${citation.retrievedAt}${citation.fingerprint ? `; digest ${citation.fingerprint}` : ''}`, { size: 8, color: muted, indent: 10 });
    }
  } else write('No source was recorded.', { color: muted, indent: 10 });

  if (unrenderable > 0) {
    space(10);
    write(
      `Encoding notice: ${unrenderable} character${unrenderable === 1 ? '' : 's'} could not be rendered in this PDF's standard font and ` +
      'appear as "?". The HTML and JSON exports carry the exact original text.',
      { size: 8.5, color: muted },
    );
  }

  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalJson(record[key])]));
  }
  return value;
}

/**
 * Canonical key ordering makes JSON exports byte-stable across storage round-trips and reconciliation,
 * which is what allows a pending upload to be re-derived and digest-compared rather than re-sent.
 */
export const exportJson = (doc: ResultDocument): Uint8Array => Buffer.from(JSON.stringify(canonicalJson(doc), null, 2), 'utf8');

/** Digest used by artifact integrity checks and the QA gate. */
export const digestOf = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');
