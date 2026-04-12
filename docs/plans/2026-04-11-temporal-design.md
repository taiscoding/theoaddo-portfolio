# Temporal View Design
**Date:** 2026-04-11
**Status:** Approved

## Problem

The OS has no sense of time as a navigable dimension. Tasks have due dates, goals have target dates, journal entries have timestamps — but there is no place to stand and see across time. The result is a familiar failure mode: poor recall of the past, chronic overwhelm in the present, and a vague anxiety about the future because it lives only in your head.

The goal is cognitive restoration through cognitive offloading. The brain cannot offload time to a system it does not trust to hold it accurately. This feature builds that trust.

Grounded in episodic memory theory: the hippocampus encodes experience as episodes with what, where, when, who, and emotional tone. A temporal view should reflect that structure, not a calendar grid.

## Architecture

A new page, `/admin/time.html`, alongside `chat.html` and `capture.html`. Visited intentionally, not always visible.

The OS nav gets one small addition: a dot next to a "Time" link.
- Amber: something upcoming in the next 48 hours
- Green: nothing urgent
- Absent: nothing scheduled

No counts, no text, no content in the nav itself.

**New API endpoints:**
- `GET /api/theo-os/time/past` — journal entries, completed tasks, connection touchpoints with timestamps. Sorted by recency, filterable by date range and area.
- `GET /api/theo-os/time/future` — open tasks with due dates, goals with target dates, structured as weighted probability paths.
- `GET /api/theo-os/time/now` — triggers Claude Haiku digest generation. Response cached in KV, invalidated on write (capture saves, task edits, journal entries). Background writes (memory extraction) do not invalidate.

No schema changes required for v1. Location (lat/lng) is a future layer — schema additions will be additive and non-breaking.

## The Past Zone

A reverse-chronological timeline. Entries cluster by day, not hour, because episodic memory encodes at the day level.

**Sources:** journal entries, completed tasks, connection touchpoints.

**Each episode card shows:**
- Content snippet (journal excerpt, task title, person name)
- Day and relative time ("3 days ago", "last Thursday")
- Location label if lat/lng present (placeholder for v1, surfaced when location capture is added)
- Linked people as small chips
- Optional subtle tint from emotional score in memories table (warm/cool) — toggle, off by default

**Filtering:** by person, area (work/life/health), or a date range slider. Default: last 30 days. Continuous scroll, no pagination.

## The Now Zone

A single generated paragraph, 3 to 5 sentences, produced by Claude Haiku on page load. Reads like a trusted friend catching you up. Not a dashboard, not a list.

**Sources:**
- Open tasks due within 7 days
- Goals with near-term target dates
- People flagged for next touchpoint (overdue or upcoming)
- Recent journal patterns (recurring themes from the last week)

**Caching:** KV key `time:now:digest`. Invalidated on any explicit user write action (capture, task edit, journal entry). Regenerated on next page visit after invalidation. Background writes do not invalidate.

**UI:** Digest text, then a faint "Updated X min ago" timestamp, then a small refresh icon. Clicking refresh regenerates the digest and resets the cache. Below the digest: a chip row of 3 maximum highest-weight open items. Clicking a chip opens the relevant record or hands off to chat.

## The Future Zone

Probabilistic paths, not a flat to-do list. Grounded in the Futures Cone model: the future is not one guaranteed timeline, it is an assortment of possible paths with varying probability.

**Path construction:** Tasks and goals are grouped by life area (work, health, relationships, creative). Each group becomes a path. Path weight is the aggregate weight of its constituent items, adjusted for recency of captures and touchpoints.

**Visual distinction:**
- Probable paths (high weight, recent activity): fully rendered, prominent
- Possible paths (low weight, no recent activity): faint, smaller, at the visual periphery

**Each path shows:**
- Anchoring goal or theme
- 2 to 3 key tasks
- Horizon label: "this week," "this month," "this year," "someday"
- Connected people as small avatars

**Maximum visible paths:** 3 to 5 by weight. The rest exists in the system, not on screen.

**Due date behavior:**
- Far out: horizon label reads "this month" or "this year"
- Approaching: label shifts to "this week," "in 3 days," "tomorrow" — task rises visually within its path
- Completed early: task moves to Past zone as an episode. Path dims or drops if it was the anchor.
- Overdue: task dims slightly, horizon label reads "overdue," path weight drops. No red badges. The Now zone digest surfaces it calmly on the next visit.

Urgency is expressed through position and visual weight, not alarm colors.

## Key Design Principles

- **The system holds time; you retrieve it.** Nothing is pushed at you. You visit when you need to orient.
- **Cognitive offloading requires trust.** The system must be accurate and current, not a stale approximation. This is why the Now cache invalidates on write.
- **Calm honesty over performed urgency.** Overdue things dim, they do not scream. The system is truthful without catastrophizing.
- **Episodic structure, not calendar structure.** Days, not hours. Episodes with context, not rows in a grid.
- **Future as probability, not obligation.** Possible paths exist but stay quiet at the edges. You are not punished for paths not taken.

## Out of Scope (v1)

- Location capture at save time (requires browser Geolocation API + lat/lng schema columns)
- Map rendering (Leaflet integration)
- Time-travel slider for replaying a specific date
- Collaborative / shared paths
