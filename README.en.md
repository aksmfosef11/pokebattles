# PokéBattles (포켓배틀즈)

**English** · [한국어](README.md)

A Backpack Battles–style roguelike async-PvP Pokémon auto-battler. It takes only the data, sprites, localized names, music and sound effects
from PokéRogue; the battle rules were written from scratch for an auto-battler. The game rules and the gimmicks of the 9 champions are in
[docs/DESIGN.md](docs/DESIGN.md) (written in Korean).

This is a non-commercial fan project. The Pokémon IP belongs to Nintendo, Creatures and GAME FREAK. The legal notice and the contact for takedown
requests are in [LICENSE.md](LICENSE.md) (Korean and English), and sources and terms are in [data/SOURCES.md](data/SOURCES.md). The same notice is shown
under the login and title screens (`apps/client/src/components/LegalNotice.tsx`).

## Service closing, and carrying the project on

The online service **closes on November 7, 2026**. The source code stays in this repository, so if you want to carry the project on, download it and use it.
Just `git clone` → `pnpm install` → `pnpm dev` as described under "Running it" below, and it runs on your own PC with no database or config file
(the account you create at first exists only on your machine).
Before changing anything, read [docs/DESIGN.md](docs/DESIGN.md) (the game rules) and the "Structure" and "Tests" sections below.
If you want to open a server for other people, follow "Deployment (Docker)" below.
The real play statistics collected while the service was running (win rates per champion, Pokémon and item, and so on) are in
[data/live-stats](data/live-stats/README.en.md). Start there if you want to try a balance patch.
The rights to the Pokémon images, music and so on belong to their owners, so use them only within the terms of [LICENSE.md](LICENSE.md): a non-commercial fan project.

## Running it

You need Node 20.19 or newer and pnpm 10.

```sh
pnpm install
pnpm dev          # API server (:8787) + client (:5173) together
```

Open http://localhost:5173 in a browser. The first time, sign up with an ID and a password (4+ characters each, nothing else) and pick your first champion.
If the client cannot reach the server, it switches to offline mode, which runs the same game logic inside the browser
(no login, progress saved in this browser, bots and the ghosts of your own earlier runs as opponents, no ranked mode).

You do not need to install PostgreSQL for development. Without `DATABASE_URL`, the server uses PGlite (a real PostgreSQL running as WASM)
in `apps/server/data/pglite`. To run against a real PostgreSQL on your dev machine, pass it like `DATABASE_URL=postgres://… pnpm dev`.

## Database

The database for a real service is **PostgreSQL**. What this game stores is interlinked relational data (accounts, sessions, runs, ghosts, battle records, settlement results);
points and rating must be paid out exactly once, using transactions and row locks (`SELECT … FOR UPDATE`); and both matchmaking
(the most recent ghost of each round, one per player) and the balance statistics are naturally SQL (window functions, aggregates).
Game data whose shape changes often, such as run state and ghost teams, lives in JSONB columns.
Several servers can share one database, and it can go as is onto a managed PostgreSQL (RDS, Cloud SQL, Supabase, Neon and so on).

| How you run it | Database |
|---|---|
| With `DATABASE_URL` (docker compose, a real service) | That PostgreSQL. Pool size is `PG_POOL_MAX` |
| Without `DATABASE_URL` (`pnpm dev`, a lone server container via `docker run`) | Embedded PGlite in the `POKEBATTLES_PGDATA` folder (default `apps/server/data/pglite`, Docker `/data/pglite`). Only one process can open it |
| `pnpm test` | In-memory PGlite. With `TEST_DATABASE_URL=postgres://…` it runs in a temporary schema of a real PostgreSQL and drops it afterwards |

The server brings the schema up to date at startup using the migration list in `apps/server/src/schema.ts` (applied numbers are recorded in the `schema_migrations` table).
To add a column, append a new number to the end of the list; never edit an entry that has already been deployed.
The old SQLite files (`apps/server/data/*.sqlite`) held only test data and were not migrated. A new database starts empty.

## Deployment (Docker)

The server (API) and the client (the pages) are separate images. From the repository root:

```sh
cp .env.example .env        # be sure to change POSTGRES_PASSWORD; set ADMIN_TOKEN etc. if you need them
docker compose up -d --build
```

| Service | Address | What it is |
|---|---|---|
| `client` | http://localhost:8080 | nginx serves the built pages and forwards `/api` to `server` |
| `server` | http://localhost:8787 | The API only. Connects to `db` through `DATABASE_URL` |
| `db` | (not exposed) | PostgreSQL 17. Data is in the `pokebattles-pg` volume. User, password and database name are the `POSTGRES_*` values in `.env` |

