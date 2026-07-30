# 05 — Roadmap & Notes

## The honest scope assessment

Seventeen modules, done properly, is 4-6 years for a small team. SAP and Oracle
have thousands of engineers on this problem. So the sequencing below is built
around one idea: **be sellable at the end of phase 2, not at the end of phase 6.**

The wedge is the joinery workflow — Estimation → Production/Cutlist → Projects →
Contract Admin. That is what Odoo, ERPNext, Zoho and every generic ERP does badly
or not at all, and it is the only part a joinery business cannot buy elsewhere.
The generic modules are table stakes; build them second, and never try to
out-feature Odoo on CRM.

## Phase 0 — Kernel (weeks 1-8)

Nothing else works without this, and retrofitting any of it is brutal.

Tenancy + RLS · auth & sessions · RBAC + CASL · audit log · numbering series ·
document store on R2 · **approval engine** · notification centre · custom fields ·
event bus + outbox · master data (party, item, project, UoM, currency, cost
centre) · reporting registry · i18n (en/ar + RTL) · the module manifest and
entitlement system · UI shell and design system · CI with boundary enforcement.

Ship one thin vertical slice end-to-end to prove the architecture before writing
module two.

## Phase 1 — Foundation modules (months 3-6)

**Inventory** and **Procurement**. They feed everything else, they exercise the
kernel hard, and they are immediately useful internally — which means real users
and real feedback while the stakes are low.

### Phase 1 status — both shipped, and the loop is closed

Procurement was the last phase-1 module and it closed three dangling ends left
by the modules built before it: `projects.commitment` had a `relieveCommitment`
nothing called, Inventory had goods-receipt movement types with no purchase order
to receive against, and Estimation produced material demand with no consumer.

The chain is proven by an integration test that runs it as one story against a
real database:

> requisition → RFQ → landed-cost comparison → award → purchase order →
> **commitment against the budget** → delivery → **stock in and cost accrued** →
> supplier invoice matched three ways → **commitment relieved**.

The link nobody else joins is the middle one. Issuing an order registers what the
job is committed to; receiving the goods charges the job on the day the material
lands rather than whenever the invoice arrives; the matched invoice reverses one
and relieves the other. A cost report is therefore true *during* the job, which
is the only time it can change a decision.

Both compositions live in `apps/api/src/routes/procurement.ts`. The boundary
checker enforces that Procurement imports neither Inventory nor Projects, and
each composition degrades to the procurement-only behaviour when the other module
is not entitled — so a firm that buys purchasing alone gets a complete purchasing
system, not a broken ERP.

## Phase 2 — The wedge (months 6-14) ← this is the product

**Estimation & Tendering** → **Production (cutlist, routing, shop-floor scanning,
polishing)** → **Projects** → **Contract Administration (variations + IPCs)**.

The continuity across these four is the entire pitch: a BOQ line becomes an
estimate build-up, becomes a budget, becomes a production BOM, becomes cut parts
with barcodes, becomes scanned progress, becomes a payment application. **Nobody
else joins those dots.** At the end of phase 2 you have something a joinery
business will pay for.

### Cutlist optimiser — delivered, with a known gap

`@aerolith/cutlist` is built and tested (57 tests). Two things to be honest about:

- **Achieved yield depends on the parts, not the algorithm.** The optimiser
  reaches the grid-optimal count per sheet on every shape tested. A mix with
  large awkward panels has a low geometric ceiling nothing can beat — the
  wardrobe test job tops out near 74% because a 2100x900 back leaves a 340mm
  strip nothing else fits into.
- **Known gap:** it does not find layouts combining a grid with a rotated part in
  the leftover strip, worth roughly one sheet in twenty on mixes like that job.
  Closing it needs a real search rather than a greedy pass. Recorded rather than
  hidden; worth doing once there is a customer whose material bill justifies it.

### Phase 2 status — the wedge is joined end to end

All four modules are shipped at v0.1, and the chain they exist to form is proven
by an integration test that runs it as one continuous story:

> BOQ line → rate build-up → estimate → **won tender** → project budget →
> production work order → cut parts → **measured site progress** → interim
> payment application → certificate.

Two links in that chain are the ones nobody else joins:

- `POST /estimating/estimates/:id/convert-to-work-order` — priced build-ups
  become a work order with its parts, Estimation and Production composed in one
  transaction without either importing the other.
- `POST /contracts/:id/applications/from-progress` — the WBS roll-up values every
  contract BOQ line at its measured percentage, and the total becomes a
  cumulative payment application. Contract lines with no WBS link are **named**
  in the response rather than counted, because an unvalued BOQ line is unbilled
  work and "3 lines skipped" is a number nobody investigates.

Both compositions live in the application layer. The boundary checker enforces
that neither module imports the other, which is what keeps each one sellable on
its own — and what leaves the door open to extracting any of them later.

Remaining in phase 2, deliberately deferred rather than forgotten: shop drawing
and submittal registers (the fit-out approval clock), certificate PDF generation,
and the cutlist gap recorded above.

### The web shell — delivered

`apps/web` is a Next.js 15 App Router shell, and the thing worth stating about
it is what it does **not** contain: **no module names anywhere.** The sidebar is
whatever `/me` returned — the tenant's entitled modules, filtered by the user's
permissions. A tenant who bought only Estimating sees a focused estimating
product; a tenant who bought everything sees an ERP. Same binary, same code path.
That is requirement 19 made visible rather than merely argued.

Built so far: sign-in, the shell and navigation, the project screen (WBS with
rules of credit, earned value, forecast, margin gated behind
`projects.margin.view`), and the contract screen (position, variation register,
and the time-bar warning above everything else because it is the one fact on the
page with a deadline attached).

Inventory, Procurement, Estimating and Production have working, tested APIs and
no UI yet. Their nav links render a "not built yet" page **inside the shell**
rather than a 404, so the gap is explicit instead of looking broken.

Security posture: the session token is an httpOnly cookie, every API call is made
from the server, and no credential ever reaches client JavaScript. Verified in a
real browser, not asserted — `document.cookie` is checked to be empty of it.

Run it:

```
pnpm db:migrate && pnpm db:seed && pnpm db:seed:demo
pnpm --filter @aerolith/api start          # :3001
pnpm --filter @aerolith/web dev            # :3000
# demo@aerolith.test / demo-passphrase-2026
```

The demo seed builds one continuous story rather than disconnected rows — budget
→ progress → payment application → certificate, plus a variation instructed on
site and now past its notice deadline, and a purchasing round that ends with one
invoice billing 140 boards against a 90-board delivery. Every screen therefore
has something true to show, including the exception queue.

It is also now idempotent. It never was: the clean-up deleted `kernel.project`
but none of the module tables, which point at it with plain uuid columns by
design, so a second run collided on `wbs_node_uq`. It had only ever been run
against a fresh database, which is exactly how that class of bug survives.

### The index screens — delivered

Until this, the shell was navigable and there was nothing to navigate to: every
screen reached an entity by id, and the two list pages were placeholders saying
so. There are now six real index screens — Projects, Contracts, Purchase Orders,
Supplier Invoices, Requisitions and Match Exceptions — each with search,
filters, sortable columns and a pager.

Three decisions worth recording:

- **Every control is a URL, and there is no client JavaScript.** A filtered,
  sorted page is bookmarkable and pasteable — "the held invoices, biggest first"
  is a message somebody can send. A client-side filter would have prevented that
  and bought nothing, because the server has to run the query either way.
