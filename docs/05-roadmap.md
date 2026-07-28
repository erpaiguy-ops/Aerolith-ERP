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
