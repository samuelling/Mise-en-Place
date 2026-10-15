# Mise en Place

An Overcooked-style solo kitchen game that measures how you divide attention. Every pot on the stove and every ticket on the rail is a deadline; the game logs each one and fits four model families in the background. No trials, no instructions beyond "cook".

Play: open `index.html` (GitHub Pages serves it from the repo root). Three shifts, about 7 minutes. Keyboard (WASD/arrows, Space, hold J/E) or touch (stick, Grab, Chop).

## What gets measured

| Panel | Data | Models compared |
|---|---|---|
| Capacity | Each deadline (pot cooking→plated, ticket printed→served) scored met/missed, with its time-averaged concurrent load N | **Slot**: P = (1−λ)[min(1,K/N) + (1−min(1,K/N))·g] vs **resource**: P = (1−λ)/(1+(N/N50)^β); λ separate for pots and tickets |
| Normalization of attention | Each stove interaction where 2+ stoves were legal given what you held | Drive Eᵢ (urgency, exp(−time-to-burn/6 s), or fill level) × attention field A(d) = 1+exp(−d²/2ω²) around the last stove worked; **normalized** R = D/(σ+ΣD), choice softmax(βR) vs **unnormalized** softmax(βD) vs **urgency only** |
| Voluntary task switching | Latency from finishing an action to starting to move toward the next, split by whether the next action serves the same pot ("goal stream") | Median difference, bootstrap 95% CI |
| PRP / central bottleneck | Response to each pot-ready ding (first action in that pot's stream) vs SOA from the previous demand | RT = a + max(0, B − SOA) vs flat RT = a |

All fits are maximum likelihood (multistart Nelder–Mead) with BIC comparison.

Load sweeps within a session: burners unlock across shifts (2→3→4), tickets arrive on a 50 s rush/lull cycle, and arrival rate is nudged by a mild staircase on outcomes.

## Data sufficiency (from `test/recovery.js`)

| | 1 service (~90 deadlines, 70 choices) | ~3 services pooled |
|---|---|---|
| K recovery (r) | 0.82 | 0.84 (median error 0.23) |
| Picks resource model when true | 12/25 | 19/25 |
| ω recovery (r) | 0.41–0.49 | 0.83 |
| Picks normalization when true | 11/25 | 22/25 |
| Bottleneck B recovery (r) | 0.91 | 0.92 |

So one service gives usable K and B; the model comparisons want ~3 services. The report has a "This service / All services" toggle; sessions are kept in the browser's localStorage (last 20).

## Export

"Copy results JSON" puts fits plus raw session logs (`threads`, `actions`, `decisions`, `doneEvents`, `demandOnsets`) on the clipboard, in a shape Mind Arcade can ingest.

## Files

- `js/kitchen.js`: simulation core and logging (no DOM; runs in node)
- `js/models.js`: all model fits (no DOM)
- `page.html`: UI, renderer, report. `python3 build.py` wraps it into `index.html`
- `test/recovery.js`: parameter recovery on synthetic players
- `test/bot.js`: headless bot plays a full service, then every fit runs on its log

## Known limits (v1)

- Load counts tickets and pots equally; tickets have long deadlines, pots short ones. Type-specific lapse rates absorb part of that, not all.
- Stove choices are self-paced and the attention-field center is the last stove worked, not gaze.
- PRP response time includes travel to the stove.