- **Sort columns are whitelisted per list, not validated.** Drizzle parameterises
  values but never identifiers, so `order by ${query.sort}` is an injection
  however it is escaped afterwards. An unrecognised key falls back to the default
  rather than erroring — a list that 400s because somebody edited the address bar
  teaches users the software is brittle.
- **Offset pagination with a total, not keyset.** Keyset pages more efficiently
  but cannot produce a total, and "47 open orders" is very often the only thing
  the user came to find out. ERP users filter; they do not page to row 40,000.
  `LIST_MAX_PAGE_SIZE` carries the note on when that stops being true.

Each list joins the names it displays — supplier, client, project — rather than
returning ids for the browser to resolve, and the invoice list carries an open
exception count per row, because "on hold" without a number is a queue nobody
triages.

### Write flows — delivered

The UI could be read and navigated but nothing could be *done* — including on the
exception queue, whose entire purpose is to demand an action. Three writes now
work end to end, chosen to cover the three shapes an ERP action comes in:

- **Release a held invoice** — dangerous, needs a typed reason, permission-gated.
  On a new supplier invoice screen reached straight from the exception queue.
- **Issue a purchase order** — dangerous, with a cross-module side effect
  (the commitment against the project budget), on a new purchase order screen.
- **Approve a requisition** — one click, inline on the list.

Server Actions throughout, so the password and the session token never leave the
server, and the session cookie is `SameSite=Lax` on top of the Origin check
Next performs. There is exactly one `use client` island — a submit button that
shows pending state — and it degrades: without JavaScript the form still posts
and the action still runs.

Two decisions worth recording:

- **Success is reported by durable state, never by a transient message.**
  Releasing revalidates the page, the invoice is no longer held, and the whole
  card — the message element included — is removed from the DOM before anything
  could read it. A confirmation that deletes itself on success is worse than
  none: it looks like it worked and says nothing. So a released invoice renders
  a panel showing when, and the reason. The action's own message earns its place
  on **failure**, where the form is still on screen to show it. That defect was
  found by driving a browser; every build was green through it.
- **Permission-gated controls are hidden, not disabled, and the API refuses them
  regardless.** A disabled button invites a user to go and ask for the
  permission; naming who *can* act is more useful. The UI gate is a courtesy and
  the tests assert the API refuses the same call.

### The wedge, made usable

The chain the whole product is arranged around — measured progress becoming a
payment application — was provable by API and impossible in the UI. Both ends
now work:

- **`/projects/:id/progress`** renders one input per WBS leaf, chosen by that
  node's rule of credit: a units box, started/finished checkboxes, weighted
  milestone ticks, or a capped percentage field that only appears for somebody
  holding `projects.progress.override`. Sending the wrong evidence for a rule is
  ignored by the service rather than quietly accepted, so the form is built so it
  cannot be sent — a user never wonders why the number they typed did nothing.
  Only leaves are offered: a parent's percentage is the value-weighted roll-up of
  its children, and an input for it would be overwritten by the next roll-up.
- **"Value from progress"** on the contract screen drafts a cumulative payment
  application from that roll-up. Contract lines with no WBS link come back
  **named** in the result, and the screen repeats them: an unvalued BOQ line is
  work that has been done and is not being billed for.

**A real bug this surfaced.** `getWbsRollUp` passes every node's already-resolved
percentage through a `manual` carrier — correctly, because re-deriving from the
node's rule would double-apply the manual ceiling to a node measured last month.
But `containsManualClaims` was inferred from that same carrier, so it was
**always true**: every project screen has been warning that "some of this figure
is an opinion" regardless. A warning that is always on is not a warning; it
trains people to ignore the one occasion it matters. The roll-up now takes
self-assessment as its own input, separate from the percentage carrier, with a
test pinning both directions.

### The money loop closes

Drafting an application from progress left a dead end: it sat in draft with no
way to submit it or record what the client certified. Both now work, on a
cross-contract **payment applications register** that fills the nav slot which
had been reading "not built yet".

The register is deliberately cross-contract. "What have we applied for and not
been paid" is a cash-flow question about the business, not about one job; a
per-contract view answers a different question and is one filter away. The
`Outstanding only` filter spans two statuses — applied-and-uncertified plus
certified-and-unpaid — which is why it is not a status chip.

**The disallowance is a first-class figure.** Certified is kept beside applied,
never over it, and the gap is carried on the row rather than left for a reader to
subtract two columns by eye. A client who trims every valuation is a pattern you
can price the next tender against, and it is invisible unless somebody totals it.
The register banners the total; the detail screen shows it as an amount and a
percentage with the reason beside it.

Two user-visible defects a screenshot caught, both in shared components and so
both affecting every screen:

- A negative figure wrapped after its minus sign, so "Retention held: −" sat on
  one line and the amount on the next, reading as a stray dash rather than a
  deduction.
- Standing on `/contracts/applications` highlighted **both** "Contracts" and
  "Payment Applications" in the sidebar, because each item decided independently
  and prefix matching made both true. The active item is now resolved once, most
  specific wins — a nav that disagrees with itself about where you are is worse
  than one that is merely plain.

### Variations, and the notice that preserves them

The same dead end one module over: the contract screen warned that a variation
was about to be time-barred and gave nobody a way to answer it. There was no
endpoint at all for recording a notice — the module shouted about a deadline it
could not help you meet.

There is now a cross-contract **variation register** filling the last "not built
yet" nav slot, a detail screen, and the two operations that matter: recording
notice, and recording the client's decision.

- **The notice clock is computed server-side**, on the register and on the detail
  screen, both calling the same domain function. It is a contractual rule that
  depends on the contract's own notice period, and two clients disagreeing about
  whether a claim is still alive because their machines disagree about today's
  date is not a bug worth having.
- **Late notice is recorded, never refused.** A notice served on day 30 of a
  28-day bar is still evidence, still worth having on file, and still better than
  nothing. Refusing it would leave the strongest available fact out of the record
  to keep a status column tidy. The screen states the lateness plainly rather
  than hiding it.
- **No clock at all is a distinct state from "not barred."** A variation that has
  been identified but not instructed has no event for the deadline to run from,
  and reports `null` — saying "not barred" there would be a quiet lie about a
  claim whose clock has not started.
- Giving notice needs `contracts.variation.write`, not the approval permission.
  It is administrative and time-critical, and gating it behind the person who
  approves variations is exactly how a deadline gets missed while they are on
  leave.

The durable-state rule earned its keep again: an earlier draft of the notice
action returned a special message when the notice was late. That message could
never have been read — recording the notice revalidates the page, and the panel
holding the message is replaced by the "notice given" card. The lateness is
stated on that card instead, and the dead branch is gone.

### Goods receipt — the procurement chain closed

The last dead end in procurement: an order could be issued but not received
against, so the chain could not be completed by a person. There is now a goods
receipt register (the final "not built yet" procurement slot) and a receive form
on the order screen.

- **A blank line is not a zero.** Only lines with a typed quantity are sent.
  Posting zero for every untouched line would write a receipt claiming nothing
  arrived — and one that looks deliberate rather than empty.
- **The quantity box is not capped at what is outstanding.** Over-delivery
  happens, the goods are in the yard either way, and a form that refuses to
  record what physically arrived just gets worked around. It is accepted and
  flagged, and the check runs before anything is written so the decision is taken
  at the gate while the lorry is still there.
