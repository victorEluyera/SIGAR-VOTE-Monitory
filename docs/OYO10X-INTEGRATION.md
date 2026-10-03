# 10x aggregate integration

Configure the SIGAR backend with `OYO10X_API_URL=https://oyo10x.oyoahead.com/api/external/v1`
and an `OYO10X_API_KEY` created under Platform accounts → External API keys.
The reader also accepts a full URL ending in `/all`. Keep the key in backend
environment settings; never use a frontend `VITE_` variable or commit the key.

The existing authenticated `/all` request supplies every section below. No
additional field-work request is made. Successful 10x deployment and loading its
APC matching source are separate prerequisites for live verification.

## Field work

`field_work` is whitelisted into `fieldWork`. The 10x Sentiment card prefers this
aggregate over the uploaded field survey. An explicitly empty aggregate stays
empty; it does not fall back to the upload. Older payloads without `field_work`
retain the uploaded-survey fallback.

Positive/negative/neutral shares divide by the classified sentiment answer count,
not registrations or submitted responses. `other` is displayed separately.
`sentiment_available=false` displays “No sentiment answers collected”. Topic
counts can overlap and are never added to calculate response totals. Submitted
responses include pending/rejected reviews.

LGA selection aggregates matching PU locations. Questions are keyed by task ID
and question ID together. INEC identifiers remain strings; unresolved codes remain
null. The drill-down shows collection dates in Africa/Lagos, daily state totals,
question distributions, LGA/PU counts and invalid payload counts. Original free
text and unexpected respondent fields are excluded.

## APC matching

`apc_promoter_overlap.loaded` controls availability. Its distinct identity count
is exposed as `apcPromoterOverlap.matchedPromoters` and
`totals.apc10xPromoters`; `matchedPromoterRecords` is a separate row count.
Unloaded/missing counts remain null; a loaded zero remains zero.

Overview labels the count as promoters matching the supplied APC list. It is not
independent membership verification. It is not subtracted from volunteer totals
or added to “our voters”: promoter overlap is not a deduplication result for all
10x volunteers, and the supplied APC source may differ from SIGAR's member lists.

Fixtures in `server/integrations/fixtures` are synthetic, not live statistics.
