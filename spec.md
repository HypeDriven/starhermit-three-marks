# Three Marks — running specification

Three Marks is a turn-based alignment game: two sides alternate marks on a chalk slate (3×3, 4×4 or 5×5) and the first to complete a line of the required length (three, or four on the wide boards) wins; a full board with no line is an honest draw. It is a StarHermit engine **script game** (engine 1.29.0, host API minor 31), played natively by the StarHermit client and in browsers by the engine's web runtime from the same package.

## Modes and content
- **Learn** — five interactive lessons (Making a Mark, Taking Turns, Complete a Line, The Block, The Honest Draw). Every step needs the player's own action, checked through the rules' legality API; a failed step resets.
- **Journey** — 40 authored stages in five chapters (sealed cells, move limits, misère, wider boards, clocks, series), each chapter ending in a mastery stage. A stage unlocks when the previous one has a star; stars: 1 for a win, 2 for winning a round within par marks, 3 for also staying within par time.
- **Daily** — one ruleset and seed per UTC day (platform clock when it has answered, else the device's). The first attempt is ranked; replays and assisted runs are unranked.
- **Practice** — free play against the AI (Casual / Skilled / Expert, board 3/4/5, single round or best of 3/5, either side); Undo and Hint allowed, never rated. **Play** on the title starts a practice match with the setup's current choices.
- **Challenge** — six constrained standalone goals (10-second clock, four-mark limit, hollow centre, grand board, comeback, misère).
- **Hosted Play** — shows that head-to-head hosted matches are not available in this build (as in the browser build: it never had online play). Nothing is recorded from hosted play.
- Five visual themes (Slate & Chalk, Ink & Paper, Night Grid, Sunbaked Dune, Deep Current); Journey chapters, challenges and dailies pick their own, Practice uses the chosen theme.
- Scoring (rules.js scoreBreakdown): round completed, objective, speed and efficiency bonuses, clean play, difficulty multiplier, series bonus. Six achievements (First Line, Quick Study, Journey Master, Five Days Running, Grand Slate, Century of Marks).

## Screens
Title (Play, Resume interrupted match, Sign in / Invite a friend, cards for the Daily, Journey, All Modes, Profile) → Choose a Mode (six mode cards) → Journey list, Challenges, Learn, Practice Setup, Hosted Play. Profile (identity, statistics, friends note, shortcuts to Achievements, Settings, How to play). Settings (theme, camera angle, left-handed controls, confirm before placing, timing assistance, colour palette, a button to StarHermit Options, reset progress with a confirmation sheet). How to play (rule cards with example boards, the effective key bindings, gamepad note). Every screen has Back (Escape) and a Settings button.

Sheets: match setup (rules summary, opponent, series, par, best; Start / Cancel), pause (Resume, Settings, How to play — both return to the pause sheet —, Leave match), results (headline, stars, score breakdown, series score, achievement badges, recommendation, leaderboard line; Retry / Play again (unranked), Next stage, Back to modes), lesson complete (Next lesson / Start playing, All lessons).

The HUD: objective, turn banner, both clocks on timed rulesets, Pause, the player's name and the cloud line (Synced / Saving… / Offline / Local); the match rail (content, round or series, rules, seed) and the actions rail (Undo, Hint, Camera) beside the slate from 1024 logical px (swapped for left-handed play); narrower windows show only the actions as a bottom bar, and portrait phones put the objective on its own row. Toasts at the bottom.

## Controls
- Pointer / finger: tap or click a cell to place a mark (with *Confirm before placing*, the first tap selects, the second places). A mouse shows a ghost mark under the pointer (red over an illegal cell). A drag tilts the camera slightly.
- Keys (rebindable in Options): arrows move the selection ring, Enter/Space place, Escape cancels / goes back / pauses, P pauses, U undoes, H hints, C cycles the camera angle (standard, top-down, low). The action formerly named `cameraReset` is `camera` now (custom bindings of it start from the default).
- Gamepad: D-pad / left stick moves, South places, East cancels, Start pauses, West undoes, North hints, right stick press changes the camera.
- Screen readers and play scripts see every cell as a named target ("Row 2, column 3: empty, available").

## Rules, AI and time
- js/rules.js (pure, deterministic), js/session.js (state machine, series, clocks, undo, lessons, progress) and js/content.js are the browser build's; the session takes injected timers and an AI hook.
- The session's timers run on the runtime's fixed steps (60 a second), so matches replay exactly; its platform time is the platform clock at start plus that clock.
- The practice AI and the hint (js/ai.js) search on a `starhermit:script` worker (native/ai-worker.js). The search runs on a compact board that makes exactly the browser build's choices (same order, node cap, terminal rules, evaluation, seeded stream; checked against the old ai.js in tests/ai.test.mjs) about 5× faster; Expert on the 5×5 board takes about a second natively.

## Look and sound
- The slate on `starhermit:scene` as the three.js r160 page drew it: wooden frame, procedural slate surface and etched grid, sealed-cell plugs, chalk X/O tubes drawn stroke by stroke, win line, ghost, selection and lesson rings, chalk dust and lamp-light motes, desk props, the authored camera with intro swoop and win pulse, fog fitted to the camera.
- Minor 23 follows three r185 lights and shadows, so the page's own values are used (key 2.6 with its fitted shadow box, bias −0.0005, normal bias 0.015, radius 4; rim 0.7; hemisphere 0.9 / 0.55 with reflections). Reflections: `new RoomEnvironment(renderer)` prefiltered at sigma 0.04, given to each lit material as its envMap with the page's envMapIntensity (r160 scaled scene.environment by each material's intensity; minor 23 scene.environment does not).
- Graphics follow the runtime's quality tier (native/quality.ts = gfx.js presets and budgets: shadows, GTAO, bloom, the display-space grade and vignette, antialiasing, particles, detail). Bloom is the r160 page's UnrealBloomPass (model "r160", strength 0.3); the grade is the page's S-curve (contrastCurve "s", 0.22) with its 0.98/+0.012 lift as display-space levels. The runtime owns Auto, render scale, frame-rate limit and readout.
- Sound: the authored one-shots (sfx/*.opus), the per-theme ambience and the adaptive two-sine music pad, rendered into looping clips. The ambience plays on the music bus (the runtime has no ambience bus).

## Platform
- Save: the sealed progression document (js/storage.js) as the engine save (schema 1, device + cloud); conflicts merge with mergeProgression; the browser build's cloud slot (game:<slug>) is merged in once as a foreign save. The interrupted-match snapshot stays on the device.
- The game's options are engine settings; the browser build's settings KV values (theme, camera, palette, left-handed, confirm moves, timing assist) are adopted once and the old keys removed. Volumes, graphics, language, key/pad bindings, reduced motion, high contrast, text size and vibration are the runtime's Options.
- Leaderboard: signed in, unassisted Journey, Daily and Challenge matches post their total through score-script.js (range-checked, `high-score`), and the results show the rank.
- Strings in nine locales (js/strings.js), following the runtime's interface language.
- server.js is the browser build's unused sandbox host-contract script; it is not the manifest's server and not packaged.

## Checks
- `npm test`: node unit tests (rules, session, progression, content, i18n keys in all locales, AI parity, save/options migration) and tests/native.mjs (web index up to date, tsc, `starhermit check` without warnings, the native play scripts: journey (desktop, won match), learn-phone (all lessons by touch at DPR 3), menus (every screen, pause flows), landscape-practice (keys, hint, undo, camera)).
- `npm run plays` regenerates the journey and lesson scripts from the real session in node.
- `npm run test:browser` plays the web package in Chrome on the GPU at desktop, phone and landscape sizes.

## Known limitations
- Hosted head-to-head play does not exist (unchanged from the browser build).
- The old Graphics panel's per-effect overrides and the in-game key-binding editor are replaced by the runtime's Options.
- Guests' old browser localStorage progress can't migrate; cloud saves do.