- **The over-delivery flag lives on the delivery, not in a message.** This was
  the third instance of the same lesson: receiving the last of an order makes it
  no longer receivable, so the form — and any message beside it — disappears
  before it can be read. The order screen now lists its deliveries, and the flag
  is rendered there permanently.

Two latent problems surfaced while doing it. `apps/api/tsconfig.json` only
included `src`, so **nothing under `scripts/` was ever typechecked** — the demo
seed had a `TenantContext` missing two required fields and nobody knew. Scripts
are in scope now, which found that immediately. And the demo seed called
`receiveGoods` without mirroring the route's stock composition, so a seeded
delivery never reached stock while one recorded through the UI a minute later
did; the seed now performs the same composition it already performed for
commitments, and posts 90 sheets.

Still missing before this is a usable product: detail screens for requisitions
and RFQs, Arabic translations of the interface, and PDF output for certificates
and applications.

### The RTL support was wired, untested, and wrong

The previous entry described RTL as "wired but untested". Flipping the demo user
to Arabic and driving the result found three defects, in a feature whose whole
justification is that the product targets the Gulf.

**Formatting never followed the user at all.** `money`, `signed` and `date` each
took a `locale` parameter defaulting to `en-AE`, and not one caller ever passed
it. An Arabic speaker in Dubai saw `AED 1,234.50` and `28 Jul 2026`. It
typechecked, it rendered, and it was wrong for exactly the users the feature
exists for — the quietest way for a feature to be absent while looking present.
The locale is now established once, by the authenticated layout, and read by the
formatters through `lib/locale.ts`.

**The first fix for that was also wrong**, and only driving a browser caught it.
`AsyncLocalStorage.run(locale, () => <Shell>{children}</Shell>)` holds the store
for the synchronous execution of its callback — and that callback only *creates*
the element. React renders the children afterwards, by which time the store is
gone, so every figure still came out in the fallback locale. The store is now a
`cache()` slot, which is scoped to the React request rather than to a function
call. The lesson is the one this log keeps recording: a green build is not
evidence, and the second bug was hiding directly behind the first.

**Latin text in an RTL page was being mangled.** This one is independent of
translation and would have outlived it. Punctuation is bidi-*neutral*, so it
takes the paragraph's direction: an English sentence in an Arabic page rendered
as `.Variations, payment applications and retention`, a search placeholder led
with its ellipsis, and the pager read `contract 1` — the count looking like an
index. Every untranslated string on the page had it, and Arabic supplier names
on an English page have it in reverse, which no amount of translating the
interface would fix.

The fix is an inline `<bdi>` in the shared primitives, applied to strings only so
that a flex block in a table cell is never wrapped in an inline box. It had to be
inline: setting `unicode-bidi: plaintext` on the cells fixes the ordering and
then resolves `text-align: start` per run too, so English cells align left while
Arabic ones align right and the column loses its common edge — measurably worse
than the bug it fixes. That was established by measuring both against the running
page, not by reading the spec.

Two smaller things fell out of it. `total.toLocaleString()` in the pager formatted
in the *server's* locale — a machine setting unrelated to the user, silently
disagreeing with every other figure on the page — and is now `integer()`. And
`format.ts` gained a transitive `server-only` import, which stopped its own test
file from collecting; the web app now has a vitest config setting the
`react-server` resolve condition on both pipelines, so these modules are tested
the way Next loads them rather than by deleting the marker that keeps the session
out of the browser bundle.

What is verified now: the shell mirrors (`dir="rtl"`, sidebar right), money
renders `‏1,145,000.00 د.إ.‏` with **Latin** digits — correct for the Gulf, where
`ar-EG` would give Arabic-Indic — dates render `28 فبراير 2026`, no screen
overflows horizontally, and the English path is unchanged. What is **not** done:
the interface strings are still English. The bidi work is what makes that
tolerable rather than broken-looking, and it is deliberately built so that each
run re-orders itself the moment a translation replaces it.

### Inventory gets its screens — and the read API it never had

Inventory is the reference module and had the most domain logic in the codebase
— offcut matching, batch tracking, sheet goods by dimension, landed-cost
valuation, seventy passing unit tests — and **not one screen**. Four navigation
slots led to "not built yet". The gap was wider than it looked: the module had
no list endpoints at all. `/inventory/stock` returned an unpaged 500-row cap and
`/inventory/offcuts` returned every available piece with a flat summary, so this
was two layers, not one.

The four registers are `listItems`, `listStockOnHand`, `listOffcuts` and
`listStockCounts`, in a new `service/registers.ts` kept apart from
`movements.ts`: posting is the module's dangerous surface and reading is not, and
mixing them makes it harder to see which functions can change stock.

**The item master is a kernel table, and that is the point.** A sheet of 18mm MDF
is bought by Procurement, estimated by Estimating, cut by Production and stocked
here, so it belongs to the platform; Inventory owns the *stock* of an item, which
is why `stock_level` is in this schema and `item` is not. Reading a kernel table
from a module is allowed — reading another module's tables is what the boundary
check forbids.

Three decisions worth recording:

- **A zero balance is not a missing row.** A zero says this item has been stocked
  here and currently is not. Zero rows therefore show by default and excluding
  them is an explicit filter, and on the item list `onHand` is **null** — not
  zero — for an item that has never moved anywhere.
- **The offcut summary spans the register, not the page**, because "what is on
  the rack worth" must not change as somebody pages through it. Scrapped value
  sits beside available value deliberately: it is the running cost of the
  minimum-usable-size rule, and a tenant tuning that rule is entitled to see what
  it threw away.
- **Counts report net and gross variance.** Net answers "is the book value
  right" and cancels out; a count where one bin is fifty over and another fifty
  short nets to zero and is not a clean count. Gross answers "was the counting
  right", and only one of the two says so.

**A bug caught by arithmetic, not by tests.** `offcut.unitCost` is misnamed: it
holds the piece's ABSOLUTE cost, not a rate per square metre — both branches that
write it produce an absolute figure. The register's value summary was written as
`sum(area × unitCost)`, which squares the area. Checked by hand against the seed
— parent sheet 2.9768 m² at 284, remnants of 0.7316 + 0.7564 + 0.4644 m² costing
69.80 + 72.16 + 44.31 — the correct total is 186.27 and the buggy one is about
127. Both look like plausible money. There is now a test that pins the summary to
the sum of the rows it is summarising.

Two duplicate endpoints were merged rather than left side by side: `/inventory/stock`
already existed unpaged, and answering "list the stock" two ways with two shapes
is how an API rots. `?itemId=` still returns a single position — a figure, not a
list — because splitting those would mean two names for one noun.

**A finding that is not Inventory, and matters more than it.** The demo API could
not log in when pointed at the application database role. See the entry below,
where it is fixed.

Still missing before this is a usable product: the login/RLS defect above,
detail screens for requisitions, RFQs and stock counts, Arabic translations of
the interface, and PDF output for certificates and applications. Estimating and
Production remain the two modules with no screens at all.

### Estimating gets its screens, and its rate library starts telling the truth

Three navigation slots — tenders, estimates, the rate library — and the same
shape as Inventory: registers in a `service/registers.ts` kept apart from the
pricing path, because submitting an estimate commits the company to a number and
listing them does not.

**Cost redaction lives in the service, not the route.** `estimation.margin.view`
is a separate permission from reading an estimate, and the detail endpoint
already honoured it. Putting the check in the route would mean the next list to
be written forgets, and a cost column leaking to everyone is not a bug anyone
notices from the screen. `listEstimates` takes the flag and DELETES the fields —
a `totalCost: null` on the wire is indistinguishable from an estimate with no
cost yet, and still tells the reader something is being withheld.

