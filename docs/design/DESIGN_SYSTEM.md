# QeyNox — Design System
## Professional Blue / « Professionnel & Efficace »

**Version:** 1.0 · **Status:** approved visual direction / implementation contract · **Date:** 2026-11-11  
**Canonical repository location:** `docs/design/DESIGN_SYSTEM.md`  
**Visual reference:** `docs/design/reference/concept-02-professional-blue.png` (source image pending repository import; see `docs/design/reference/README.md`)  
**Applies to:** marketing site, authenticated MyDash, Soul, Pilot, Missions, Results, Library, settings and operator interfaces.  
**Scope boundary:** this document specifies the *design*, not proof that those screens or backend capabilities already exist.

> **NON-NEGOTIABLE FOR CODING AGENTS:** Read this file before implementing or modifying UI. Follow the declared tokens, components, layouts and interaction states. Never substitute a generic dashboard template, introduce a competing visual language, or invent successful business results. If an existing code/API constraint conflicts with a design detail, preserve the business truth, document the conflict, and adapt the presentation without silently inventing functionality.

---

## 1. Source of truth and interpretation

1. Product/architecture/security rules and real API contracts control **behavior and data**.
2. This file controls **visual design and interaction consistency**.
3. The supplied reference image controls **visual mood, composition and hierarchy**, not content accuracy or existing feature scope.
4. Existing reusable code is preferred where it respects this contract; do not rewrite validated backend services to fit an illustration.
5. Use the **center, blue, selected Concept 2** at the top of the reference image and the **large blue QeyNox application view below**. The light Concept 1 and violet/dark Concept 3 are alternatives, **not** approved themes.

### Core design idea

**Professional familiarity + premium execution + evidence-backed outcomes.**

QeyNox should feel as immediately understandable as a familiar professional platform, yet visibly distinct from LinkedIn and ordinary AI chat products. Users arrive with a business intention, start a mission, follow work at the right abstraction level, and inspect a source-backed deliverable. No feed is required for the core product.

**Five principles**

- **Results first:** outcome, next action and source-backed deliverables dominate the screen; technical agents stay behind the experience.
- **Trust by evidence:** provenance, review status, approvals and uncertainty are easy to inspect.
- **Familiar, never copied:** recognizable sidebar/cards/tables, without copying LinkedIn's layouts, icons, brand blue or engagement mechanics.
- **Progressive disclosure:** first show what matters; reveal workflows, budgets and evidence in detail only when requested.
- **Quiet precision:** disciplined spacing and typography; saturated blue is concentrated in navigation, hero and primary actions.

---

## 2. Visual decomposition of the reference

| Area | What the approved image shows | Implementation rule |
|---|---|---|
| Identity | Blue geometric **Q** symbol + white QeyNox wordmark | Use one consistent mark/wordmark across sidebar, landing and mobile header. Treat the mockup symbol as a concept, not a trademark-ready vector asset. |
| Desktop sidebar | Persistent deep-navy column, left-aligned line icons, blue active pill | Fixed 264–280 px width, clear active state, separators and restrained utility callout at bottom. |
| Hero | Wide cobalt/royal-blue gradient, large white headline, subtle wave/light accents, stacked document illustration | Preserve strong visual identity; hero artwork is decorative and must not contain fabricated data or claim real deliverables. |
| Primary CTA | High-contrast white rounded action on the blue hero | Main action is **Start a mission**; exactly one dominant CTA per screen. |
| Work surface | Cool white/blue-gray canvas separated from the hero with a soft rounded top edge | Surfaces remain light even though sidebar and hero are dark blue. |
| Quick missions | Four concise action cards with pale icon squares | Render only configured/available capabilities; do not hardcode the sample names as the eight business skills. |
| Recent missions | Compact table of mission name, type, status, date and contextual action | Real API data and real statuses only; useful empty, loading, error and blocked states. |
| Tone | Clear, reassuring professional B2B styling; crisp text and precise alignments | No heavy sci-fi effects, purple neon, stock-photo clutter or excessive analytics widgets. |

**Visual hierarchy:** brand/nav → user objective and CTA → available missions → recent work → inspectable results and evidence.  
**Reference text is sample copy, not approved business proof.** Screenshots showing finished missions, KPIs or customer outcomes are illustrative only.

---

## 3. Brand colors and semantic tokens

Values below are **normalized implementation tokens derived from the reference image**, not claims of exact original source values. All new UI must use semantic tokens rather than scattered hex literals.

