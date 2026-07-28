# 06 — Localisation (country as data)

Target markets are the UAE, Qatar and the wider Middle East. The requirement is
that country specifics live **inside the app as masters and defaults** — selecting
a country pre-fills its requirements, and the user edits from there rather than
someone writing code for each new country.

That is what this design delivers. There is no `if (country === 'AE')` anywhere in
the system, and there is not meant to be.

## The three layers

```
GLOBAL     rule_definition        the catalogue of knobs that exist at all
  ↓
COUNTRY    country_rule_value     what this country says the knob should be
  ↓
TENANT     tenant_rule_value      what this tenant overrode it to
```

`resolveRule()` walks that chain and reports which layer answered — which matters
when a payroll run has to be explained to an auditor two years later.

Two properties fall out of this and are worth stating plainly:

- **Effectivity is respected at every layer.** Asking for a rule "as at" a past
  date returns the value that was in force then, so recalculating an old payroll
  or reprinting an old invoice reproduces the original numbers.
- **Some rules are not tenant-overridable.** A tenant cannot contract out of the
  statutory overtime multiplier, so `tenantOverridable: false` makes the override
  inert even if a row exists.

## Country packs

A pack is a JSON file under `packages/kernel/packs/`. Shipped today: **AE, QA, SA,
OM, BH, KW**.

Adding Egypt, India or anywhere else is a new JSON file and **zero lines of code**.
A tenant admin can also build a country from scratch in the UI, because the UI
writes the same tables a pack seeds. The pack is a convenience, not a requirement.

A pack carries:

| Section | What it covers |
|---|---|
| Locale | currency, timezone, date format, weekend days, RTL, fiscal year start |
| `adminDivisions` | Emirates, municipalities, governorates, provinces |
| `addressFormat` | ordered field descriptors — the UAE has no postcode and uses PO Box + Emirate; Qatar uses Zone/Street/Building; Saudi requires a building number and postcode. One address component, no per-country code |
| `requirements` | every statutory document that must be held and renewed |
| `taxRegimes` | VAT/GST/none, registration label and format, tax codes, e-invoicing scheme |
| `holidays` | fixed, Hijri, or government-announced |
| `rules` | values for the knobs in the catalogue |
| `ruleSources` | the statute each value comes from |

## The requirement model — one table, every document

`requirement_definition` is the piece that does the most work. One generic table
covers Emirates ID, UAE residence visa, labour card, Qatar ID, Saudi Iqama, trade
licence, establishment card, vehicle registration (Mulkiya / Istimara), insurance,
and municipality accommodation permits.

The application never names any of them. It renders whatever rows exist for the
tenant's country, using the columns that describe behaviour:

- `subject` — employee, company, vehicle, project, accommodation, subcontractor…
- `numberFormatRegex` — validates the identifier so bad data never enters
- `expiryNoticeDays` — escalating reminders, e.g. `{90,60,30,14,7}`
- `renewalLeadDays` — drives "start the renewal now" alerts
- `blocksOnboarding` / `blocksSiteAccess` — an expired visa stops site access
- `additionalFields` — extra fields captured for this requirement, rendered dynamically

**A tenant can add a requirement no pack anticipated** — "CNC Operator
Certification", "Scaffolding Ticket" — and it behaves exactly like a seeded one,
with the same expiry alerting and the same document attachment.

## Adoption: copy, don't reference

When a tenant selects a country, requirements, tax codes and holidays are **copied**
into tenant-owned tables (`tenant_requirement`, `tenant_tax_code`,
`tenant_holiday`). Rule values are **not** copied — they resolve live through the
chain above.

The distinction is deliberate:

- **Copied** things are ones a tenant must be able to edit. Their edits set
  `isCustomised`, and a later pack update skips those rows rather than silently
  overwriting a live compliance record.
- **Resolved** things are ones a tenant should get corrections to automatically —
  unless they have explicitly overridden them.

`adoptedPackVersion` records what a tenant started from, so when a pack is
corrected the UI can offer a reviewable diff instead of a surprise.

This is the flow behind "the selected country will have its requirements filled by
the user": the tenant lands on a complete, correct-by-default set rather than an
empty screen.

## Multi-country tenants

`tenant_localisation` is one row per country a tenant operates in, and
`legal_entity` points at one of them. A group with a Dubai factory and a Doha
branch runs two statutory regimes — AED with 5% VAT and WPS SIF files, QAR with no
VAT and a different WPS format — under one tenant, one database, one binary.

## Rendering: language and country are two different facts

The locale a figure is formatted in is **not** the user's language setting. It is
the user's language combined with the tenant's country, and conflating them gets
the Gulf wrong in a way that looks like a data fault:

| Tag | `1234` renders as | Verdict |
|---|---|---|
| `ar` | `١٢٣٤` | Arabic-Indic digits — wrong for the Gulf |
| `ar-EG` | `١٢٣٤` | Correct in Cairo |
| `ar-AE` | `1234` | Correct in Dubai — Arabic month names, **Latin** digits |

So `formattingLocale('ar', 'AE')` is `ar-AE`, and nobody maintains a table of
exceptions: ICU already knows. The locale is established once per request by the
authenticated layout and read by the formatters, so a shared component that never
sees the session still formats correctly.

Direction is handled separately, on the shell, and the two must not be assumed to
travel together — a page can be RTL while the text in it is still English. That
is in fact the current state, and it is why every text run in the shared
primitives is wrapped in `<bdi>`: bidi-neutral punctuation otherwise takes the
paragraph direction, and an untranslated English sentence renders with its full
stop at the wrong end. The same mechanism handles an Arabic supplier name on an
English page, which is a permanent requirement rather than a stopgap — user data
does not become monolingual just because the interface gets translated.

## Where the numbers came from, and what you must do about them

The seeded statutory values (leave entitlements, gratuity scales, overtime
multipliers, VAT rates, accommodation standards) are a **starting point**. Each pack
carries a `notes` field saying so, and `ruleSources` cites the statute where known.

**Verify them against current law before running payroll or issuing tax invoices in
production.** Ministerial resolutions change these numbers; that is what
`packVersion` and the adoption diff exist to handle. Two specifically to check
before you rely on them:

- **UAE e-invoicing** — a Peppol-based five-corner model is being phased in.
  Confirm the current FTA timeline and the accredited service provider
  requirements. The data model carries the fields; the integration is separate work.
- **Saudi ZATCA Phase 2** — applies in waves by taxpayer revenue, and requires
  cryptographic stamping, hash chaining and a QR code. The invoice field list in
  `SA.json` is the data requirement, not the integration.

Qatar and Kuwait have no general consumption tax at the time of writing. Note how
that is modelled: an ordinary regime row with `type: "none"`, **not** a null the
application has to branch on. When VAT commences, add a regime to the pack and
switch the tenant's regime code. No application code changes.

## Adding a country

1. Copy an existing pack to `packages/kernel/packs/<ISO2>.json`.
2. Fill in locale, divisions, address format, requirements, tax, holidays, rules.
3. `pnpm db:seed` — the seeder validates before it writes.
4. Done. No code.

CI validates every shipped pack (`packs.test.ts`), and a rule key that no module
declares is a **hard error**, not a warning: it would be silently ignored at
adoption, which is the worst failure mode there is for a payroll setting.