Three defects found by working the numbers rather than by reading the screen:

- **The rate library's cost column was derived from a cache nothing maintains.**
  `rate_item.direct_cost` is documented as "computed from the build-up, cached",
  and no code path writes it — it is zero on every rate the pricing path has
  created. A register reading it showed a plausible cost of nothing, and the
  variance beside it went silently null. The cost is now summed from the
  components in SQL, the same arithmetic `calculateBuildUp` performs, with the
  cached column only as a fallback for a rate that genuinely has no build-up.
  A test pins the two together.
- **The variance compared a selling rate to an actual cost.** Dividing
  `lastActualCost` into `unitRate` measures the margin and labels it a rate
  variance: a plausible number answering a different question. It is cost against
  cost now, and negative is the one that matters — the work costs more than the
  build-up assumes, so every line priced from that rate is losing the difference.
- **The estimates register showed the margin that was ASKED for.** An estimate
  set to 18% with a large provisional sum in it achieves 7.5%, because a PC sum
  is the client's money passing through and carries no margin. Rendering "18.0%"
  beside a margin of 10,968.91 on a value of 145,938.38 invites a reader to
  divide, get a third number, and conclude the screen is broken. Both figures are
  reported now, achieved first.

The demo seed grew an estimating story, and building it caught a fourth: rates
were seeded with typed `directCost` and `unitRate` and no components, so every
BOQ line priced from them came to **zero** and both estimates were worth exactly
the provisional sum. A rate is a build-up, not a number — the seed now carries
real components, and its cached figures were computed from them rather than
typed. It also adds the customer party the seed never had, without which every
client column rendered empty.

### Production gets its screens

Five slots: work orders, the shop floor board, cutting plans, finishing and
routings. Four are paged registers; the board deliberately is not.

That takes the application to **21 of 27 navigation destinations built**. The six
still routing to "not built yet" are the Notice Register and Retention under
Contracts, RFQs under Procurement, and Job Costing, cross-project Progress and
Snags under Projects. Every module now has screens; no module is complete.

**The board is a shape, not a list.** Every other screen here is a list with a
pager, because a list answers "find me the one I am looking for". The board
answers "what is queued where", which a foreman reads all at once — and a page 2
would hide the station that is idle. The endpoint already returned it grouped by
work centre for the same reason.

Two defects, both found by driving the screens rather than by reading them:

- **Progress was counted in pieces against ROWS.** `partCount` is rows on the
  cutting list and `partsCompleted` is pieces, and a list of two rows can be
  seventy-two pieces — so the register rendered "18 of 2". The service now
  reports planned pieces separately, and the screen counts pieces against pieces
  with the row count beside it. The comment in the service warning that these
  were different questions was written by the same hand that then mixed them.
- **The cure clock read "ready 1,948h 51m ago".** The seeded spray load carried
  a fixed date, so the one screen whose entire point is a live constraint showed
  a dead one every time the demo was run. The load is seeded relative to `now()`
  now, and the duration helper degrades to days past 48 hours rather than
  printing four-digit hours.

A third duplicate endpoint was merged: `GET /production/work-orders` already
existed, unpaged and capped at 200 — the same collision Inventory had, found the
same way, by Fastify refusing to start. Worth recording that the route survey
which missed it was a regex that did not match `app.get<{...}>(` split across
lines. It has now missed the same thing twice; grep for the path literal.

The demo seed grew a factory: five work centres including a batch spray booth,
two routings, an order released to the floor with part of it through the saw, a
committed cutting plan that took a piece off the offcut rack, a load curing with
the clock running, and one held because booth humidity is above the lacquer's
spec.

### The application could not run as the application role

The API connects as `aerolith_app`, a non-superuser with no table ownership, and
that is the entire reason Row Level Security is real here rather than decorative.
It had never actually been run that way.

Pointed at that role, **login failed for every user** with "not a member of any
active workspace". `kernel.membership` is tenant-scoped, and `loadMemberships`
has to read it before any tenant is known — discovering the tenant *is* the
operation, so no guard can be set. RLS returned nothing, correctly, and the
message was indistinguishable from a genuine absence of membership.

The fix is one additional **permissive SELECT policy** on that one table:

```sql
CREATE POLICY self_read ON kernel.membership FOR SELECT TO aerolith_app
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
```

Postgres ORs permissive policies together, so this widens reads for `membership`
alone and leaves every write policy exactly as strict as it was. It is
deliberately SELECT-only: a user who could write their own membership could sign
themselves into any tenant, which is a far worse bug than the one being fixed.
`withUserId` sets the guard, and only the authentication path calls it.

**Fixing login exposed a second layer.** With login working, every screen
returned 404 — `modulesForTenant` read `kernel.tenant_module` through
`withoutTenantGuard`, and under the app role "no entitlements" is
indistinguishable from "bought nothing", so every module reported itself as not
purchased. The tenant is known there, so it simply needed `withTenantId`. An
audit of every `withoutTenantGuard` call site against the tenant-scoped table
list found exactly these two; the only other hit is the demo seed, which connects
as the owner.

**Why no test caught either.** Every integration suite connects as the table
OWNER, which policies scoped `TO aerolith_app` do not apply to. Nine hundred
tests were green against a database where RLS was, for them, switched off. The
kernel isolation suite already had an app-role connection and a
`TEST_APP_DATABASE_URL` that CI has been setting all along and nothing consumed;
it now covers the pre-tenant path — that a user can read their own memberships
and nobody else's, that the self-scope grants no write, and that entitlements are
invisible without a guard. Dropping the policy makes the first of those fail,
which was checked rather than assumed.

The comment on `withoutTenantGuard` said reads returning nothing was "the
intended failure mode". It is correct behaviour and a trap, and saying so is what
led both call sites astray: the query does not fail, it comes back empty, and
empty reads as absence. The comment now names the three alternatives and says to
reserve the escape hatch for tables with no `tenant_id` at all.

Verified by running the API against `aerolith_app` and driving all 21 screens:
42 rows rendered, no errors. That is the first time the application has run in
the configuration the documentation has always described.

### The last six registers — every navigation destination now leads somewhere

Notices, retention, RFQs, job costing, cross-project progress and snags. Counted
rather than claimed this time: **27 of 27**.

All six are cross-entity on purpose. The per-contract and per-project views
already existed and answer a different question; these answer "where is the
business", which no per-job screen can produce. Each one is built around the
single fact it exists to surface:

- **Notices** flag *contractual* items past their reply date, separately from
  merely late ones. An unanswered RFI is an irritation; an unanswered notice on
  which an extension of time depends is a claim expiring while nobody watches.
- **Retention** separates held from claimable-today. Retention is the largest sum
  on a joinery job nobody owns, and it comes back by asking — a single total
  gives nobody anything to act on.
- **RFQs** flag an enquiry that closed with fewer than two prices. One quote is
  not a market test.
- **Job costing** keeps actual and accrued apart, and shows a reversed entry
  struck through rather than hidden, because a cost is corrected by a
  compensating entry exactly as a ledger is.
- **Progress** shows what each percentage was *measured from* — counted units,
  a milestone tick, or somebody's opinion — with the bar hatched when it was
  typed.
- **Snags** treat `rejected` as open. A defect the subcontractor disputes is
  still a defect, and counting it as closed is how it reappears at handover.

Four things were caught by driving the screens rather than reading them:

- **`start_finish` was invented.** The real rule of credit is `started_finished`,
  so the "measured from" column fell through to its default and rendered the rule
  name twice. Checked against the enum and against what the database actually
  contained.
- **`invited` promised a number the data cannot produce.** Nothing in the system
  creates a quote record at the point of inviting a supplier, so "suppliers
  invited" was really "suppliers who have responded" — the field is `suppliers`
  now, and its comment says why.
- **`projects.progress.read` does not exist.** The endpoint is gated on
  `projects.project.read`; the only progress permission is `progress.record`,
  which is a write, and gating a read behind it would deny the number to everyone
  allowed to see it and not to change it. Every one of the 52 permission keys the
  API uses was then checked against the declared catalogue.
- **The seeded enquiries were drafts**, so the uncompetitive flag could never
  fire and the register demonstrated its two most useful signals switched off.

Retention had one design error of my own: the summary reported `dueValue` and
`overdueValue` computing the same predicate — a distinction that does not exist
without a grace period. Three states, not four.

### The approval engine becomes reachable

1,776 lines of approval engine — conditional routing, quorum, delegation,
workflow version pinning, authority limits — and until now **not one file in
`apps/web` mentioned approvals**. `POST /approvals/tasks/:taskId/decide` had no
caller. The most elaborate thing in the kernel gated the operations that cost
real money (releasing a held invoice, writing off stock, submitting a price) and
there was no way to decide any of them.

Three screens: the inbox, what I requested, and the decision trail.

**The inbox is not a register.** Every other list in the app answers "find the
one I am looking for" and is paged and sorted accordingly. This one answers
"what is waiting on me" — a queue to be emptied, where each item needs a decision
taken on the spot rather than a link to somewhere else. Approve and reject are
separate forms rather than one form with a toggle, because a submit button whose
meaning depends on a radio the user set thirty seconds ago is how the wrong
decision gets recorded on a screen full of them.

**It names nobody's uuid.** The inbox, the submitted list and the trail all
resolved `requestedBy`, `approverId` and `actorId` to bare uuids. An inbox that
says a write-off is waiting on you "from 9f3c…" tells an approver nothing they
can act on, and "waiting on 9f3c…" is not an answer to the only question the
submitted screen is asked, which is who to go and chase. All three now join
`app_user`.

**Approvals is a kernel capability, so it has no manifest.** `navigationFor`
builds the menu from module manifests and cannot produce it; every tenant has an
inbox whatever they bought. It is synthesised in `/me` at order 0, above every
module — an inbox that sorts below Stock Counts is one nobody opens.

That change contradicted an existing test asserting a user with no roles gets an
empty menu, on the principle that the menu carries no links that would 403. The
assertion was updated rather than the feature weakened, and the principle still
holds: `/approvals` 403s for nobody, because **an approver's authority is the
task assignment itself**. A user with no roles at all can still be named in a
workflow and must be able to reach their inbox.

**The demo needed a second user**, and finding out why is the useful part: the
engine filters the requester out of the approver list, so a one-user demo has a
permanently empty inbox and the whole subsystem looks inert. Rana Haddad, a
non-owner quantity surveyor, now raises the requests the demo user is asked to
decide — non-owner deliberately, since an owner bypasses the permission matrix
and a demo where everyone is an owner cannot show an approval routed to somebody
who lacks the authority to just do the thing themselves.

Two workflows, because the property worth showing is that routing is by
CONDITION rather than by document type: variations engage the matrix only above
AED 50,000, and stock write-offs always. The seed deliberately includes a
variation below the threshold, which produces **no approval instance at all** —
proof the condition gates rather than a screen where everything needs a
signature.

Verified in a browser: rejecting with no reason is refused by the form,
approving a write-off with no comment is refused by the ENGINE (`Step "Commercial
manager" requires a comment.`) and surfaces as a readable sentence, approving
drains the item and decrements the count, and the trail shows who was asked, what
they said and when.

### Stock can now be moved from the product

Inventory had four registers showing figures nobody could change through the
application. `POST /inventory/movements` — the one call that changes stock at all
— had no caller outside the seed and the tests, so the demo could show what was
in the warehouse and offer no way to put anything there. A fifth navigation slot,
`/inventory/movements`, closes that.

**The ledger comes first, the form second.** `listMovements` aggregates each
movement's lines in a subquery joined per row: line count, quantity moved and
value. `totalQuantity` is unsigned, and is documented as such — line quantities
are always positive and the direction lives in the movement type, so it answers
"how much moved", not "how much stock changed by". A reversal is detected by the
row a later movement points AT, and both stay on the ledger: **stock is corrected
by a compensating movement, never by deletion**, which is what makes the ledger
reconcilable. Reversed rows are marked, never hidden — the audit question is what
we did, not what we now think.

The screen shows who posted each movement, not which module. `postedBy` is a
uuid, and a stock ledger whose actor column reads as a uuid is a ledger nobody
can audit, so it joins `app_user`; `sourceModule` sits underneath it, because a
movement raised by Production and one keyed by hand are different facts about how
the stock came to move.

**The form posts one line, deliberately.** A hand-keyed movement is a receipt off
a van, an issue to a job, a transfer, or a correction after a count — all one item
at a time. Multi-line movements come from the documents that generate them, a
goods receipt against a purchase order or a production output against a work
order, and a repeating line editor here would mean client-side JavaScript for a
case those modules already handle better.

**`production_output` is not offered.** It books finished goods out of a work
order and Production posts it with the work order id attached; keying one by hand
would create stock that traces back to nothing. It still appears in the filter
chips, because the ledger must show movements this screen cannot create.

Two things the build taught:

- **A `'use server'` module may only export async functions.** The type table and
  its guard were exported from `actions.ts`; typecheck and lint both passed and
  `next build` refused it, because every export in such a file becomes a callable
  server endpoint. They moved to a plain module beside it.
- **The register is gated on `inventory.stock.read`, the form on
  `inventory.stock_movement.create`.** Seeing what moved is not the same
  authority as moving it.

Verified in a browser against the seeded demo: a receipt with no unit cost is
refused by the form, a transfer to the same warehouse is refused by the form, and
issuing 999,999 of an item is refused by the API in the sentence the user
sees — *"Cannot issue 999999: only 900 on hand. Post a receipt or an adjustment
first."* A real receipt of 12 at 215.50 posted as `IGRN-2026-00003`, valued at
2,586.00, and moved the position from 900 to 912.

**A test that only passed on a clean database.** The RLS isolation suite asserted
that after a scoped delete the whole `party` table contained exactly one row —
a fact about the developer's machine, not about tenant isolation. It passes in CI
because CI's database is empty and fails for anyone who has run the demo seed
into the same database. Scoped to the two tenants the suite creates.

### The cutting plan you can actually see — and two things that found

The README calls the cutlist optimiser the differentiator. The register could
tell you a job used eleven boards at 82% net yield; it could not show you the
boards, and nobody cuts to a percentage. `GET /production/cutting-plans/:id`
returns one stored plan and `/production/cutlist/:id` draws it: every board with
its parts positioned, the material named, the cut sizes and origin coordinates
beside the drawing, the remnants going back on the rack, and the pieces that came
off it with their status **now** — a plan made last week whose remnant another
job has since cut will not cut as drawn, and this is the only screen that says so.