### Foundation palette

| Token | Hex | Meaning |
|---|---|---|
| `navy-950` | `#051231` | Sidebar base, darkest surfaces |
| `navy-900` | `#071B43` | Deep hero/nav gradient |
| `navy-800` | `#0B2866` | Secondary navy |
| `blue-800` | `#153B91` | Selected sidebar states |
| `blue-700` | `#0C43BA` | Strong blue |
| `blue-600` | `#1054F6` | Primary action, focus, brand accent |
| `blue-500` | `#1873F8` | Active/interactive blue |
| `blue-400` | `#2491F4` | Hero glow/secondary accent |
| `blue-100` | `#DFEAFE` | Selected backgrounds and badges |
| `blue-50` | `#EEF5FF` | Icon backgrounds, subtle fills |
| `canvas` | `#F2F5FC` | Main app background |
| `surface` | `#FFFFFF` | Panels/cards/dialogs |
| `surface-soft` | `#F9FAFD` | Quiet card backgrounds |
| `ink` | `#080C1F` | Primary text on light background |
| `text-secondary` | `#485673` | Secondary text |
| `text-muted` | `#69758F` | Tertiary labels, metadata |
| `border` | `#D8E3F5` | Card/field separators |
| `success-700` | `#087251` | Verified/completed **when backend confirms** |
| `success-100` | `#DDF5E9` | Success background |
| `warning-700` | `#986500` | Pending/needs attention |
| `warning-100` | `#FFF2CD` | Warning background |
| `danger-700` | `#B42332` | Errors/denied |
| `danger-100` | `#FDE8EA` | Error background |

### CSS variables — canonical starter tokens

```css
:root {
  --qx-navy-950: #051231;
  --qx-navy-900: #071b43;
  --qx-navy-800: #0b2866;
  --qx-blue-800: #153b91;
  --qx-blue-700: #0c43ba;
  --qx-blue-600: #1054f6;
  --qx-blue-500: #1873f8;
  --qx-blue-400: #2491f4;
  --qx-blue-100: #dfeafe;
  --qx-blue-50: #eef5ff;
  --qx-canvas: #f2f5fc;
  --qx-surface: #ffffff;
  --qx-surface-soft: #f9fafd;
  --qx-ink: #080c1f;
  --qx-text-secondary: #485673;
  --qx-text-muted: #69758f;
  --qx-border: #d8e3f5;
  --qx-success: #087251;
  --qx-success-bg: #ddf5e9;
  --qx-warning: #986500;
  --qx-warning-bg: #fff2cd;
  --qx-danger: #b42332;
  --qx-danger-bg: #fde8ea;

  --qx-hero-gradient: linear-gradient(118deg, #071b43 0%, #0643b3 53%, #1873f8 100%);
  --qx-nav-gradient: linear-gradient(180deg, #051231 0%, #071b43 100%);
  --qx-radius-sm: 8px;
  --qx-radius-md: 12px;
  --qx-radius-lg: 16px;
  --qx-radius-xl: 22px;
  --qx-radius-pill: 999px;
  --qx-shadow-card: 0 5px 18px rgba(16, 43, 96, .055);
  --qx-shadow-float: 0 16px 40px rgba(5, 18, 49, .14);
  --qx-focus: 0 0 0 3px rgba(16, 84, 246, .28);
  --qx-ease: cubic-bezier(.2, .8, .2, 1);
}
```

### Color placement rules

- Navy: **sidebar, top hero and brand areas**, not every card.
- Cobalt: **primary actions and active states**, not every label.
- Canvas: full workspace background; white cards sit on top.
- White text belongs on dark navy / blue areas only; dark ink on cards.
- Gradient only for purposeful hero or small branded promotional blocks; **never as a background for data tables**.
- Do not rely on color alone for statuses: always show a label and accessible text/icon.
- Check real text/background pairs for WCAG AA; adjust accessible shades where necessary rather than insisting on an unsafe contrast pair.

---

## 4. Typography and content rhythm

**Primary UI font:** `Inter`, fallback `ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif`. Use a legitimately loaded font through the app framework, with system fallback; **do not ship third-party font binaries without rights**.