Backup and restore:

```sh
docker compose exec db pg_dump -U pokebattles -Fc pokebattles > pokebattles.dump
docker compose exec -T db pg_restore -U pokebattles -d pokebattles --clean < pokebattles.dump
```

You can also use the server image alone: `docker build -f apps/server/Dockerfile -t pokebattles-server .` →
`docker run -d -p 8787:8787 -e DATABASE_URL=postgres://user:pass@host:5432/pokebattles pokebattles-server`
(started without `DATABASE_URL` but with `-v pokebattles-data:/data`, it stores into the PGlite inside the container; only with a single container).
If you host the pages somewhere else (static hosting and the like), build the client with `VITE_API_URL=https://api.example.com` and give the server `CORS_ORIGIN`.

| Server environment variable | Default | Description |
|---|---|---|
| `PORT` | 8787 | |
| `DATABASE_URL` | none | PostgreSQL address (`postgres://user:pass@host:5432/db`). For TLS append `?sslmode=require` |
| `PG_POOL_MAX` | 10 | PostgreSQL connections one server opens |
| `POKEBATTLES_PGDATA` | `apps/server/data/pglite` (Docker: `/data/pglite`) | The PGlite folder used when there is no `DATABASE_URL` |
| `ADMIN_TOKEN` | none | If set, `GET /api/admin/stats` (balance statistics) can be read with `Authorization: Bearer <token>` |
| `CORS_ORIGIN` | none | Comma-separated page addresses. Only when the pages are hosted somewhere other than the API |
| `REGISTER_PER_HOUR` | 10 | Sign-ups per hour per client address (IP), against mass-created alt accounts. 0 = no limit. Behind nginx it counts the real address nginx passes on |

To run without Docker as a single process, build with `pnpm --filter @pokebattles/client build`, then `pnpm --filter @pokebattles/server start`.
In that case the server also serves `apps/client/dist` (or `CLIENT_DIST`).

## Balance statistics (real play)

The server records every finished run (`run_results`: champion, subclass, wins and losses, final party, items) and every battle
(`battles`: both champions, subclasses, Pokémon, items, result).

```sh
pnpm stats                                        # Markdown report from DATABASE_URL, else apps/server/data/pglite (if it is PGlite, stop the dev server first)
pnpm stats --pgdata ../../backup/pglite           # another PGlite folder (path relative to apps/server)
pnpm stats --since 2026-10-01 --ranked            # a period / ranked mode only (--normal: normal mode only)
pnpm stats --min-round 8 --min-sample 30 --out stats.md   # battles from round 8 on, samples of 30+ only (--out path relative to apps/server)
docker compose exec server node dist/stats.mjs --since 2026-10-01   # Docker
curl -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:8787/api/admin/stats?format=md&ranked=true"
```

You get, per champion: runs, pick rate, average wins, clear (trophy) rate, wins distribution and battle win rate (with battles against player ghosts split out); per subclass:
pick rate and average wins; the champion matchup table; and battle win rates and final-party average wins per Pokémon and per item. The bot team in a battle against a bot
is not the player's choice, so it is left out of the Pokémon and item statistics.
Read it together with `pnpm balance` (the bot simulation) when tuning.

## Structure

| Path | What it is |
|---|---|
| `packages/game` | Pure TypeScript game rules. The client, the server and offline mode all use this same code. |
| `packages/game/src/run` | Run state, shop, bag grid placement, evolution and economy progress |
| `packages/game/src/battle` | Action-gauge battle simulator, move-choice AI, Mega / Dynamax / Z / Tera |
| `packages/game/src/server` | Round handling (server-authoritative replay, ghost saving, matchmaking), bots |
| `packages/game/src/meta` | Account progress: points, recruiting champions, per-champion Pokémon unlocks, ranked rating |
| `packages/game/locales` | The game's own text (ko, en). Pokémon, move and item names are not here. |
| `apps/server` | Hono + PostgreSQL API (accounts, runs, ghosts, ranking, statistics), Docker image |
| `apps/client` | Vite + React pages, Docker image (nginx) |
| `tools/extract` | Extracts data, locales and sprites from pinned PokéRogue / PokeAPI commits |
| `tools/content` | Turns the extracted data into game content and per-language bundles |

## Rebuilding the data

```sh
pnpm extract                                  # download the pinned commits into vendor/ and build data/pokerogue, data/i18n
pnpm sprites                                  # copy sprites, icons, music and sound effects into apps/client/public/assets
pnpm content                                  # packages/game/src/generated/content.json and the client locale bundles
```