**The drawing is rendered, not stored.** The plan JSON is the record; the SVG is
a view of it, so a renderer improvement reaches every plan ever made rather than
only the ones cut after it shipped. It reaches the page as an `<img>` with a data
URI rather than injected markup: the renderer escapes every text node it writes,
so inlining would be safe today, but the text in those nodes is user-entered part
labels and "safe because a function three packages away still escapes correctly"
is a property that quietly stops holding. Base64 through `Buffer`, not `btoa`,
because a part labelled in Arabic is not Latin-1.

Then the seed was pointed at the real thing, and two defects fell out.

**The demo's cutting plan was a stub.** `plan: { boards: 11, note: '…' }` sat
beside summary columns claiming 11 sheets and 82.7% net yield — figures nothing
had computed, on top of a plan with no boards in it. The register looked
convincing and the plan behind it could not be drawn. The seed now runs the real
optimiser over the work order's real parts and the real rack, and the numbers are
whatever the engine says. (The same pass found that the seed could only ever be
run once: `approval_workflow` was missing from its cleanup list, so a second run
died on a unique constraint — the same "idempotent by accident of always running
against a fresh database" failure recorded a few entries above, in a different
table.)

**Edge trim was being applied to remnants.** A 1180x620 piece offered as
1160x600 will not take the 1180x580 shelf it was kept for, so the optimiser
opened a fresh sheet and left the remnant on the rack — the exact case the offcut
register exists to catch, declined by an arithmetic detail. Trim squares the
factory edge of a full sheet; a remnant's edges are saw cuts and the factory edge
it came from was trimmed when the sheet was first opened. Now `trimFor` returns
zero for an offcut.

**Reaching for the rack is a strategy, not a rule.** With the trim fixed, the
reception job took a remnant and *cost more*: 14 sheets either way, one extra
board, and a piece of stock spent to buy nothing. The packer is greedy and never
backtracks, so preferring offcuts opens one for the first part that fits and only
then discovers the parts left still need the same sheets — a plan worse by the
packer's own ranking (`isBetter` puts sheets first, then boards), produced anyway
because the alternative was never generated. The strategy portfolio now runs both
ways, rack-first and sheets-only, and keeps the winner. It costs one more greedy
pass per packing, still sub-millisecond, and cannot lose: where a remnant
genuinely saves a sheet, that pass wins on sheets.

`sheetsOnly` has to EXCLUDE remnants rather than stop preferring them. Without a
preference, candidates are sorted smallest-fits-first and a remnant is nearly
always the smallest thing that fits — so "don't prefer" and "don't use" are not
the same instruction, and only the second produces the alternative plan. Two
existing tests had to change with it: both asserted the rack was used on jobs
where it saved nothing, which is the behaviour that was wrong.

**The demo now argues the register honestly.** The reception job is five
carcasses, ten sides and twenty-five shelves — quantities chosen because at that
size the 1180x620 remnant saves a whole sheet: 11 sheets and one offcut at
AED 3,193.80 against 12 sheets at AED 3,408.00. At six carcasses the same remnant
saves nothing and the optimiser correctly leaves it alone, which is the other
half of the point. The doors job takes nothing off the rack, because a 2100x900
leaf is bigger than every remnant there is.

Verified in a browser against the seeded demo: both plans render, 12 and 24
boards, every drawing decoding at its natural size, no horizontal overflow, and
the arithmetic checked by hand — 10 sides at 1.44 m² and 25 shelves at 0.6844 m²
is 31.51 m² of parts across 11 sheets and one 0.7316 m² remnant, 33.4764 m²
opened, 94.13% yield, AED 3,193.80. Every figure on the screen agrees.

One measurement recorded rather than fixed: the packer does not always reach a
plain grid. 800x400 into 2440x1220 admits a 3x3 (2406.4 x 1206.4 at a 3.2mm
kerf); the free-rectangle split produces 8, an 11% shortfall on that shape. Same
cause as the known gap already noted in `optimise.ts` — the split commits to a
shape of leftover before the rest of the parts are known. Closing it needs a real
search, not a greedy pass.

### Localisation becomes something a person can do

The README's second sentence is that country specifics are data rather than code.
That was true of the schema and invisible in the product: `POST
/localisation/adopt` had no caller, so a new workspace could not be configured
through the application at all, and the three-layer rule resolution — the
architectural claim a whole document is written about — could not be seen, let
alone changed.

Two screens. `/settings` adopts a country and shows what adopting it produced:
the tax codes and the requirement set, grouped by who they apply to.
`/settings/rules` lists every configurable number in the system **with the layer
that answered it**, and lets an admin override the ones that are not statutory.

**The layer is the whole point, and it is why this is not a settings form.** An
administrator's first question about any number in an ERP is not "what is it" but
"who decided it"; `10%` on its own is what makes people ring the supplier, and
`10% — because the UAE pack says so` does not. `default` renders as a warning
rather than neutrally: it means no country has an opinion and the software picked
something. Statutory rules are listed and locked with the reason, because an
admin who cannot find the retention rule concludes it is missing rather than
fixed by law.

Building it found three things.

**The domain filter showed 4 of 18.** `resolveDomain` matches on the KEY prefix;
the chip on the screen means the declared `domain` column. Those coincide for
`payroll` and `hr` and diverge badly for `contract`: 18 rules are declared in
that domain and only four have keys starting `contract.` — the rest are
`contracts.`, `estimation.` and `projects.`, because a module declares which
domain a knob belongs to independently of what it named the knob. A filter
showing four of eighteen is worse than no filter, because it looks complete. The
endpoint now filters on the column.

**The summary rescoped itself under a filter.** "Set by you 1, from the country
pack 3" read as a statement about the workspace and was a statement about the
`contract` domain. It is now computed on the server over the whole set whatever
the caller filtered to — the same reasoning as the offcut register's
whole-register value, and for the same reason: a figure that silently rescopes is
a figure that gets quoted wrongly.

**A JSON value stretched the table to 2,240px.** `contract.retention.release_schedule`
and `tax.invoice.mandatory_fields` serialise to a single long token with no break
opportunity, and an unconstrained cell grows the column to fit it — which pushed
the override form off the side of the screen at every viewport width tested. The
document did not overflow, because the table scrolls inside its own container, so
nothing looked wrong; the primary action of the page was simply not visible.
Capped and breakable, the table is 1,178px and fits at 1024 too.

The endpoint also now returns each rule's definition — label, description, value
type, unit, default, and whether it may be overridden at all. A page of
`payroll.overtime.weekday_multiplier = 1.25` with no label is a page nobody can
safely edit.

Verified in a browser: the Settings section appears for the owner and is absent
for the non-owner quantity surveyor who lacks `kernel.localisation.manage`;
overriding the retention percentage from 10 to 7.5 flips its layer from `country`
to `tenant`, moves the summary from 0/29 to 1/28, and shows `default 10` beside
the new value; a non-numeric entry is refused by the form before it costs a round
trip.

### A workspace can add its own people

Every route in the API was listed and there was no `/users`, no `/roles`, no
`/members`, no invitation of any kind. The RBAC schema had been in the first
migration, 76 permissions were synced into the catalogue on every boot, and the
only way a user or a role existed was a SQL script writing rows. A workspace had
exactly the people the seed had inserted, which is not an ERP.

Three screens' worth of gap closed by `/admin/*` and two pages: People and
Roles, gated on `kernel.user.read`, `kernel.user.manage` and
`kernel.role.manage` — three permissions the kernel had declared and nothing had
ever checked, because nothing asked for them.