| Style | Desktop | Mobile | Weight / line height |
|---|---|---|---|
| Display / hero | 40–44 px | 30–34 px | 750–800 / 1.12 |
| Page H1 | 30–34 px | 26–28 px | 700 / 1.2 |
| Section H2 | 20–24 px | 18–21 px | 700 / 1.3 |
| Card title | 15–17 px | 15–16 px | 650–700 / 1.35 |
| Body | 14–16 px | 14–16 px | 400–500 / 1.55 |
| Label / field | 13–14 px | 13–14 px | 550–600 / 1.4 |
| Metadata | 12–13 px | 12–13 px | 450–500 / 1.45 |

- Use sentence case. Avoid ALL CAPS on long labels.
- Prefer 55–70 characters per line in long-form content.
- Do not reduce important body text below 14 px to make a mockup fit.
- Use tabular numerals for dates, money, progress and statuses where appropriate.
- Headings carry meaning. Do not use decorative headings to fill space.

---

## 5. Layout, breakpoints and spacing

### Desktop application shell

```text
┌──────────── Sidebar 272 px ────────────┬──────────── Content flex ───────────────────┐
│ Wordmark / identity                    │ Hero: user objective + single primary CTA  │
│                                        │                                           │
│ Active navigation                      │ White/blue-gray rounded workspace surface  │
│ Mission / Results / Library            │ Section: available missions / capabilities│
│                                        │ Section: recent missions + statuses       │
│ Utility / account                      │ Contextual guidance, sources, next action  │
└────────────────────────────────────────┴───────────────────────────────────────────┘
```

- Sidebar: `272px` target, acceptable `264–280px`; fixed on large screens, scrollable inner region.
- Main workspace: fluid width; content padding `32–40px` desktop, `24px` tablet, `16px` mobile.
- Hero: approximately `260–320px` on desktop; responsive content-driven height on mobile.
- Main panels: `16–22px` corner radii; flat/light surfaces with very subtle shadow.
- Main quick-action cards: `repeat(4, minmax(0, 1fr))` only when width supports legible text; otherwise 2 or 1 columns.
- Component gap: 16–20 px; section gap 24–32 px; page gap 32–40 px.
- 8 px spacing foundation: `4 / 8 / 12 / 16 / 24 / 32 / 40 / 48 / 64`.
- Do not force equal heights if cards contain different amounts of essential content; accommodate text wrapping.
- Avoid fixed-height application content panels that clip results or citations.

### Breakpoints / responsive behavior

| Range | Navigation | Cards | Recent missions |
|---|---|---|---|
| `>=1280px` | Persistent 272 px left sidebar | 4 columns where space allows | Table |
| `1024–1279px` | Persistent or collapsible 240 px sidebar | 2 columns | Responsive table |
| `768–1023px` | Collapsed rail or accessible drawer | 2 columns | Simplified table/cards |
| `<768px` | Top bar + accessible slide-out menu | 1 column | Stacked mission cards |

Mobile rules: keep the main CTA visible without horizontal scroll; truncate nothing critical; no hover-only actions; minimum 44×44 px tap targets; dialogs fit viewport; charts and tables offer accessible alternatives.

---

## 6. Component specifications

### Navigation

- Deep-navy background, 16–18 px horizontal padding.
- Wordmark at top with generous breathing room.
- Simple outline icon + short text, aligned on one baseline.
- Selected row: dark royal-blue pill, white icon/text, subtle lighter edge.
- Inactive rows: pale text, clear focus/hover treatment.
- Product-level labels favor **Missions**, **Results**, **Library**, **Capabilities**; Soul/Pilot can be contextual assistants, not a gallery of autonomous bots.
- Avoid exposing workflow engine implementation details in customer navigation.

### Hero / page intro

- Deep-to-electric-blue layered gradient.
- White one- or two-line promise, supporting copy, **one white primary CTA** with blue text.
- Abstract light trails and document-stack illustration may be recreated as restrained CSS/SVG illustration; illustration must not masquerade as an actual user result.
- Limit decorative effects to preserve readability and performance.
- Authenticated MyDash hero is task-oriented, **not a repetitive marketing billboard on every subpage**.

### Buttons

| Variant | Treatment | Use |
|---|---|---|
| Primary on hero | White fill, blue label/icon, 12–14 px radius | Start a mission |
| Primary on light | `blue-600` fill, white label, 12 px radius | Confirm significant action |
| Secondary | White fill, blue text, border | View result / browse options |
| Tertiary | Text + icon, no heavy container | Low emphasis navigation |
| Destructive | Danger accent, explicit confirmation | Irreversible actions |

