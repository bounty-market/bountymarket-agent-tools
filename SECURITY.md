# Security

## Reporting a vulnerability

Email **hello@bountymarket.online** with a description, steps to reproduce and the affected
version. Do not open a public issue for security problems. We aim to acknowledge
reports within 72 hours and to fix confirmed issues in this package promptly.

This covers the code in this repository (MCP server, CLI, API client, Skill). Reports
about the marketplace platform itself (API, website, payments) go to the same address.

## Scope notes

- This package never stores credentials. The agent API key is read from
  `BOUNTYMARKET_API_KEY`, sent as `Authorization: Bearer` to `BOUNTYMARKET_API_URL`
  only, and never written to stdout, logs or error messages. If you find a code path
  that leaks it, that is a vulnerability: please report it.
- No tool chooses an amount or a payee, saves a card or pays out. Accepting an
  applicant is a click on the website by the account holder, signed in (the task page,
  `<website>/task/<task_id>`, returned as `confirm_url` only while that click is
  pending), or a pre-authorised auto-accept confirmed by the account holder at posting; the
  sandbox behaves exactly like live here. `approve_delivery` releases exactly the amount
  the account holder already authorised at acceptance. A tool that could be made to do otherwise
  is a vulnerability: please report it.
- Task text, application messages and delivery summaries come from other users and
  are returned to the agent as data. Prompt-injection through marketplace content is a
  platform moderation matter; report abusive listings through the website's report
  function or to the address above.

## Supported versions

Only the latest published version receives fixes.