**Adding somebody is not "create a user".** `app_user` is global — email is
unique across the deployment and authentication reads it before any tenant is
known, so it carries no RLS — while `membership`, `role`, `role_permission` and
`user_role` are tenant-scoped. The tenant boundary on a member list therefore
comes from `membership`, never from `app_user`, and there is a test that asks
the same owner for the member list of each of their two workspaces and gets
different answers. An email that already has an account is ATTACHED, with its
name and password untouched: a tenant admin adding a colleague must not be able
to rename or re-credential an account that is not theirs.

**No invitation email, and the screen says so.** This deployment has no mail
transport, so a token nobody can be sent is a flow that cannot complete. The
admin sets an initial password and hands it over. `membership.status` keeps its
`invited` value for when SMTP exists; pretending an email went out is how
somebody waits three days for a link that was never sent.

**Owner is not a role with everything ticked.** `requirePermission` returns
early for an owner — it is the permission matrix not running — so the People
screen says `owner · bypasses all checks` rather than rendering it as one more
badge. The last owner cannot be demoted, suspended or removed: a workspace with
no owner is one nobody can administer, because the only way back is the matrix
and granting on it requires somebody who already can.

Suspending or removing revokes the person's sessions in the same transaction. A
suspension that leaves a live token is a statement of intent, not a control.

Three things the build found:

- **63 of 76 permissions had no category.** Only the kernel declared any, so
  five sixths of the permission matrix grouped under "Other". Rather than edit
  63 manifest entries, the sync defaults a module permission's category to the
  module's NAVIGATION label — the word the person already sees in the sidebar,
  so the matrix is grouped the way the application is. `category` was also
  missing from the sync's conflict update, which meant a manifest correcting one
  would never have landed on an existing row.
- **The demo had no roles at all.** Two members, one an owner who bypasses the
  matrix, the other with an empty permission set — so every gate in the
  application had only ever been exercised against somebody it did not apply to,
  and Rana, the quantity surveyor the approval workflow routes to, could sign in
  and see nothing but her inbox. The seed now creates a Quantity Surveyor role
  (an approval target, so a workflow survives the person leaving) and a
  Storekeeper, and gives Rana the first.
- **A failed submission emptied the form.** React 19 resets an uncontrolled form
  once its action settles, which is right after a success — post a movement, get
  a fresh form — and destructive after a failure: an eight-field form that comes
  back "set a password of at least 12 characters" came back blank. `ActionForm`
  now captures what was submitted and restores it on error only, clearing
  checkboxes first so a box the user unticked does not come back ticked.

**And a 500 on every permission-gated page.** Measured as a storekeeper: five of
eight pages tried — `/projects`, `/contracts`, `/estimating/tenders` and both
new settings screens — returned an unhandled `ApiError` and a blank 500 when
their URL was typed. The navigation hides those links, so the way there is a
stale bookmark, and neither that nor a typo deserves a crash. `pageFetch` turns
a 403 or 404 into `notFound()`, `fetchList` does the same, and an in-shell
`not-found` renders with the navigation still beside it. A screen your role does
not reach answers exactly like one that does not exist — the same choice the API
already makes for a module a tenant has not bought — and the page names both
readings so nobody is left guessing which it was.

Verified in a browser end to end: a permission granted to Storekeeper saves; a
new person added with a short password is refused **and keeps what was typed**;
added properly with the Storekeeper role they appear on the list; adding the
same email again is refused as already a member; and signing in as them shows
Inventory and an approvals inbox and nothing else — no Projects, no Contracts,
no Settings — with `/settings/members` answering not-found rather than crashing.

The suite also cleans up the roles it creates. It passed the first time and
failed the second, which is the same "idempotent by accident of always running
against a fresh database" fault recorded twice already in this log.

### A payment application you can send

A valuation that only exists on a screen is not a valuation. Applications are
sent to a client's cost consultant, marked up, and sent back — so the document
was the last thing on the README's own "not built yet" list that nobody had
deferred.

`@aerolith/pdf` writes PDF 1.7 with **no dependencies**, the same rule as
`@aerolith/cutlist` and for the same reason. HTML-to-PDF means shipping Chromium
to the deployment target, which on the free-tier VM this is designed for costs
more memory than the database, and a payment certificate is text, rules and a
table. Only the base-14 fonts are used, so nothing is embedded and a certificate
is four kilobytes.

Three parts that are easy to get wrong and were got wrong first:

- **The cross-reference table is measured in bytes, not characters.** Every
  object's offset has to point at the byte its header starts on. Measure lengths
  in UTF-8 while writing Latin-1 and every offset after the first accented
  character is out by one, and the file opens as "damaged" rather than as wrong.
  There is a test that pins this with `Société Générale — Café, £250`.
- **Text width is measured, not estimated.** Adobe's core metrics are in the
  writer, because right-aligning a column of money by guessing an average
  character width puts a ten-digit figure through the edge of the page often
  enough to matter, and a column of figures that does not share a right edge
  cannot be read down at all.
- **The footer is stamped after the last page exists.** "Page 2 of 5" cannot be
  written before page five does, which is why so many reports say "page 2 of 2".

**The first certificate came out full of question marks.** The base-14 fonts are
WinAnsi-encoded and the placeholder for a missing value was an em dash, so
`Employer / client` printed as `?` and so did every ` — ` separator on the page.
An em dash is punctuation, not script: a hyphen loses nothing. The writer now
transliterates a small set — dashes, curly quotes, ellipsis, non-breaking space,
the bidi marks `Intl` puts around Arabic currency — and measures widths after
folding, or a right-aligned figure drifts by the difference in character count.
Arabic and CJK are deliberately NOT in that table, because there is no faithful
Latin reading of them: they stay unrenderable, and the document says so on itself
rather than letting the recipient discover it.

That last point is what the integration test actually catches. Removing the
transliteration makes it fail on `AED ` — because `Intl` puts a non-breaking
space between the currency and the number, so the currency formatting itself
depends on the fold.

**Generated on demand, not stored.** The certified figures change after
submission, and a stored file would be the version before the client replied.
The document is a view of the record; the record is the record.

The browser reaches it through a Next route handler rather than linking at the
API, because the session token is in an httpOnly cookie that client JavaScript
cannot read — which is the entire reason it is httpOnly.

Verified by rendering the generated file in Chromium's own PDF engine and reading
it: `file` calls it "PDF document, version 1.7, 1 page(s)", every figure agrees
with the seed (415,000 gross, 10% retention of 41,500, net 373,500, 5% tax of
18,675, applied 392,175, certified 340,000 and the −33,500 difference), the
download lands as `IPC-2026-00001.pdf`, the quantity surveyor who holds
`contracts.application.read` gets it, and the storekeeper gets 403.

**And a bug from the previous entry, found and fixed here.** The mechanical
conversion of page fetches to `pageFetch` also caught eight write calls sitting
inside `'use server'` functions in page files. `pageFetch` turns a refusal into
`notFound()`, which inside an action is a control-flow error that `runAction`
catches and reports as "something went wrong" — losing the real message. Those
are back on `apiFetch`, which is what returns a message.

### A trail that could be recorded but not read

`recordAudit` has been called from every mutation across five modules — projects,
estimation, production, inventory, procurement, contracts — since each of them was
built. `kernel.audit_log` is append-only, redacts salary/passport/bank fields
before a row is written, and has been filling up the whole time. Nothing could
read it back except a database client with the owner credential, which is a
strange place for "who approved this variation" to live.

