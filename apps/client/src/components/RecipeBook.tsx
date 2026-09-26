import { ITEMS, RECIPES, type ChampionKey } from "@pokebattles/game";
import { useI18n } from "../i18n.tsx";
import { ItemIcon } from "./sprites.tsx";

/** Every combination available to this champion: two touching inputs → output. */
export function RecipeBook({ champion, onClose }: { champion: ChampionKey; onClose: () => void }) {
  const { tr } = useI18n();
  const available = (key: string) => {
    const champs = ITEMS[key]?.champions;
    return !champs || champs.includes(champion);
  };
  const recipes = RECIPES.filter((r) => r.inputs.every(available));
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal panel recipe-book" onClick={(e) => e.stopPropagation()}>
        <h2>📖 {tr.t("ui.recipes")}</h2>
        <p className="muted small">{tr.t("ui.recipeHint")}</p>
        <ul className="recipe-list">
          {recipes.map((r) => (
            <li key={`${r.inputs.join("+")}`} title={tr.itemEffect(r.output)}>
              <span className="recipe-in">
                <ItemIcon item={r.inputs[0]} size={24} />
                <span className="small">{tr.itemName(r.inputs[0])}</span>
              </span>
              <b>+</b>
              <span className="recipe-in">
                <ItemIcon item={r.inputs[1]} size={24} />
                <span className="small">{tr.itemName(r.inputs[1])}</span>
              </span>
              <b>→</b>
              <span className="recipe-in out">
                <ItemIcon item={r.output} size={24} />
                <span className="small">{tr.itemName(r.output)}</span>
              </span>
            </li>
          ))}
        </ul>
        <button className="btn" onClick={onClose}>
          {tr.t("ui.close")}
        </button>
      </div>
    </div>
  );
}