The roster (the species that get sprites) is in `data/roster-ids.json`; the move-effect mapping and the size and tier rules are in `tools/content/build-content.ts`.

The music and sound effects are PokéRogue's files as they are (`assets/audio`; the list and loop points are in `tools/extract/lib/audio.ts` → `assets/audio/manifest.json`).
The title and login screens play PokéRogue's title theme (Firel, CC BY-NC-SA 4.0), champion select plays the menu theme, and the shop alternates BW/XY GTS tracks by round.
Battles play **the opponent champion's real champion-battle theme** (Red = Kanto, Lance = Johto, Steven = ORAS Hoenn, then Cynthia, Alder, Diantha, Kukui, Leon, Geeta).
To change a track, edit `BGM` in `apps/client/src/audio.ts` together with the list above. Music is downloaded only when it is played (streaming).

### Adding a Pokémon

`data/pokerogue` already holds all 1025 National Dex species, so adding one is just a matter of putting it in the roster.

1. Put the PokéRogue species number into `species` in `data/roster-ids.json`. It is usually the National Dex number; regional forms are in the 2000s (Alolan Ninetales = 2038).
   Add a whole evolution line (evolutions outside the roster are ignored).
2. `pnpm sprites` → `pnpm content` → `pnpm test`.

Base stats, types, abilities, names in 28 languages, learnsets, TM / egg-move candidates, cell size, shop tier, evolutions and Mega / Gigantamax forms are automatic.
An ability that is not implemented behaves as "no effect" (see the `pnpm content` output and `IMPLEMENTED_ABILITY_KEYS`).
To change a tier such as legendary, edit `TIER_OVERRIDE` in `build-content.ts`; to keep something out of the shop, edit `NOT_IN_SHOP`.
A shop only offers **Pokémon of that champion's generation and the lines of the champion's real party (`squad` in `champions.ts`)**, so a new species appears only in the shop of the champion whose generation fits.

### Balance check

```bash
pnpm balance --fast --seeds ,b   # for checking an adjustment: both seeds at once, without the best-party search (about 15 min on 12 cores)
pnpm balance                     # the final report: with the best-party search, one seed (about 40 min on 12 cores)
pnpm balance --quick --fast      # a rough 2-minute check
```

For each champion it builds 150 bot runs at rounds 8 and 14 (unlucky p10, normal, lucky p90) and a best party (searched inside the pool), pits them against a 108-team reference field,
and writes the win rate between top-10% runs ("luck vs luck") to `docs/balance-report.md`. The same seed gives the same result, so compare before and after an adjustment with the same seed.

After changing the balance, re-measure the ranked-mode bots' ratings too (about 8 min on 12 cores, about 2 min with `--quick`):

```bash
pnpm bot-ratings   # bots by luck level vs the normal bot → packages/game/src/generated/bot-ratings.json
```

## Async PvP flow

0. When you log in, the server hands out a session token, and every request names the account with `Authorization: Bearer <token>`.
1. The client applies the shop-phase actions (buying, placing, selling and so on) locally right away and records them.
   Only the server knows the run's seed (the `seed` in the state the client receives is an empty string). So the actions that need the seed
   (rerolls, opening Poké Balls / exchange tickets / fossils, picking a subclass) cannot be computed by the client; it sends them, with the actions up to that point, to
   `POST /api/runs/:id/act`, and the server applies them, **commits** them, and returns the resulting state.
   A committed action cannot be undone, so you cannot peek at results by reordering. Later actions continue from the commit point.
2. At the start of a battle the client sends the record since the last commit; the server replays the committed actions plus the new record through the same pure functions and commits the board.
   Every action is checked for shape first (piece ids only from your own board, coordinates integers inside the board, rotation 0–3, shop slots 0–4).
3. The server saves that board as the ghost of that round and simulates the battle against another player's ghost of the same round and a similar number of wins (a bot if there is none).
   Ranked mode meets ranked ghosts within ±300 rating, and the closer the rating the more often. If there is none, a bot matched to the rating (differing only in luck) appears.
4. The client replays the same battle with the same seed to animate it.
5. On the turn a run ends, the server settles points, per-champion unlocks and rating exactly once and puts them in the response (`reward`).
   The rating is the sum of Elo results against the opponent's rating in each battle (the ghost owner's rating at that time; for a bot, its measured strength).

## Tests

```sh
pnpm test         # game rules, battle gimmicks, account progress, API
pnpm typecheck
```