Heights: `44px` standard, `48px` important CTA, `36px` compact only in dense desktop tables. Disabled state must explain why when context requires it. Loading state keeps label semantics and prevents duplicate submission.

### Cards / quick missions

- White surface on canvas, 1 px cool border, 12–16 px radius, minimal shadow.
- Light-blue icon tile (40–48 px), cobalt outline icon, title, one-line purpose.
- Clear focus/hover states; entire card may be clickable if semantic HTML supports it.
- No nested interactive controls inside another clickable control.
- A quick mission launches a **real configured capability** or clearly states why unavailable.

### Missions list / table

Columns on desktop: `Mission · Capability/type · Status · Updated · Action`.  
Rows: 56–64 px minimum, subtle dividers, readable names, understated action button.  
Use server-side status text, dates and links. Pagination or progressive loading for larger lists.  
On mobile use named field/value rows in stacked cards, not squeezed 5-column tables.

### Status tags

- Neutral: draft / unknown / not configured.
- Blue: queued / running / progress.
- Amber: needs review / waiting approval / pending upload.
- Green: completed / supported / available **only after backend evidence**.
- Red: failed / denied / conflicting.
- Do not equate mission `COMPLETED` with demonstrated business growth or financial ROI.
- Surface API-level state and provenance uncertainty honestly.

### Forms and conversational input

- Minimal grouped fields with useful examples; max 600–720 px wide for complex forms.
- Soul onboarding collects intention and consent progressively.
- Pilot provides the next useful decision or approval, not an unexplained swarm visualization.
- Form errors are actionable, associated with fields and announced accessibly.
- Sensitive consent is explicit and revocable; no implied opt-in.

### Results, evidence and exports

- Every claim card shows a status and a route to inspect sources.
- Source detail contains provider, URL, retrieval date, publication date if known, response fingerprint/digest when appropriate, and review limitations.
- Unverified/partial/draft findings are visually distinct from supported findings.
- An export is `AVAILABLE` only if the storage backend confirms it; `PENDING_UPLOAD` never looks downloadable.
- No fabricated testimonials, percentages, savings, success rates, verified badges or client logos.

### Feedback / overlays

- Skeletons mirror the actual layout, without pretending to be real data.
- Toasts for transient actions only; persistent failures remain visible in context.
- Dialogs require focus trapping, accessible names and keyboard dismissal when safe.
- Confirmation step before destructive or paid actions.

---

## 7. Product pages and visual consistency

These are **design targets**, not claims that routes currently exist. Final route names follow verified backend and frontend architecture.

| Surface | Main job | Required visual pattern |
|---|---|---|
| Public landing | Explain RaaS and build trust | Blue hero + clear proof policy + real examples only |
| MyDash | Resume work and start next mission | Blue intro, configurable action cards, real recent missions |
| Soul | Define goal and consented context | Focused guided conversation/form; no overwhelming dashboard |
| Capabilities | Discover available services | Filterable cards; show inactive/unconfigured states honestly |
| Mission detail | Inspect plan, execution and approvals | Clear stepper/timeline, next action, failures/retries |
| Pilot | Guide choices and interventions | Contextual decision card or workspace panel |
| Results | Review claims, citations and downloadable files | Structured document layout and evidence drawer |
| Library | Retrieve historical deliverables | Search, sort, filters, provenance summary |
| Account / privacy | Manage identity, settings and consent | Plain forms, explicit privacy states |
| Operator | Configure profiles, budgets, tools and policies | Same tokens; denser information permitted, separate permissions |

**Recommended default dashboard anatomy:** short greeting → objective/primary mission CTA → available capabilities → recent missions → relevant recent result, *if real*. Do not add fabricated KPI strips, social proof or activity feeds to fill unused space.

---

## 8. Accessibility, motion and internationalization

- Target WCAG **2.2 AA**: 4.5:1 normal text; 3:1 large text and component boundaries where applicable.
- Every action works with keyboard and screen reader; visible focus ring.
- Semantic landmarks (`nav`, `main`, `section`, headings in order), labeled fields and useful status announcements.
- Respect `prefers-reduced-motion` and `prefers-contrast` where available.
- Motion: 120–180 ms for hover/focus, 180–240 ms for drawers/dialogs; no constant floating effects or parallax essential to comprehension.
- Do not use color, animation or icons as the only way to communicate state.
- **International product:** design with EN and FR from the start; never hardcode UI copy in component logic. Follow repository language/product decisions for default locale. Strings must expand by ~30% without clipping. Keep date/number/currency formats locale-aware.
- Do not turn an illustration's French copy into hardcoded backend logic or pricing.

