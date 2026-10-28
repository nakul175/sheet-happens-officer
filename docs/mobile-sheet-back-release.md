# Mobile task sheet and overlay Back release

User authorized the recommended bounded mobile batch on28October2026. Base is deployed release d565d1769e80ad17d238edc8c4d86862c7d34cc0. Port only SHO2555/2616 behavior from integration d9507f05c33757dd68793b113ca58465e3acdfdb; exclude Workload, notification/privacy, structured Activity and unrelated feature changes.

Acceptance: phone320–599 full viewport,44px Close and scroll lock;150-character title and300-character reason readable without inner scrolling; description/footer visible with keyboard;600px+ centered dialog; Viewer read-only; Back/Escape focus return; topmost drawer/More/Move/Concierge dismissal; unsaved-description/comment/subtask preservation and existing confirmation; direct-link/reload no loop; with nothing open Back behaves normally. Keep filters/query/hash and opaque router state, and never put drafts or credentials into history.

Browser viewport/keyboard emulation is not physical-device proof. Real iPhone Safari toolbar/keyboard and Android Back checks remain required before acceptance closure. No expected failures, skipped cases or collection-only reports count as passes. Preserve cleanup failures.

Deployment SHO owns all staging and production execution, uploads and rollback rehearsals. This engineering branch performs none. No schedules.