`entityHistory` (one entity) and `actorActivity` (one actor, already known) were
the only queries the kernel offered, and both need an ID in hand before they are
useful — neither answers "what happened in this workspace recently", which is
where an actual investigation starts. `listAuditEvents` does: tenant-scoped,
paged through the same `parseListParams`/`ListResult` machinery every other list
endpoint uses, filterable by entity type and action, searchable across the actor's
name, email, the entity's label and the recorded reason.

The two filter chip rows — entity type, action — are populated from what the
tenant's trail actually contains (`listAuditEntityTypes`, `listAuditActions`), not
from the full fourteen-value `audit_action` enum. A tenant whose modules only ever
create, update and delete should not be offered ten dead chips for actions nothing
has done, and the count is taken **unfiltered**, the same rule the localisation
rules screen's domain list follows — a filter's own other options must not
disappear once it is applied.

`changes` is returned exactly as it was written. Redaction already happened in
`recordAudit`, so a redacted field renders `[redacted]` on this screen because
that is genuinely what the database holds — there is nothing further to hide at
read time, and nothing further that could leak even if there were.

Gated on `kernel.audit.read`, a permission the catalogue has declared since the
first migration and nothing had ever checked. New in this entry: an integration
test that signs in as the site engineer role from the delivery narrative — three
`projects.*` permissions, nothing from `kernel` — and confirms the endpoint
actually refuses it, which is the first thing in the whole suite to exercise that
omission.

### A work order followed from routing to the floor

The list screen answered "which orders exist and roughly where they are". It
could not answer "what is actually happening on THIS one" — which operation it
is sitting at, who has scanned against it, whether a failed quality gate is
quietly blocking every station behind it. That is a detail screen's job, and
the work order was the last one of the five flagged as "endpoint exists, no
screen" that was actually missing an endpoint too: `getWorkOrderProgress`
returned the bare `workOrder` row — a `routingId` and a `workCentreId` per
operation, nothing a person could read. Fixed at the service, not papered over
in the route: the query now resolves the project, item and routing by name, and
joins each operation to its work centre's code and name.

Everything on the page is derived from scans, the same reducers the shop-floor
board already uses — no status field somebody has to remember to update. The
one write this screen offers is releasing to the floor; scanning happens at the
machine against a barcode, and a web form re-typing "start operation 3" would
be a screen for a user who does not exist. A `Cutting plan v1 →` link appears
the moment one has been planned, so the drawing is one click from the order it
belongs to rather than a search through the register.

### An estimate you can read past the total

Same gap, one module over: `GET /estimating/estimates/:id` returned the bare
`estimate` row plus its lines — a `tenderId` with nothing a person could read
next to it, exactly like the work order before this entry. Fixed the same way,
at the route: the query now joins the tender's number, name, status and client,
so the header can say "Business Bay lobby and lift lobbies · Emaar Properties
PJSC" instead of two ids.

Cost and margin redaction, which already existed in this route, is untouched —
`estimation.margin.view` is a separate permission from reading an estimate, and
the screen says so in a sentence rather than rendering columns that quietly
disappear. **Raise work order** appears only once the tender the estimate
belongs to is actually won and Production is bought; **Submit as bid** only
while the estimate is still a draft. Neither button asks a commercial user a
production-planning question — no routing or project picker, because the
person converting a bid to a job is not the person who should be assigning it
to a saw.

### A tender, with the three parties it actually involves

The tender list resolves a client name; the detail screen needed all three —
client, consultant and main contractor are frequently different
organisations, and no endpoint existed to read a single tender at all before
this entry, only the list. `getTenderDetail` joins `kernel.party` three times,
aliased apart, alongside the tender's own priced versions newest first.

Bid/no-bid and won/lost are modelled as decisions, not status edits, and the
screen keeps that: each is its own small form asking for a reason, because
"why did we not bid the Marina job" is a question asked six months later by
someone who was not in the room. Both forms disappear once a tender is
abandoned, cancelled, won or lost — the outcome form otherwise let a no-bid
tender be recorded as "won", which the service itself does not forbid but
which nothing sane means.

### A requisition, with what it spends against

Same shape again, one more module over: no endpoint read a single requisition
before this — the list joined a project code, and that was as far as it went.
`getRequisitionDetail` resolves the project, the cost centre, and the
requester and approver by name (two more aliased joins on the same
`kernel.app_user` table, the same technique the tender detail entry used
against `kernel.party`).

`quantityOrdered` is kept per LINE rather than rolled up to the requisition as
a whole. A requisition is actioned line by line — a buyer sources the timber
from one supplier and the ironmongery from another — and a single blended
"60% ordered" figure would hide exactly the line still sitting unsourced.
Approve is the one action this screen offers, one click and no confirmation:
nothing commits to a supplier until an order is issued, so approving a
requisition is reversible in the sense that matters, and a confirmation
dialogue on a routine authorisation only trains people to click through
dialogues.

## Phase 3 — Commercial completion (months 14-20)

**Accounts/GL** (start the ledger design early even if it ships here — everything
must be able to post to it), **Sales/CRM**, **Quality/QA-QC**, **Job costing
dashboards**.

## Phase 4 — Operations (months 20-28)

**HR & Payroll**, **Accommodation**, **Logistics & Fleet**, **Assets**,
**Maintenance/CMMS**, **HSE**, **Service Desk** (which absorbs IT Management).

## Phase 5 — Platform & scale (ongoing)

Customer/supplier portal · integration hub and public API · advanced BI · mobile
polish · tenant billing and self-serve onboarding · localisation packs for the
second country.

## Notes, risks and things to decide early

**Get the data model right before the features.** Item, party, project, cost code,
UoM and the GL are the six things you cannot cheaply change later. Everything else
is refactorable.

**Build the boundary enforcement in week one, not month twelve.** dependency-cruiser
plus the ESLint import rule. A modular monolith without mechanical enforcement is
just a monolith with good intentions.

**Resist premature extraction.** Do not pull a module into a service until a
specific, measured problem demands it. The outbox design means you can, cheaply,
when the day comes.

**Do not build a generic "workflow builder" for everything.** Build the approval
engine (bounded, well-understood) and resist the pull toward a general-purpose BPM
platform. That is a product in itself and it will consume the whole roadmap.

**Multi-currency and multi-company from day one** in the schema, even if the UI
does not expose them. Adding a currency column to a live ledger is a migration
nobody enjoys.

**Design the invoice model for e-invoicing now.** UAE is moving to a Peppol-based
model; confirm the current FTA timeline, but include the required identifiers,
line-level tax codes and document references from the first migration.

**Offline is a scoped feature, not an architecture.** Six specific flows need it
(stock count, GRN, production scan, QC/snag, POD, site attendance). Do not attempt
a fully offline ERP.

**Your data-import story is a sales feature.** Every prospect has ten years in
Excel. A good Excel importer with validation and dry-run preview closes deals.
Budget real time for it.

**Single point of failure.** One free VM. The backup restore test in
`04-infrastructure.md` is what makes that acceptable. Move to paid hosting with a
managed database the week you sign customer one — that is a cost of revenue, not a
cost of building.

**Use your own factory as customer zero.** The fastest route to a good ERP is a
short feedback loop with real users who cannot ignore your bugs. Run the business
on it before selling it.

**Licence hygiene.** Keep dependencies MIT/Apache/BSD. Watch for AGPL and for
"open source" packages with commercial add-on tiers (AG Grid, some chart libraries)
where the feature you eventually want is behind the paywall. Check before adopting,
not after building on it.
