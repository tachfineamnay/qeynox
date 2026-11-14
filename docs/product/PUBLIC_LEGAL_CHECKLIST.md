# Public website — legal data to complete before publication

The public pages implement the actual data and cookie usages found in this repository. The following
fields are intentionally **not invented** and must be verified by the operator (and, where relevant,
legal counsel) before the site is published:

- [ ] Legal entity name and legal form
- [ ] Registered office address
- [ ] Registration number (trade and companies register)
- [ ] VAT number, if applicable
- [ ] Publication director
- [ ] Hosting provider: name, address and contact
- [ ] Data protection contact / DPO, if designated
- [ ] Competent jurisdiction and applicable law
- [ ] Data retention periods, legal bases per purpose, international transfer safeguards
- [ ] Processors and their locations (hosting, database, Chatwoot support when enabled)
- [ ] Cookie/storage configuration owner and consent tooling if optional cookies are added
- [ ] Public contact address, or confirmation that no public channel is offered
- [ ] Any commercial terms or prices (none are displayed today)

The visible "to be completed before publication" blocks on `/[lang]/legal/*` and
`/[lang]/contact` must be removed or replaced only once the corresponding data is verified.

Cookie facts currently implemented: public pages set no cookies; the workspace app uses the
strictly necessary HTTP-only `qx-session` cookie; QeyNox Control uses `qx-control-session`. No
analytics, advertising or social tracking is configured.
