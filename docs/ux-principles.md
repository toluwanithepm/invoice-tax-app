# UX principles

How the product applies established UX laws and guidelines. Use this as a checklist when adding screens.

References: Jon Yablonski's [Laws of UX](https://lawsofux.com), Nielsen Norman Group's usability heuristics and
progressive-disclosure guidance, WCAG 2.1 AA, and patterns from well-known financial and SaaS products
(Stripe, Mercury, Linear, Shopify Polaris, Paystack, GOV.UK's plain-language guidance).

## The audit that started the redesign

| Problem found | Principle it broke | What changed |
|---|---|---|
| 9 items in the sidebar | Hick's law, Miller's law | 5 everyday destinations; Help and Settings set apart; Import and Activity log moved into Settings |
| Tax jargon everywhere (NRS, MBS, IRN, TIN, clearance, output VAT, B2B/B2G/B2C) | Match between system and the real world | One plain-English glossary powering inline ⓘ and underlined-term explainers, plus a Help centre |
| No picture of the journey (draft → NRS → customer → paid → VAT return) | Visibility of system status | A 4-step journey indicator on every invoice; a status table in Help; a 5-screen welcome tour |
| Home didn't say what to do next | Goal-gradient effect, Zeigarnik effect | Home leads with a setup checklist + progress bar, then "Needs your attention" with one action per item |
| Status names described the system ("Submitted", "Queued") | Plain language | "Sending to NRS", "Waiting for NRS", "Approved by NRS", "Needs fixing" |
| Every invoice field visible at once | Progressive disclosure, Tesler's law | Discount column hidden until "Add a discount"; VAT treatment comes from saved products |
| "/" went straight to sign-in | Jakob's law (people expect a product page) | Public landing page with how it works, who it's for and FAQ |

## Laws and where they are applied

| Law / guideline | Where |
|---|---|
| **Hick's law** — more choices, slower decisions | Sidebar trimmed to 5 items; one primary button per screen; Retail sales only appears when switched on |
| **Miller's law** — chunk information | Invoice editor in three cards (who, what, notes); onboarding in 4 steps; tour in 5 short screens |
| **Fitts's law** — big, close targets | 44px buttons and inputs; "New invoice" always at the top of the sidebar; phone tab bar with a large central "+" in thumb reach; sticky total + Submit on phones |
| **Jakob's law** — work like products people know | Familiar invoice layout, sidebar app shell, bottom tab bar on phones, dialogs as bottom sheets on mobile |
| **Tesler's law** — complexity has to live somewhere | VAT maths, NRS validation, UBL, retries and IRNs are handled by the system, not the user |
| **Goal-gradient effect** — motivation rises near the goal | Setup checklist with progress bar ("3 of 5 done") |
| **Zeigarnik effect** — unfinished tasks are remembered | Unfinished setup steps and drafts are listed on Home |
| **Von Restorff effect** — the different thing stands out | Brand green is used almost only for primary actions and "Approved by NRS"; everything else is neutral |
| **Aesthetic-usability effect** | Inter typeface, consistent radius/spacing tokens, quiet surfaces — the app should feel trustworthy because it handles tax |
| **Doherty threshold** — respond within 400 ms | Instant local feedback: live totals as you type, autosave indicator, optimistic toasts, skeletons while loading |
| **Peak-end rule** | The best moment (NRS approval) gets a clear stamp, IRN and QR; the tour ends on "Your VAT return, done" |
| **Postel's law** — accept varied input | Phone numbers in 080… or +234 form, ₦/commas in amounts, day-first dates and "7.5%"/"Exempt" in uploaded files |
| **Law of common region / proximity** | Cards group related fields; labels sit with their controls; totals and the submit action share one card |
| **Serial position effect** | Most-used items first in the sidebar (Home, Invoices); Settings last |

## Nielsen's heuristics

1. **Visibility of system status** — journey indicator, status badges with icon + words, autosave indicator, retry countdown.
2. **Match with the real world** — glossary, plain status names, "What you're selling" instead of "Line items".
3. **User control and freedom** — tour is skippable and replayable; drafts can be discarded; firm access can be removed anytime.
4. **Consistency and standards** — one component set; one glossary; the same wording in app, PDF and emails.
5. **Error prevention** — pre-submission check, Tax ID checked as you type, duplicate customer warning, dry run before importing.
6. **Recognition rather than recall** — saved customers/products in pickers; explanations appear where the word appears.
7. **Flexibility and efficiency** — keyboard-friendly forms, saved products fill price and VAT, CSV/Excel import.
8. **Minimalist design** — only the fields needed now; advanced options on request.
9. **Help users recover from errors** — NRS rejections shown in plain English next to the field to fix.
10. **Help and documentation** — Help centre with guides, status table, glossary and FAQ; "Learn more" links from every explainer.

## Onboarding guidance followed

- Tours are short (5 screens), skippable at every step, shown once and replayable from Help — no forced "tour torture".
- Explanations appear at the moment of need (ⓘ next to a label, underlined terms in sentences) rather than up front.
- Empty states say what the area is for and offer exactly one next step.

## Accessibility (WCAG 2.1 AA)

- Colour is never the only signal: statuses have icons and words.
- Explainers are popovers (work with tap and keyboard), not hover-only tooltips.
- Focus rings on every control, skip-to-content link, labelled dialogs with focus trapping, `aria-current` on navigation.
- Respects `prefers-reduced-motion`.
- Charts have a screen-reader table.

## Design system v2 — quieter, flatter, neater

A second review pass, done with a senior design critique, made the interface calmer without
changing what any screen does.

| Decision | Why |
|---|---|
| **Geist** (sans) and **Geist Mono** for IRNs, TINs and invoice numbers | A neutral, highly legible grotesque with true tabular figures. Mono makes long reference codes easy to read back over the phone |
| **Flat cards**: a 1px hairline border, no shadows, 12px radius | Shadows add visual noise to dense financial screens. Borders keep grouping clear (law of common region) with less ink |
| Shadows only on things that float (menus, popovers, dialogs) | Elevation then means one thing: “this sits above the page” |
| 14px body text, sentence-case labels, no ALL-CAPS micro-headings | Easier to scan. Caps slow reading and add shouting with no extra meaning |
| 40px buttons and inputs, medium weight, no press-scale animation | Tidier rhythm. Mobile sticky bars and the tab bar still give a 44px+ touch target |
| Sidebar active item is a soft grey fill, not a raised white chip | Shows where you are without competing with page content |
| One primary “New invoice” per screen on desktop (sidebar); page buttons only show where the sidebar isn't visible | Hick's law: no duplicate calls to action |
| Invoice filters use the same words as status badges (Needs approval, With NRS, Approved, Needs fixing) | Consistency (Jakob's law): one name for one thing |
| VAT table rows in plain words; empty rows shown as “—” in muted text; VAT-treatment breakdown as tidy aligned rows | Draws the eye to numbers that matter; zero rows stop looking like data |
| Settings firm code: input and button on one line, hint underneath | Removes a layout hack; the form reads left to right as one action |

## Plans and billing (Phase 3)

| Decision | Why |
|---|---|
| Three plans, one highlighted as “Most popular” | Hick's law (few choices) and the Von Restorff effect (one stands out) |
| Monthly/yearly switch shows “2 months free” | Makes the saving concrete instead of a percentage |
| A preview before any payment: price, credit for unused days, amount today, renewal date | No surprises at the payment page; builds trust (Nielsen: visibility of system status) |
| Downgrades say “nothing to pay today” and wait for renewal | People keep what they paid for; reversible with “Keep current plan” |
| One plan banner at a time, only when action is needed (trial ending, 80% used, payment due, paused) | Avoids banner blindness; urgency ordered by impact |
| When sending pauses, the message says what still works (drafts, approved invoices) and links to the fix | Error messages that explain and recover (Nielsen #9) |
| Invoices waiting for a second approver say why, and hide “Approve” from the person who sent it | Prevents a dead-end click (error prevention) |
| `/verify` accepts typed IRNs or a camera scan, and explains “not found” in plain words | Postel's law: accept the input people have |
