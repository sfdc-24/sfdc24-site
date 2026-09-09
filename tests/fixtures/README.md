# Noindex HTML5 differential corpus

`noindex_html5_corpus.json` is a frozen, dependency-free review artifact for
the `_declines_indexing()` guard in `tests/test_xray_page.py`.

It contains 590 synthetic HTML cases. The tree verdicts were generated with
parse5 8.0.0 using `scriptingEnabled: true`; template contents are deliberately
excluded because they are inert. Metadata semantics are then applied narrowly:
the `robots` name is an exact ASCII-case-insensitive value, and comma-separated
rules are trimmed only with HTML's five space characters before comparison.

The fixture deliberately records cases a browser accepts even when the local
guard rejects them. Those conservative false negatives are allowed: they can
fail CI on a protected page, but cannot falsely certify an unprotected page.
Any local `true` where the fixture says `false` is a release blocker.

Generation receipt:

- cases: 590
- effective: 187
- SHA-256: `f7e381894fb60639cde0eb28685122a5a96d28ea078a05bc305aa554e1e10fad`
- parser: parse5 8.0.0
- generated during independent review of PR #13 on 2026-09-09

The corpus contains no production data, credentials, hostnames, or org
identifiers. It is synthetic test input only.
