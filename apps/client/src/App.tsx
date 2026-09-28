import { useEffect, useState } from "react";
import { WINS_TO_CLEAR, type RunReward, type RunState, type TurnResponse } from "@pokebattles/game";
import { createApi, type Account, type GameApi } from "./api.ts";
import { BGM, useBgm } from "./audio.ts";
import { useI18n } from "./i18n.tsx";
import { BattleScreen } from "./screens/BattleScreen.tsx";
import { ChampionSelect } from "./screens/ChampionSelect.tsx";
import { LeaderboardScreen } from "./screens/Leaderboard.tsx";
import { Login } from "./screens/Login.tsx";
import { RunEnd } from "./screens/RunEnd.tsx";
import { RunScreen } from "./screens/RunScreen.tsx";
import { Title } from "./screens/Title.tsx";
import { TrainerCard } from "./screens/TrainerCard.tsx";

export type Screen =
  | { k: "title" }
  | { k: "champion"; ranked: boolean }
  | { k: "leaderboard" }
  | { k: "trainer" }
  | { k: "run"; state: RunState }
  | { k: "battle"; turn: TurnResponse; before: RunState }
  | { k: "end"; state: RunState; reward?: RunReward };

/** Title music on the login and title screens, the menu theme while choosing, the GTS themes in the shop, the opponent champion's theme in battle. */
function screenBgm(screen: Screen): string {
  switch (screen.k) {
    case "title":
      return BGM.title;
    case "champion":
    case "leaderboard":
    case "trainer":
      return BGM.menu;
    case "run":
      return BGM.shop(screen.state.round);
    case "battle":
      return BGM.battle(screen.turn.battle.opponent.champion);
    case "end":
      return screen.state.wins >= WINS_TO_CLEAR ? BGM.cleared : BGM.menu;
  }
}

export function App() {
  const { tr } = useI18n();
  const [api, setApi] = useState<GameApi | null>(null);
  /** undefined while loading; null when a login is needed. */
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [screen, setScreen] = useState<Screen>({ k: "title" });

  useEffect(() => {
    createApi().then(async (a) => {
      a.onUnauthorized = () => setAccount(null);
      setApi(a);
      setAccount(await a.account().catch(() => null));
    });
  }, []);

  useBgm(!api || account === undefined ? null : account === null ? BGM.title : account.profile.champions.length === 0 ? BGM.menu : screenBgm(screen));

  // A new screen starts at the top (on a phone the start button is far down the champion list).
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen.k, account === null]);

  if (!api || account === undefined) return <div className="boot">{tr.t("title")}</div>;

  const refresh = () => api.account().then((a) => a && setAccount(a)).catch(() => undefined);
  const toTitle = () => {
    refresh();
    setScreen({ k: "title" });
  };

  if (account === null) {
    return (
      <Login
        api={api}
        onLogin={(a) => {
          setAccount(a);
          setScreen({ k: "title" });
        }}
      />
    );
  }

  // A new player picks their free first champion before anything else.
  if (account.profile.champions.length === 0) {
    return (
      <ChampionSelect
        api={api}
        account={account}
        mode="starter"
        onAccount={setAccount}
        onBack={api.mode === "online" ? () => api.logout().then(() => setAccount(null)) : undefined}
        onStart={(state) => setScreen({ k: "run", state })}
      />
    );
  }

  switch (screen.k) {
    case "title":
      return (
        <Title
          api={api}
          account={account}
          onNew={(ranked) => setScreen({ k: "champion", ranked })}
          onLeaderboard={() => setScreen({ k: "leaderboard" })}
          onTrainerCard={() => setScreen({ k: "trainer" })}
          onLogout={() => api.logout().then(() => setAccount(null))}
          onContinue={(state) => setScreen(state.phase === "ended" ? { k: "end", state } : { k: "run", state })}
        />
      );
    case "champion":
      return (
        <ChampionSelect
          api={api}
          account={account}
          mode={screen.ranked ? "ranked" : "normal"}
          onAccount={setAccount}
          onBack={() => setScreen({ k: "title" })}
          onStart={(state) => setScreen({ k: "run", state })}
        />
      );
    case "leaderboard":
      return <LeaderboardScreen api={api} onBack={() => setScreen({ k: "title" })} />;
    case "trainer":
      return <TrainerCard api={api} account={account} onAccount={setAccount} onBack={() => setScreen({ k: "title" })} />;
    case "run":
      return (
        <RunScreen
          api={api}
          initial={screen.state}
          onBattle={(turn, before) => setScreen({ k: "battle", turn, before })}
          onQuit={toTitle}
        />
      );
    case "battle":
      return (
        <BattleScreen
          turn={screen.turn}
          before={screen.before}
          onDone={() => {
            const { state, reward } = screen.turn;
            if (state.phase === "ended") {
              refresh();
              setScreen({ k: "end", state, ...(reward ? { reward } : {}) });
            } else {
              setScreen({ k: "run", state });
            }
          }}
        />
      );
    case "end":
      return <RunEnd state={screen.state} reward={screen.reward} onTitle={toTitle} />;
  }
}
