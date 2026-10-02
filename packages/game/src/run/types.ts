import type { Placement } from "../board.ts";
import type { ChampionKey, SubclassKey } from "../content/champions.ts";
import type { Tier } from "../content/items.ts";
import type { Stats } from "../content/schema.ts";
import type { Nature } from "../stats.ts";

interface PieceBase {
  uid: string;
  /** null = in the stash (bought but not placed; does not fight). */
  place: Placement | null;
  /** What was paid, used for sell value. */
  paid: number;
}

export interface PokemonPiece extends PieceBase {
  kind: "pokemon";
  species: string;
  level: number;
  ivs: Stats;
  nature: Nature;
  ability: string;
  hiddenAbility: boolean;
  shiny: boolean;
  moves: string[];
  /** Legacy: moves the player used to switch off. No longer used; always empty. */
  disabled: string[];
  /** Moves taught by TM; kept when the moveset is recomputed after level-ups and evolutions. */
  taught: string[];
  /** Moves the player gave up for a TM (picked in the TM's move chooser); never chosen again when the moveset is recomputed. */
  forgot?: string[];
  /** Moves the player locked in the move list; they stay in the set when it is recomputed. Unset/empty = nothing locked. */
  locked?: string[];
  /** Battles participated in (friendship evolutions). */
  battles: number;
  /** Red's ace: accumulated permanent stat bonus (0.03 per win). */
  aceBonus: number;
  /** Evolution waiting for enough free space. */
  pendingEvolution: string | null;
  /** The player's name for their trained starter (meta/progress.ts); display only. */
  nickname?: string;
  /** The one move this Pokémon uses while a Choice item powers it (run/choice.ts); unset = its strongest STAB attack. */
  choiceMove?: string;
}

export interface ItemPiece extends PieceBase {
  kind: "item";
  item: string;
  /** Type for tera shards, move key for TMs. */
  param?: string;
  /** Rounds held (Steven's nuggets gain value). */
  age: number;
  /** Extra sell value a nugget earned while lying on a Coin Case. */
  caseGold?: number;
  /** Choice items: the Pokémon it powers, picked by the player (run/choice.ts); unset = the strongest one it touches. */
  choiceFor?: string;
}

export interface BagPiece extends PieceBase {
  kind: "bag";
  bag: string;
}

export type Piece = PokemonPiece | ItemPiece | BagPiece;

export interface PokemonOffer {
  kind: "pokemon";
  tier: Tier;
  species: string;
  level: number;
  ivs: Stats;
  nature: Nature;
  ability: string;
  hiddenAbility: boolean;
  shiny: boolean;
}

export interface ItemOffer {
  kind: "item";
  tier: Tier;
  item: string;
  param?: string;
}

export interface BagOffer {
  kind: "bag";
  tier: Tier;
  bag: string;
}

export type Offer = PokemonOffer | ItemOffer | BagOffer;

export interface ShopSlot {
  offer: Offer | null;
  locked: boolean;
  sale: boolean;
}

export type BattleOutcome = "win" | "loss" | "draw";

export interface RoundLog {
  round: number;
  outcome: BattleOutcome;
  /** `rating`: the opponent's rating in a ranked run (the ghost owner's, or the bot's strength). */
  opponent: { name: string; champion: ChampionKey; ghost: boolean; rating?: number };
  goldEarned: number;
}

export interface RunState {
  v: 5;
  runId: string;
  seed: string;
  playerName: string;
  champion: ChampionKey;
  subclass: SubclassKey | null;
  round: number;
  phase: "subclass" | "shop" | "ended";
  gold: number;
  lives: number;
  wins: number;
  losses: number;
  streak: number;
  /** Rerolls used this round. */
  rerolls: number;
  shop: ShopSlot[];
  pieces: Record<string, Piece>;
  nextUid: number;
  ace: string | null;
  lastOutcome: BattleOutcome | null;
  log: RoundLog[];
  /** Short notes shown after a round: evolutions, spawns, income breakdown. Keys are locale keys. */
  notices: Notice[];
  /** Evolution lines (first stages) of the champion's pool this player has not unlocked yet; absent = full pool. */
  lockedLines?: string[];
  /** Ranked run: matched against other ranked runs and settles the player's rating when it ends. */
  ranked?: boolean;
  /** The player's looks when the run started; copied into its ghosts. */
  cosmetics?: TeamCosmetics;
  /**
   * Who the coming battles are against, as the player sees them (server/logic.ts planRound): this round's
   * opponent and the next round's champion. Fixed when drawn, so reloading cannot change them.
   */
  upcoming?: UpcomingOpponent[];
  /** This round's opponent itself, fixed when the round starts. Server only: publicState removes it. */
  matchup?: Matchup;
}

/** A coming battle's opponent as the player sees it before the battle. */
export interface UpcomingOpponent {
  round: number;
  champion: ChampionKey;
  /** Known once that round's opponent is fixed (and it has chosen one, from round 8). */
  subclass?: SubclassKey | null;
}

/** The opponent fixed for a round: another player's ghost, or a bot built from the run seed. */
export interface Matchup {
  round: number;
  champion: ChampionKey;
  ghostId: string | null;
  /** Ranked bots: the luck (server/bot.ts BOT_LUCK key) matching the player's rating when it was drawn. */
  botLuck?: string;
}

/** Looks a player bought with points (meta/cosmetics.ts). Display only: the battle never reads them. */
export interface TeamCosmetics {
  /** Evolution lines (first stages) drawn shiny. */
  shinyLines?: string[];
  /** Home arena: the background of this side's odd-round battles. */
  arena?: string;
}

export interface Notice {
  key: string;
  params?: Record<string, string | number>;
}

/** Everything the battle needs to know about one side. Stored as the async-PvP ghost. */
export interface TeamSnapshot {
  name: string;
  champion: ChampionKey;
  subclass: SubclassKey | null;
  round: number;
  wins: number;
  losses: number;
  streak: number;
  ace: string | null;
  /** Placed pieces only. */
  pieces: Piece[];
  /** Shiny looks (only lines on this board) and home arena. */
  cosmetics?: TeamCosmetics;
}

export type Action =
  | { t: "buy"; slot: number; place?: Placement | null }
  | { t: "sell"; uid: string }
  | { t: "move"; uid: string; place: Placement | null }
  | { t: "reroll" }
  | { t: "lock"; slot: number }
  | { t: "setAce"; uid: string }
  /** Locks `move` in the Pokémon's set (or unlocks it when it is locked). */
  | { t: "lockMove"; uid: string; move: string }
  /** Choice item `uid` powers the touching Pokémon `target`, which then only uses `move`. */
  | { t: "choice"; uid: string; target: string; move: string }
  | { t: "chooseSubclass"; subclass: SubclassKey }
  /**
   * Consumables used in the shop: TM (target + replace), Master Ball (slot),
   * Poké Ball / Voucher / fossils (open into a new Pokémon in the stash).
   */
  | { t: "use"; uid: string; target?: string; replace?: string; slot?: number };

export class GameError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "GameError";
  }
}