---

## 9. Frontend engineering contract

1. Inspect actual repo first. Choose Next.js/React implementation only according to the current frontend architecture; do not invent a second app or design framework.
2. Define a single token layer (CSS variables, optionally mirrored into Tailwind/theme config); no unexplained hardcoded color values in individual components.
3. Create reusable primitives: `AppShell`, `SidebarNav`, `PageHeader`, `HeroBanner`, `Button`, `SurfaceCard`, `CapabilityCard`, `MissionList`, `StatusBadge`, `EvidenceList`, `EmptyState`, `ErrorState`, `Skeleton`.
4. Keep presentation components separate from API adapters and business state machines.
5. Use actual existing API contracts for real screens. Missing backend data must show truthful loading/empty/not-configured/blocked states.
6. Avoid introducing broad dependency suites for a small visual component. Icons may use an established Lucide-compatible library.
7. Reuse QeyNox auth, tenant, permissions and approved data flows; never bypass them for a polished demo.
8. Put mock data in dedicated visual tests/stories only, labeled **DEMO / FIXTURE**, never in real customer dashboards.
9. Keep bundle size, layout shifts and hydration errors low. Render with accessible HTML, not static screenshot-as-UI.
10. Capture visual regression screenshots against the approved image for desktop and mobile. Never claim a pixel-perfect match to an AI-generated mockup; assess hierarchy, spacing and brand consistency.

### Working guidance for coding agents

**Before coding:** Read `AGENTS.md`, this file, architecture ADRs and the relevant frontend/API paths; identify route and data availability.  
**While coding:** Build token layer → shell → primitives → one complete connected page → responsive states → remaining pages.  
**After coding:** Run typecheck/build, relevant UI tests, keyboard and contrast checks, and screenshots at `1440×900`, `1024×768`, `390×844`.  
**Report:** what was implemented, screenshot paths, checks run, remaining unsupported interfaces, and code commit SHA. Do not claim unrun tests passed.

### Definition of Done — every UI PR

- [ ] Uses approved blue/navy/white palette and CSS variables.
- [ ] Maintains professional-blue layout hierarchy; no conflicting dark-purple or neon design language.
- [ ] Components match established spacing, typography, radius and motion tokens.
- [ ] Works at desktop, tablet and phone widths without horizontal overflow.
- [ ] Accessible keyboard focus, labels, status semantics and contrast.
- [ ] No invented data, user/customer proof or unsupported feature states.
- [ ] Loading, empty, error, permission denied and blocked states covered.
- [ ] Backend contract and tenant safety preserved.
- [ ] Appropriate checks executed and evidence recorded.

---

## 10. Explicit anti-patterns

**DO NOT:**

- Clone LinkedIn's brand, news feed, profile design or engagement psychology.
- Replace MyDash with a full-page generic chatbot.
- Expose Hermes/Hatchet internal task controls as the default user experience.
- Hardcode the four sample quick missions as QeyNox's final eight skills.
- Treat illustrative blue hero documents, companies, numbers or completed missions as real.
- Invent conversion rates, ROI, citations, badges, press mentions or testimonials.
- Create global gradients on every card, massive shadows, glassmorphism everywhere or glowing borders.
- Show success/verified badges when the backend says `UNVERIFIED`, `PARTIAL`, `PENDING_UPLOAD`, `BLOCKED`, or `UNKNOWN`.
- Build additional frontend stacks or uncontrolled duplicate components.
- Introduce data tables that become unusable on mobile.

---

## 11. Instructions to add to the repository's `AGENTS.md`

Append the following short contract in the main agent instructions when this design is adopted:

```md
## Approved UI design contract
Before any web, UX or component work, read `docs/design/DESIGN_SYSTEM.md` and compare against `docs/design/reference/concept-02-professional-blue.png`. QeyNox uses the approved **Professional Blue** concept: deep-navy sidebar, high-clarity cobalt hero, light workspace surfaces, outcome-first cards and evidence-backed result UI. Use its semantic tokens, responsive rules, accessibility and Definition of Done. Never invent business data or replace backend status with cosmetic success. Resolve API/security conflicts in favor of business truth. Do not silently substitute another design language.
```

**Change control:** a new visual style, palette or navigation paradigm requires explicit product approval and an update to this document. Minor component details can evolve if they preserve the underlying system.
