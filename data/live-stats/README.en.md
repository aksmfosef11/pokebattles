# Real play statistics (live service, 2026-09-26 – 2026-11-04)

**English** · [한국어](README.md)

Aggregated statistics collected from the real PokéBattles online service. If you want to try a balance patch, use these numbers as your starting point.
428 players, 6,282 finished runs, 58,380 battles (58,335 of them between players). Downloaded on 2026-11-04 at 13:15 UTC.

| File | What it is |
|---|---|
| [all.md](all.md) · [all.json](all.json) | The whole period, normal + ranked. **Close to 40 server builds are mixed together** (see caution 1 below) |
| [ranked.md](ranked.md) | The whole period, ranked mode only |
| [build-11fa19fcac.md](build-11fa19fcac.md) | 2026-10-05 08:36 – 10-14 18:03 (UTC) · 1,292 runs |
| [build-d62715d5d0.md](build-d62715d5d0.md) | 2026-10-14 18:07 – 10-30 00:09 · 584 runs |
| [build-2b15b34f31.md](build-2b15b34f31.md) | 2026-10-30 01:28 – 11-04 13:13 · 124 runs |

The `.md` files are the readable reports, and `all.json` holds the same content in a form a program can read easily. All times are UTC.

## What the reports contain

Per champion: runs, pick rate, average wins, clear rate, wins distribution and battle win rate; battle win rate by round range; subclass results; the champion matchup table (battles between players);
per-champion economy (gold, rerolls, spending); battle win rates per Pokémon and per item (best 25 and worst 25); in-battle performance (damage share, KOs, survival);
shop pick rates (how often it was bought when shown); results by experience, unlock stage and start items; and the list of server builds. The columns are explained in [docs/DESIGN.md](../../docs/DESIGN.md) §8 (Korean).
Entries with fewer than 20 battles are left out. Bot teams are not the player's choice, so they are excluded from the Pokémon and item statistics.

## Cautions when reading

1. **The rules differ by period.** Each patch changes the server build, and `all.*` is the sum of all of them, so it does not show the balance of the latest rules.
   Compare before and after a patch using the `build-*.md` files. A build name is a hash that changes with every deployment where the server code changed, so you have to match it to commit times in `git log`.
   - `11fa19fcac` starts right after commit `bb61e8b` (10-05, Pikachu Volt Tackle) was deployed.
   - `d62715d5d0` starts right after commit `24c8af5` (10-15 balance patch, the last commit in this repository) was deployed.
   - There is no commit in the repository for `2b15b34f31` (from 10-30). It may be a redeployment of the same code as above, or not, and the sample is small (124 runs), so treat it as a reference only.
2. **Players differ a lot in skill.** Some individuals played over 200 runs. The correlation between the same player's odd and even runs is 0.49 (0 means luck, 1 means skill),
   so a large part of the results is player skill, not the champion. The tendencies of the people who pick a champion are mixed in as well.
3. **Win rates of Pokémon and items are not causes.** Strong builds tend to be picked by experienced players, so a high win rate does not mean the thing itself is strong. Read it together with the pick rate.
4. With a battle sample under a few hundred, ±5 percentage points can swing by chance.

## Balance patching with this data

1. Find champions whose average wins or clear rate stand out in the champion table. Over the whole period, Steven has the highest average at 5.01 wins,
   and Lance the lowest at 3.72 wins and a 12.2% clear rate (the Champions table in `all.md`). Check with `build-*.md` whether it is the same in the latest builds.
2. The rules are in `packages/game/src/content/champions.ts` (champion rules, early-game bonuses), `packages/game/src/content/items.ts` (items) and `packages/game/src/run/` (shop, progression). The design intent is in [docs/DESIGN.md](../../docs/DESIGN.md) §6 (Korean).
3. After changing something, check it with the bot simulation: `pnpm balance --quick --fast` (about 2 minutes). The targets (bot-run median 40–60% and so on) are in DESIGN.md §6.
   Bots cannot pile items the way people do (for example on Red's ace), so bot numbers and real-play numbers can differ; look at them together with these statistics.
4. To open a new server and collect your own data, follow the "Balance statistics (real play)" section of the [README](../../README.en.md) (`pnpm stats`).

## What is not included

The per-player table (IDs, ratings, number of runs per champion) and the raw per-run and per-battle records are left out because of personal information and size.
