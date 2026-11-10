import { warn } from "../constants.mjs";
import { getSetting, setSetting, settingDef, effectiveNetwork } from "../settings.mjs";
import { TEMPLATE, L, warnOnce } from "./common.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const SCOPE_ICONS = { all: "fa-solid fa-layer-group", session: "fa-solid fa-forward", off: "fa-solid fa-ban" };

/**
 * A player still has to answer the first-run card on this browser: they are not a game master, they have not
 * answered yet, and the world uses at least one of the two things the card asks about.
 * @param {object} [eff]  `effectiveNetwork()`, when the caller already has it
 */
export function needsConnectionChoice(eff = effectiveNetwork()) {
  return !game.user.isGM && !getSetting("connectionChoiceDone") && (!!eff?.p2p || !!getSetting("preloadEnabled"));
}

/**
 * The card a player sees once per browser, the first time they open a world that shares files between players or
 * downloads ahead: share with the other players or not (players who share see each other's IP address), and how
 * much to download ahead. The answers are the client settings `p2pParticipate` and `preloadScope`, preselected with
 * their defaults (lighter on a data-saver or cellular connection), and stay editable in "My connection".
 * Until the player answers, `connectionChoiceDone` stays false and the swarm opens no connection to other players;
 * closing the card without answering brings it back at the next session.
 */
export class ConnectionChoice extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "optimal-foundry-first-run",
    classes: ["optimal-foundry", "of-settings", "of-first-run"],
    tag: "form",
    window: { title: "OPTIMALFOUNDRY.FirstRun.Title", icon: "fa-solid fa-wifi", contentClasses: ["standard-form"] },
    position: { width: 460, height: "auto" },
    form: { handler: ConnectionChoice.#onSubmit, closeOnSubmit: true }
  };

  static PARTS = {
    form: { template: TEMPLATE("first-run"), scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const share = !!getSetting("p2pParticipate");
    const scope = getSetting("preloadScope");
    return Object.assign(context, {
      // Each question only when the world uses that feature.
      sharing: !!effectiveNetwork().p2p,
      share: [true, false].map(yes => ({ value: yes ? "yes" : "no", checked: yes === share, icon: yes ? "fa-solid fa-share-nodes" : "fa-solid fa-ban",
        label: L(yes ? "FirstRun.ShareYes" : "FirstRun.ShareNo"), line: L(yes ? "FirstRun.ShareYesLine" : "FirstRun.ShareNoLine") })),
      preload: !!getSetting("preloadEnabled"),
      scopes: Object.keys(settingDef("preloadScope").choices).map(id => ({ id, icon: SCOPE_ICONS[id], checked: id === scope,
        label: L(`Settings.preloadScope.Choices.${id}`), line: L(`FirstRun.Scope.${id}`) })),
      buttons: [{ type: "submit", icon: "fa-solid fa-check", label: "OPTIMALFOUNDRY.FirstRun.Save" }]
    });
  }

  static async #onSubmit(_event, form) {
    const data = new foundry.applications.ux.FormDataExtended(form).object;
    try {
      // The answers first: the swarm must read them before it learns that the player has chosen.
      if (data.share) await setSetting("p2pParticipate", data.share === "yes");
      if (settingDef("preloadScope").choices[data.preloadScope]) await setSetting("preloadScope", data.preloadScope);
      await setSetting("connectionChoiceDone", true);
    } catch (err) {
      warn("first-run card: could not save the choice", err);
      ui.notifications.error(L("Dashboard.Notify.ActionFailed", { error: err?.message ?? String(err) }));
    }
  }
}

/** Open the card, or bring an open one to the front (rendering it again would reset the picks). */
export function openConnectionChoice() {
  const open = foundry.applications.instances.get(ConnectionChoice.DEFAULT_OPTIONS.id);
  if (!open?.rendered) return new ConnectionChoice().render({ force: true });
  open.bringToFront();
  return open;
}

/** Registered at init: at ready, a player who has not answered on this browser gets the card. */
export function registerFirstRun() {
  Hooks.once("ready", () => {
    try { if (needsConnectionChoice()) openConnectionChoice(); } catch (err) { warnOnce("first-run card", err); }
  });
}
