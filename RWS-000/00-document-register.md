# RWS-000 — RackWatch Documentation Register

**Revision:** 1.1  
**Status:** Controlled Release  
**Owner:** RackWatch Systems Ltd

## Purpose

RWS-000 is the authoritative register for controlled RackWatch engineering documents. It records the current document set, revision/status, ownership and publishing rules so that the latest valid issue can be identified without relying on chat history or local file copies.

## Current controlled document set

| Document | Title | Revision | Status | Notes |
|---|---|---:|---|---|
| RWS-000 | Documentation Register | 1.1 | Controlled Release | This document |
| RWS-001 | Engineering Specification | 1.0 | Developer Issue | Canonical publishing reference implementation |
| RWS-002 | Technical Specification | 1.0 | Developer Issue | Companion technical implementation baseline |
| RWS-003 | Reserved | — | Not issued | No document assigned at this time |

## Publishing baseline

RWS-001 Revision 1.0 is the canonical visual and structural reference for all future controlled RackWatch documents. New documents inherit its cover geometry, document-control structure, heading hierarchy, body styles, tables, callouts, margins, headers and footers rather than independently interpreting the Word template.

The RackWatch Master Controlled Document Template v1.0 remains the reusable template asset, but where any ambiguity exists between the template and an issued document, RWS-001 Rev 1.0 governs the visual implementation.

## Legal entity and copyright

The legal entity for RackWatch documentation and product-development purposes is **RackWatch Systems Ltd**. Controlled-document footers use **© RackWatch Systems Ltd**.

## Status definitions

- **Working Draft** — active engineering work; content may change materially.
- **Internal Review** — issued for owner/engineering review and comment.
- **Engineering Baseline** — core technical direction agreed; change requires explicit review.
- **Developer Issue** — suitable for external developer scoping, quotation or implementation.
- **Controlled Release** — approved governing or operational reference.
- **Superseded** — retained only for traceability; not valid for current work.

## Revision convention

- **0.x** — working drafts before the first controlled issue.
- **1.0** — first controlled issue of a document.
- **1.x** — incremental controlled revisions that do not redefine the overall document purpose.
- **2.0+** — major revision where architecture, scope or document intent changes materially.

## Source of truth

`RackWatchHQ/Chat` is the persistent engineering documentation workspace for RWS-000, RWS-001, RWS-002 and the controlled template assets. Markdown source files are maintained for persistent content; issue-ready Word documents are generated from the controlled publishing system.

## Developer pack baseline

For initial external developer discussions and quotation, the developer pack consists of **RWS-001 Rev 1.0** and **RWS-002 Rev 1.0**. Additional documents are introduced only where they serve a defined engineering or delivery purpose.

## Current publishing assets

| Asset | Version / Reference | Status |
|---|---|---|
| RackWatch Master Controlled Document Template | v1.0 | Frozen |
| Documentation Design Language | v1.0 | Frozen |
| Canonical reference implementation | RWS-001 Rev 1.0 | Locked |
| Legal entity | RackWatch Systems Ltd | Current |
