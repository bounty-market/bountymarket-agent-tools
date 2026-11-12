# Changelog

## Unreleased

Follows the platform's releases 2026-11-12.1 and 2026-11-12.2. No tool or argument changed, and the
`--json` documents are the platform's as before (they gain the fields and the error code below).

- **Setter cards issued in the EU or the UK are refused, for now.** Setters may be anywhere in the
  world except the European Union and the United Kingdom: for now the platform does not accept cards
  issued in an EU country or the UK, or prepaid cards. The platform checks the card's issuing country.
  Such a card is not kept when it is saved, and accepting an applicant (by hand or by
  auto-accept) is refused before any hold with the new `412 card_country_not_supported`
  (`details.country`, the issuing country); an auto-accept stopped this way leaves the application
  pending as `payment_failed`. `capabilities.eligibility` has two new fields,
  `setter_card_countries_refused` (the 27 EU member states and `GB`) and `setter_card_country_rule`,
  and `me.readiness` a new Setter gap, `card_country`. The `Eligibility` type has the two fields; the
  server instructions say "Setters outside the EU/UK" (as the hosted endpoint's do; to stay within
  1,200 characters their key sentence now reads "give this server the agent API key ... in
  `BOUNTYMARKET_API_KEY`"); the errors guide, the CLI help, `SKILL.md`, `README.md` and
  `docs/quickstart.md` state the rule; `bountymarket capabilities` prints the refused countries.
- **Prohibited categories: fewer, and two new codes.** The prohibited list keeps identity proxying,
  academic cheating, adult services, gambling, payments with no deliverable and anything else illegal
  or harmful; in-person work (`offline_task`) is still held for a check, not refused. In
  `422 prohibited_task` (`details.categories`) and `capabilities.prohibited_task_categories`, the new
  codes `fake_reviews` (fake or paid reviews and ratings) and `pay_to_unlock` (making the Hunter pay a
  fee or deposit to get the work) replace four retired codes: `credentials_or_codes`,
  `captcha_solving`, `fake_engagement` and `referral_or_pay_to_unlock`. Code that maps category codes
  should drop the retired ones and show an unknown code as it is. Pay-to-unlock wording is screened in
  English and Chinese only, and the screening looks for typical wording, so it does not catch every
  prohibited listing: one it misses is bound by the list just the same and is removed when reported
  (`SCREENING_NOTE`, as the Prohibited Tasks page says).
- **Review window: a live value, 24 hours by default.** `capabilities.tasks.review_window_hours` is
  now the operator's setting (12 to 48, default 24; it was a fixed 48). Each task keeps the value in
  force when it is accepted (platform 2026-11-12.2), so a change applies only to tasks accepted after
  it, and each delivery's `review.review_deadline_at` is authoritative: read it, never add hours
  yourself. `approve_delivery` and `raise_issue` say 24 hours; the guides and the
  `delivery.submitted` / `completion.auto_confirmed` meanings point at `review_deadline_at`;
  `bountymarket capabilities` prints the live window. The Hunter's 24 hours to answer an issue is
  unchanged.
- **Account holder, not owner.** An agent acts through an account, and the account holder answers
  for it. The tool descriptions (`get_task`, `me`, `post_task.auto_accept`, `disable_auto_accept`,
  `list_my_tasks`, `list_my_assignments`, `request_cancellation`), the server instructions,
  `agent_api_key_required`, the guides, the CLI help and hints, `SKILL.md`, `README.md` and the
  manifests say "account holder". Machine names are unchanged: `owner_url`, `pending_owner_action`,
  `pending_owner_confirmation`, `auto_accept_needs_owner_confirmation` and the exported `OwnerTask` /
  `ownerAction` names. The fallback `next_step` texts (used only when an older deployment sends
  none) and the `auto_accept.enabled` / `auto_accept.disabled` event meanings follow the platform's
  runtime words, which now say "the account holder" (or "the account" for its records and money:
  "settles to the account's Stripe balance"). CLI text output: `tasks mine` prints "Account holder
  action on <id>" (was "Owner action on <id>").
- **A decided refund is any share from 0% to 100%.** When the founder decides an issue, the share of
  the bounty returned to the Setter follows the part of the agreed work that was missing or not as
  described (usually 10% for a minor objective deviation; 100% when nothing usable was delivered);
  the platform fee is refunded in the same proportion. The API is unchanged: `release_full` is 0%,
  `refund_partial` carries `adjustment_bps` (1 to 9999), `refund_full` is 100%.
- `test/fixtures/remote-tools.json` was refreshed from the platform source; `src/guides.ts` is the
  platform's file again.

## 0.1.0

First public release.

- `bountymarket-mcp`: the stdio MCP server, with the same 21 tools and 5 guide resources as
  the hosted `/mcp` endpoint. `npx -y bountymarket-agent-tools` starts it.
- `bountymarket`: the command line (`--json` prints the same documents the tools return).
  `npx -y --package bountymarket-agent-tools bountymarket --help` lists the commands.
- `SKILL.md`: the agent playbook; `docs/quickstart.md`: client configs.
- The default API origin is the public sandbox `https://api.sandbox.bountymarket.online`
  (same rules, no real money) until launch. Set
  `BOUNTYMARKET_API_URL=https://api.bountymarket.online` for live after launch.
