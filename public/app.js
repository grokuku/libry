/**
 * Libry — interface web (Lot 6 : UI finale).
 *
 * Trois responsabilités :
 *   1. navigation entre les onglets (Documentation / Réglages) — Lot 2 ;
 *   2. le THÈME : la brique `tokens` (vendorisée) est la SEULE à poser les
 *      variables --holaf-* sur :root ; ce fichier choisit un preset
 *      `<famille>-<mode>`, le persiste (`localStorage["libry.theme"]`) et
 *      ALIGNE les briques modal/toast sur le même preset — Lot 2 ;
 *   3. l'interface fonctionnelle (Lot 6) :
 *        - Documentation : liste (`GET /api/librarian/library`), filtre 100 %
 *          CÔTÉ CLIENT (jamais `POST /search`, qui déclenche la cascade web),
 *          vue détaillée (`GET /api/librarian/doc/:name`), suppression (modale)
 *          et réindexation ;
 *        - Réglages : session (déconnexion après connexion, bandeau « mot de
 *          passe par défaut », changement de mot de passe), clés API
 *          (création/régénération/suppression, secret affiché UNE seule fois),
 *          paramètres groupés (`GET/PUT /api/admin/settings`).
 *
 * Porte d'entrée : au chargement, `GET /api/admin/session` tranche — hors
 * session, SEUL l'écran de connexion (#login-screen) est affiché ; le
 * conteneur applicatif (#app) reste masqué jusqu'à `authenticated: true`.
 *
 * Le premier rendu (anti-flash) est déjà posé par le boot inline du <head>.
 *
 * CSP / CSS : les feuilles de modal/toast sont servies en FICHIERS statiques
 * (public/vendor/holaf/*.css, extraits par scripts/extract-holaf-css.mjs),
 * d'où `configure({ injectStyles: false })` — aucune balise <style> ni attribut
 * `style=` n'est posé (CSP `style-src 'self'`).
 *
 * Chargement : ce fichier est un MODULE (comme les briques devant lui dans
 * <body>) — l'exécution est différée et strictement ordonnée, les globales
 * window.Holaf* sont donc déjà posées.
 */
(() => {
  "use strict";

  // ── Briques holaf ────────────────────────────────────────────────────────
  const tokens = window.HolafTokens || null;
  const icons = window.HolafIcons || null;
  const modal = window.HolafModal || null;
  const toast = window.HolafToast || null;
  const http = window.HolafFetch || null;

  // ── Onglets ──────────────────────────────────────────────────────────────

  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = {
    docs: document.getElementById("panel-docs"),
    settings: document.getElementById("panel-settings"),
  };

  /** Affiche l'onglet demandé et masque les autres. */
  function activate(name) {
    for (const tab of tabs) {
      const selected = tab.dataset.tab === name;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", selected ? "true" : "false");
    }
    for (const [key, panel] of Object.entries(panels)) {
      if (panel) panel.hidden = key !== name;
    }
  }

  // ── Thème (brique tokens) ────────────────────────────────────────────────

  /** Clé de persistance (relue par le boot inline du <head> au chargement). */
  const STORAGE_KEY = "libry.theme";
  /** Preset par défaut, aligné sur le markup (`data-theme`) et le boot. */
  const DEFAULT_THEME = "neutre-dark";

  const root = document.documentElement;

  const themeControl = document.getElementById("theme-control");
  const familySelect = document.getElementById("theme-family");
  const modeToggle = document.getElementById("theme-toggle");

  /** État courant du sélecteur (toujours un preset appliqué). */
  let currentFamily = "neutre";
  let currentMode = "dark";

  // Feuilles servies en fichiers : jamais d'injection <style> par les briques.
  if (modal && typeof modal.configure === "function") {
    modal.configure({ injectStyles: false });
  }
  if (toast && typeof toast.configure === "function") {
    toast.configure({ injectStyles: false });
  }

  /** Découpe « famille-mode » (le mode est le DERNIER segment). */
  function splitPreset(preset) {
    const dash = String(preset).lastIndexOf("-");
    if (dash <= 0) return { family: String(preset), mode: "dark" };
    return { family: String(preset).slice(0, dash), mode: String(preset).slice(dash + 1) };
  }

  /**
   * Nom équivalent pour les catalogues modal/toast : ils connaissent les
   * 12 presets <famille>-<mode> des 6 familles couleur, PAS la famille
   * d'identité `matrix` (propre à la brique tokens) → repli sur `neutre-<mode>`.
   */
  function bridgePreset(preset) {
    const { family, mode } = splitPreset(preset);
    return family === "matrix" ? `neutre-${mode}` : preset;
  }

  /** Persiste le choix (mode privé / quota : toute erreur est non bloquante). */
  function saveTheme(preset) {
    try {
      window.localStorage.setItem(STORAGE_KEY, preset);
    } catch {
      /* Optionnel : le thème reste appliqué jusqu'au rechargement. */
    }
  }

  /**
   * Applique un preset : variables --holaf-* (HolafTokens), `data-theme` pour
   * les sélecteurs locaux (icône clair/sombre, color-scheme), puis alignement
   * modal/toast. Retourne false si la brique n'a rien appliqué.
   */
  function applyTheme(preset, persist) {
    if (!tokens) return false;
    try {
      tokens.setTheme(preset);
    } catch {
      return false;
    }
    root.setAttribute("data-theme", preset);
    if (persist) saveTheme(preset);
    const bridged = bridgePreset(preset);
    if (modal && typeof modal.setTheme === "function") {
      try {
        modal.setTheme(bridged);
      } catch {
        /* Brique optionnelle : la modale garde son thème précédent. */
      }
    }
    if (toast && typeof toast.setTheme === "function") {
      try {
        toast.setTheme(bridged);
      } catch {
        /* Brique optionnelle : le toast garde son thème précédent. */
      }
    }
    return true;
  }

  /** Icônes du bouton de mode (brique icons) — texte de repli sans la brique. */
  function renderModeIcons() {
    if (!modeToggle) return;
    if (icons && typeof icons.render === "function") {
      try {
        modeToggle.innerHTML =
          icons.render("sun", { class: "icon icon--sun" }) +
          icons.render("moon", { class: "icon icon--moon" });
        return;
      } catch {
        /* Nom d'icône indisponible : repli texte ci-dessous. */
      }
    }
    modeToggle.textContent = "◐";
  }

  /** Reflète l'état (famille, mode) dans les contrôles. */
  function setControls(family, mode) {
    currentFamily = family;
    currentMode = mode;
    if (familySelect && familySelect.value !== family) {
      familySelect.value = family;
    }
  }

  /** Construit le sélecteur depuis le catalogue holaf et câble les contrôles. */
  function initTheme() {
    if (!tokens || !themeControl || !familySelect || !modeToggle) return;

    const families = typeof tokens.listFamilies === "function" ? tokens.listFamilies() : [];
    for (const family of families) {
      const option = document.createElement("option");
      option.value = family;
      const label = tokens.FAMILIES && tokens.FAMILIES[family] ? tokens.FAMILIES[family].label : "";
      option.textContent = label || family.charAt(0).toUpperCase() + family.slice(1);
      familySelect.appendChild(option);
    }

    renderModeIcons();

    const applied = typeof tokens.getTheme === "function" ? tokens.getTheme() : null;
    const { family, mode } = splitPreset(applied && applied.name ? applied.name : DEFAULT_THEME);
    setControls(families.includes(family) ? family : "neutre", mode === "light" ? "light" : "dark");
    themeControl.hidden = false;

    function applySelection() {
      if (applyTheme(`${currentFamily}-${currentMode}`, true)) return;
      const fallback = typeof tokens.getTheme === "function" ? tokens.getTheme() : null;
      const { family: family2, mode: mode2 } = splitPreset(
        fallback && fallback.name ? fallback.name : DEFAULT_THEME,
      );
      setControls(family2, mode2 === "light" ? "light" : "dark");
    }

    familySelect.addEventListener("change", () => {
      currentFamily = familySelect.value;
      applySelection();
    });

    modeToggle.addEventListener("click", () => {
      currentMode = currentMode === "light" ? "dark" : "light";
      applySelection();
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Lot 6 — utilitaires d'interface
  // ════════════════════════════════════════════════════════════════════════

  const $ = (id) => document.getElementById(id);

  /** Construit un élément DOM sans jamais interpréter de texte utilisateur. */
  function h(tag, opts, ...children) {
    const node = document.createElement(tag);
    opts = opts || {};
    if (opts.class) node.className = opts.class;
    if (opts.text !== undefined) node.textContent = String(opts.text);
    if (opts.value !== undefined) node.value = String(opts.value);
    if (opts.html !== undefined) node.innerHTML = opts.html;
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
    if (opts.on) for (const [k, v] of Object.entries(opts.on)) node.addEventListener(k, v);
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  }

  /** SVG d'une icône de la brique `icons` (chaîne vide sans la brique). */
  function iconHtml(name) {
    if (icons && typeof icons.render === "function") {
      try {
        return icons.render(name);
      } catch {
        return "";
      }
    }
    return "";
  }

  /** Bouton avec icône (brique `icons`) + libellé texte. */
  function iconButton(name, label, opts) {
    opts = opts || {};
    const btn = h("button", {
      class: opts.class || "btn",
      attrs: { type: "button", ...(opts.attrs || {}) },
      on: opts.on,
    });
    const svg = iconHtml(name);
    if (svg) {
      const span = h("span", { class: "icon", html: svg, attrs: { "aria-hidden": "true" } });
      btn.append(span);
    }
    btn.append(document.createTextNode(label));
    return btn;
  }

  const DATE_FMT = new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  /** Date lisible ; la valeur brute est conservée si non analysable. */
  function fmtDate(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    return DATE_FMT.format(date);
  }

  function notify(message, type, opts) {
    if (toast) {
      try {
        const callOpts = opts || {};
        if (type === "error") toast.error(message, callOpts);
        else if (type === "warning") toast.warning(message, callOpts);
        else if (type === "info") toast.info(message, callOpts);
        else toast.success(message, callOpts);
        return;
      } catch {
        /* Brique indisponible : repli console ci-dessous. */
      }
    }
    if (type === "error") console.error("[libry]", message);
    else console.log("[libry]", message);
  }

  /**
   * Confirmation destructive via la brique `modal` (repli `window.confirm`).
   * Retourne une promesse booléenne — jamais d'exception.
   */
  function confirmAction(title, message, opts) {
    opts = opts || {};
    if (modal && typeof modal.confirm === "function") {
      return Promise.resolve(modal.confirm(title, message, opts))
        .then(Boolean)
        .catch(() => false);
    }
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }

  /**
   * Sélectionne tout le texte d'un champ ou d'un élément (best-effort :
   * n'échoue jamais, l'utilisateur peut toujours sélectionner à la main).
   */
  function selectText(el) {
    if (!el) return;
    try {
      if (typeof el.select === "function") {
        el.select();
      } else if (typeof window.getSelection === "function") {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (typeof el.focus === "function") el.focus();
    } catch {
      /* Sélection impossible : copie manuelle toujours possible. */
    }
  }

  /**
   * Repli historique de copie sur un <textarea> temporaire hors écran.
   * Utilisé quand `navigator.clipboard` est indisponible — il n'existe QU'en
   * contexte sécurisé (HTTPS ou localhost), jamais sur une IP de LAN en HTTP.
   * Retourne `true` seulement si la copie a réellement réussi.
   */
  function legacyCopy(value) {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.setAttribute("aria-hidden", "true");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.left = "-1000px";
    document.body.append(area);
    let ok = false;
    try {
      area.select();
      area.setSelectionRange(0, value.length);
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return !!ok;
  }

  /**
   * Copie `text` dans le presse-papiers par tous les moyens disponibles.
   * Retourne une promesse booléenne : `true` UNIQUEMENT si la copie a
   * réellement réussi (retour honnête — jamais de faux succès).
   */
  async function copyText(text) {
    const value = String(text == null ? "" : text);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        /* Contexte non sécurisé / permission refusée : repli ci-dessous. */
      }
    }
    return legacyCopy(value);
  }

  /** Affiche une boîte en lecture seule (repli `window.alert`). */
  function showAlert(title, message) {
    if (modal && typeof modal.alert === "function") {
      try {
        return modal.alert(title, message);
      } catch {
        /* repli ci-dessous */
      }
    }
    window.alert(`${title}\n\n${message}`);
    return null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Lot 6 — client API (brique fetch ; repli natif si absente)
  // ════════════════════════════════════════════════════════════════════════

  /** Repli sans dépendance : fetch natif + JSON vérifié + erreur typée. */
  async function nativeRequest(path, init) {
    const opts = {
      method: init.method,
      credentials: "same-origin",
      headers: { ...(init.headers || {}) },
    };
    if (init.body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(init.body);
    }
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error(
        (data && (data.error || data.detail)) || `Erreur HTTP ${res.status}`,
      );
      err.status = res.status;
      err.data = data;
      err.body = text;
      throw err;
    }
    return data;
  }

  /**
   * Appel API JSON. `csrf` pose l'en-tête `X-CSRF-Token` (double-submit).
   * Cookies envoyés en `same-origin` : le cookie de session `libry_session`
   * accompagne les requêtes, le cookie `libry_csrf` est lisible par le script.
   */
  function apiRequest(path, options) {
    options = options || {};
    const init = {
      method: options.method || "GET",
      headers: {},
      credentials: "same-origin",
      timeout: 20000,
    };
    if (options.csrf) init.headers["X-CSRF-Token"] = options.csrf;
    if (options.body !== undefined) init.body = options.body;
    if (http && typeof http.request === "function") {
      return Promise.resolve(http.request(path, init));
    }
    return nativeRequest(path, init);
  }

  /** Code structuré d'une erreur API (`err.data.code`), ou null. */
  function errorCode(err) {
    return err && err.data && typeof err.data.code === "string" ? err.data.code : null;
  }

  /**
   * Traitement homogène des erreurs API pour les actions ordinaires :
   *   401 → session perdue → retour à la connexion ;
   *   403 PASSWORD_NOT_CHANGED → bandeau + explication ;
   *   403 CSRF_FAILED → message clair ;
   *   403 sans code → accès administrateur requis.
   */
  function handleApiError(err, fallbackMessage) {
    const status = err && err.status;
    const code = errorCode(err);
    if (status === 401) {
      state.authenticated = false;
      state.passwordIsDefault = false;
      renderSession();
      notify(fallbackMessage || "Session requise — connectez-vous.", "error");
      refreshSession();
      return;
    }
    if (status === 403 && code === "PASSWORD_NOT_CHANGED") {
      state.passwordIsDefault = true;
      showDefaultBanner();
      notify("Action bloquée : changez d'abord le mot de passe administrateur.", "error");
      return;
    }
    if (status === 403 && code === "CSRF_FAILED") {
      notify("Jeton de sécurité (CSRF) invalide ou expiré — rechargez la page.", "error");
      refreshSession();
      return;
    }
    if (status === 403) {
      notify("Accès administrateur requis — connectez-vous.", "error");
      return;
    }
    notify((err && err.message) || fallbackMessage || "Une erreur est survenue.", "error");
  }

  // ════════════════════════════════════════════════════════════════════════
  // Lot 6 — état partagé
  // ════════════════════════════════════════════════════════════════════════

  const state = {
    authenticated: false,
    passwordIsDefault: false,
    csrfToken: null,
    library: [],
    selected: null, // { name, version }
    keys: [],
    settingsGroups: [],
  };

  // ════════════════════════════════════════════════════════════════════════
  // Lot 6 — session / connexion
  // ════════════════════════════════════════════════════════════════════════

  function showDefaultBanner() {
    const banner = $("default-password-banner");
    if (banner) banner.hidden = !(state.authenticated && state.passwordIsDefault);
  }

  /** Reflète l'état de session : bascule l'écran de connexion / l'application. */
  function renderSession() {
    const loginScreen = $("login-screen");
    const app = $("app");
    const sessionView = $("session-view");
    const keysCard = $("keys-card");
    const settingsCard = $("settings-card");
    // La porte d'entrée : hors session, SEUL l'écran de connexion est affiché.
    if (loginScreen) loginScreen.hidden = state.authenticated;
    if (app) app.hidden = !state.authenticated;
    if (sessionView) sessionView.hidden = !state.authenticated;
    if (keysCard) keysCard.hidden = !state.authenticated;
    if (settingsCard) settingsCard.hidden = !state.authenticated;
    const status = $("session-status");
    if (status) {
      status.textContent = state.authenticated
        ? state.passwordIsDefault
          ? "Mot de passe par défaut encore actif."
          : "Mot de passe personnalisé."
        : "";
    }
    showDefaultBanner();
  }

  /** Applique la réponse de `GET /api/admin/session` (ou de `POST /login`). */
  function applySession(data) {
    state.authenticated = Boolean(data && data.authenticated);
    state.passwordIsDefault = Boolean(data && data.passwordIsDefault);
    if (data && typeof data.csrfToken === "string" && data.csrfToken) {
      state.csrfToken = data.csrfToken;
    }
    renderSession();
    renderDocList();
    if (state.authenticated) {
      loadKeys();
      loadSettings();
      if (state.library.length === 0) loadLibrary();
    }
  }

  /** Récupère l'état de session et (re)pose le cookie/jeton CSRF. */
  async function refreshSession() {
    try {
      const data = await apiRequest("/api/admin/session");
      applySession(data);
    } catch {
      state.authenticated = false;
      renderSession();
      renderDocList();
    }
  }

  /** Message d'erreur en ligne de l'écran de connexion ("" = masqué). */
  function setLoginError(message) {
    const el = $("login-error");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }

  function wireLogin() {
    const form = $("login-form");
    if (!form) return;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const passwordInput = $("login-password");
      const password = passwordInput ? passwordInput.value : "";
      if (!password) return;
      setLoginError("");
      // Le login exige le double-submit : GET /session a déjà posé le cookie.
      if (!state.csrfToken) await refreshSession();
      try {
        const data = await apiRequest("/api/admin/login", {
          method: "POST",
          body: { password },
          csrf: state.csrfToken,
        });
        if (passwordInput) passwordInput.value = "";
        setLoginError("");
        notify("Connexion réussie.");
        applySession(data);
      } catch (err) {
        if (err && err.status === 401) {
          setLoginError("Mot de passe incorrect.");
          if (passwordInput) passwordInput.focus();
        } else if (err && err.status === 429) {
          setLoginError("Trop de tentatives — réessayez dans une minute.");
        } else {
          handleApiError(err, "Échec de la connexion.");
        }
      }
    });
  }

  function wireLogout() {
    const btn = $("logout-btn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      try {
        await apiRequest("/api/admin/logout", { method: "POST", csrf: state.csrfToken });
      } catch (err) {
        if (!(err && err.status === 401)) handleApiError(err, "Échec de la déconnexion.");
      }
      state.authenticated = false;
      state.passwordIsDefault = false;
      state.library = [];
      state.keys = [];
      state.settingsGroups = [];
      setLoginError("");
      const passwordInput = $("login-password");
      if (passwordInput) passwordInput.value = "";
      renderSession();
      renderDocList();
      notify("Déconnecté.");
      refreshSession();
    });
  }

  function wirePasswordChange() {
    const form = $("password-form");
    if (!form) return;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const current = $("pwd-current").value;
      const next = $("pwd-next").value;
      const confirm = $("pwd-confirm").value;
      if (next.length < 4) {
        notify("Le nouveau mot de passe doit faire au moins 4 caractères.", "error");
        return;
      }
      if (next !== confirm) {
        notify("Les deux nouveaux mots de passe ne correspondent pas.", "error");
        return;
      }
      try {
        await apiRequest("/api/admin/password", {
          method: "POST",
          body: { current, next },
          csrf: state.csrfToken,
        });
        form.reset();
        notify("Mot de passe changé — reconnectez-vous.");
        // L'époque a changé : la session courante est invalidée côté serveur.
        state.authenticated = false;
        state.passwordIsDefault = false;
        renderSession();
        await refreshSession();
      } catch (err) {
        if (err && err.status === 401) {
          notify("Mot de passe actuel incorrect.", "error");
        } else {
          handleApiError(err, "Échec du changement de mot de passe.");
        }
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Lot 6 — onglet Documentation
  // ════════════════════════════════════════════════════════════════════════

  function docsEmpty(text) {
    const empty = $("docs-empty");
    const list = $("docs-list");
    if (list) list.replaceChildren();
    if (empty) {
      empty.hidden = false;
      empty.textContent = text;
    }
    updateDocsStatus();
  }

  function updateDocsStatus() {
    const status = $("docs-status");
    if (!status) return;
    if (!state.library.length) {
      status.textContent = "";
      return;
    }
    const filter = ($("docs-filter") && $("docs-filter").value.trim()) || "";
    const shown = visibleDocs().length;
    status.textContent = filter
      ? `${shown} / ${state.library.length} document(s)`
      : `${state.library.length} document(s)`;
  }

  function visibleDocs() {
    const input = $("docs-filter");
    const filter = input ? input.value.trim().toLowerCase() : "";
    if (!filter) return state.library.slice();
    return state.library.filter((entry) => {
      const haystack = [
        entry.name,
        entry.version,
        entry.type,
        entry.description,
        ...(Array.isArray(entry.keywords) ? entry.keywords : []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(filter);
    });
  }

  function renderDocList() {
    const list = $("docs-list");
    if (!list) return;
    list.replaceChildren();

    if (!state.authenticated) {
      docsEmpty("Connectez-vous pour afficher la documentation.");
      return;
    }
    if (state.library.length === 0) {
      docsEmpty("Aucun document indexé.");
      return;
    }

    const docs = visibleDocs();
    if (docs.length === 0) {
      docsEmpty("Aucun document ne correspond au filtre.");
      return;
    }
    $("docs-empty").hidden = true;

    for (const entry of docs) {
      const active =
        state.selected &&
        state.selected.name === entry.name &&
        state.selected.version === entry.version;
      const button = h("button", {
        class: active ? "is-active" : "",
        attrs: { type: "button" },
        on: { click: () => selectDoc(entry) },
      });
      button.append(
        h(
          "span",
          { class: "doc-name" },
          h("span", { text: entry.name }),
          h("span", { class: "doc-version", text: `v${entry.version}` }),
        ),
      );
      const metaBits = [
        entry.type,
        Array.isArray(entry.keywords) ? entry.keywords.slice(0, 3).join(", ") : "",
        fmtDate(entry.updatedAt),
      ].filter(Boolean);
      button.append(h("span", { class: "doc-meta", text: metaBits.join(" · ") }));
      list.append(h("li", {}, button));
    }
    updateDocsStatus();
  }

  async function loadLibrary() {
    try {
      const data = await apiRequest("/api/librarian/library");
      state.library = Array.isArray(data && data.library) ? data.library : [];
      renderDocList();
    } catch (err) {
      if (err && err.status === 401) {
        state.authenticated = false;
        renderSession();
        docsEmpty("Connectez-vous pour afficher la documentation.");
        return;
      }
      handleApiError(err, "Impossible de charger la documentation.");
    }
  }

  function detailBadge(text, variant) {
    return h("span", { class: `badge${variant ? ` badge--${variant}` : ""}`, text });
  }

  function renderDocDetail(doc) {
    const detail = $("doc-detail");
    if (!detail) return;
    detail.replaceChildren();
    detail.hidden = false;

    const meta = doc.meta || {};
    const head = h("div", { class: "detail-head" });
    const headLeft = h("div", {});
    headLeft.append(h("h3", { text: meta.name || state.selected.name }));
    const metaRow = h("div", { class: "detail-meta" });
    if (meta.version) metaRow.append(detailBadge(`v${meta.version}`));
    if (meta.type) metaRow.append(detailBadge(meta.type));
    if (meta.updatedAt) metaRow.append(detailBadge(fmtDate(meta.updatedAt)));
    if (meta.sourceUrl) {
      metaRow.append(
        h("a", {
          class: "badge",
          text: "source",
          attrs: { href: meta.sourceUrl, target: "_blank", rel: "noopener noreferrer" },
        }),
      );
    }
    headLeft.append(metaRow);
    head.append(headLeft);

    const actions = h("div", { class: "detail-actions" });
    actions.append(
      iconButton("trash", "Supprimer", {
        class: "btn btn--danger",
        on: { click: () => deleteDoc(meta.name, meta.version) },
      }),
    );
    head.append(actions);
    detail.append(head);

    if (doc.summary) {
      detail.append(h("p", { class: "doc-summary", text: doc.summary }));
    }

    if (Array.isArray(doc.keyPoints) && doc.keyPoints.length) {
      detail.append(
        h("section", { class: "detail-section" }, h("h4", { text: "Points clés" }),
          h("ul", {}, ...doc.keyPoints.map((p) => h("li", { text: p })))),
      );
    }

    if (Array.isArray(doc.api) && doc.api.length) {
      const list = h("ul", {});
      for (const item of doc.api) {
        list.append(
          h("li", {},
            h("code", { text: item.signature || "" }),
            item.description ? h("span", { text: ` — ${item.description}` }) : null),
        );
      }
      detail.append(h("section", { class: "detail-section" }, h("h4", { text: "API" }), list));
    }

    if (Array.isArray(doc.examples) && doc.examples.length) {
      const section = h("section", { class: "detail-section" }, h("h4", { text: "Exemples" }));
      for (const example of doc.examples) {
        if (example.title) section.append(h("p", { class: "muted", text: example.title }));
        section.append(h("pre", {}, h("code", { text: example.code || "" })));
      }
      detail.append(section);
    }

    if (Array.isArray(doc.breakingChanges) && doc.breakingChanges.length) {
      detail.append(
        h("section", { class: "detail-section" }, h("h4", { text: "Changements incompatibles" }),
          h("ul", {}, ...doc.breakingChanges.map((c) => h("li", { text: c })))),
      );
    }

    if (doc.rawContent) {
      detail.append(
        h("details", { class: "disclosure" },
          h("summary", { text: "Contenu brut" }),
          h("pre", {}, h("code", { text: doc.rawContent }))),
      );
    }
  }

  async function selectDoc(entry) {
    state.selected = { name: entry.name, version: entry.version };
    renderDocList();
    try {
      const version = entry.version ? `?version=${encodeURIComponent(entry.version)}` : "";
      const doc = await apiRequest(`/api/librarian/doc/${encodeURIComponent(entry.name)}${version}`);
      renderDocDetail(doc);
    } catch (err) {
      handleApiError(err, "Impossible de charger le document.");
    }
  }

  async function deleteDoc(name, version) {
    const ok = await confirmAction(
      "Supprimer le document",
      `Supprimer définitivement « ${name} » (v${version}) et son entrée d'index ?`,
      { danger: true, confirmText: "Supprimer" },
    );
    if (!ok) return;
    try {
      const query = version ? `?version=${encodeURIComponent(version)}` : "";
      await apiRequest(`/api/librarian/doc/${encodeURIComponent(name)}${query}`, {
        method: "DELETE",
        csrf: state.csrfToken,
      });
      notify(`Document « ${name} » supprimé.`);
      state.selected = null;
      const detail = $("doc-detail");
      if (detail) {
        detail.hidden = true;
        detail.replaceChildren();
      }
      await loadLibrary();
    } catch (err) {
      handleApiError(err, "Échec de la suppression.");
    }
  }

  async function reindex() {
    try {
      const data = await apiRequest("/api/librarian/library/reindex", {
        method: "POST",
        csrf: state.csrfToken,
      });
      const total = data && typeof data.totalDocs === "number" ? data.totalDocs : "?";
      notify(`Réindexation terminée — ${total} document(s).`);
      await loadLibrary();
    } catch (err) {
      handleApiError(err, "Échec de la réindexation.");
    }
  }

  function wireDocs() {
    const filter = $("docs-filter");
    if (filter) filter.addEventListener("input", renderDocList);
    const reload = $("docs-reload");
    if (reload) reload.addEventListener("click", () => loadLibrary());
    const reindexBtn = $("docs-reindex");
    if (reindexBtn) reindexBtn.addEventListener("click", () => reindex());
  }

  // ════════════════════════════════════════════════════════════════════════
  // Lot 6 — clés API
  // ════════════════════════════════════════════════════════════════════════

  /** Modale « secret affiché une seule fois » (copie + avertissement). */
  function showSecret(record) {
    const value = record.key || "";
    const node = h("div", {});
    node.append(h("p", { text: `Clé « ${record.name || "sans nom"} » — copiez-la maintenant.` }));
    const box = h("div", { class: "secret-box" });
    // Champ LECTURE SEULE toujours sélectionnable : un clic sélectionne toute
    // la clé, pour pouvoir la copier à la main quelle que soit la situation.
    const field = h("input", {
      class: "secret-value",
      value,
      attrs: {
        type: "text",
        readonly: "",
        spellcheck: "false",
        autocapitalize: "off",
        autocomplete: "off",
        "aria-label": "Clé API",
      },
      on: { click: () => selectText(field), focus: () => selectText(field) },
    });
    const copy = iconButton("copy", "Copier", {
      on: {
        click: async () => {
          const ok = await copyText(value);
          if (ok) {
            notify("Clé copiée dans le presse-papiers.");
            return;
          }
          // Échec RÉEL : on ne prétend pas avoir copié. On sélectionne la clé
          // et on l'annonce explicitement (message persistant).
          selectText(field);
          notify(
            "Copie automatique impossible sur cette page (contexte non sécurisé). La clé est sélectionnée : copiez-la avec Ctrl+C (Cmd+C sur Mac).",
            "error",
            { duration: 0 },
          );
        },
      },
    });
    box.append(field, copy);
    node.append(box);
    node.append(
      h("p", {
        class: "warn-text",
        text: "Ce secret ne sera plus jamais affiché. Conservez-le en lieu sûr : en cas de perte, régénérez la clé.",
      }),
    );
    if (modal && typeof modal.open === "function") {
      try {
        modal.open({
          title: "Nouvelle clé API",
          content: node,
          buttons: [{ text: "J'ai copié le secret", type: "primary" }],
        });
        return;
      } catch {
        /* repli ci-dessous */
      }
    }
    showAlert("Nouvelle clé API", record.key || "");
  }

  function renderKeys() {
    const list = $("keys-list");
    const empty = $("keys-empty");
    if (!list) return;
    list.replaceChildren();

    if (state.keys.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    for (const key of state.keys) {
      const main = h("div", { class: "list-main" });
      const nameRow = h("div", { class: "list-name" }, h("span", { text: key.name || "(sans nom)" }));
      if (key.admin) nameRow.append(detailBadge("admin", "admin"));
      main.append(nameRow);
      const sub = h("div", { class: "list-sub" });
      sub.append(h("span", { text: key.key || "••••" }));
      if (key.createdAt) sub.append(h("span", { text: `créée le ${fmtDate(key.createdAt)}` }));
      main.append(sub);

      const actions = h("div", { class: "list-actions" });
      actions.append(
        iconButton("refresh", "", {
          class: "icon-btn",
          attrs: { title: "Régénérer le secret", "aria-label": "Régénérer le secret" },
          on: { click: () => regenerateKey(key) },
        }),
        iconButton("trash", "", {
          class: "icon-btn icon-btn--danger",
          attrs: { title: "Supprimer la clé", "aria-label": "Supprimer la clé" },
          on: { click: () => deleteKey(key) },
        }),
      );

      list.append(h("li", {}, main, actions));
    }
  }

  async function loadKeys() {
    if (!state.authenticated) return;
    try {
      const data = await apiRequest("/api/librarian/keys");
      state.keys = Array.isArray(data && data.keys) ? data.keys : [];
      renderKeys();
    } catch (err) {
      handleApiError(err, "Impossible de charger les clés API.");
    }
  }

  function wireKeys() {
    const form = $("key-form");
    if (form) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = $("key-name").value.trim();
        const admin = $("key-admin").checked;
        if (!name) {
          notify("Indiquez un nom pour la clé.", "error");
          return;
        }
        try {
          const created = await apiRequest("/api/librarian/keys", {
            method: "POST",
            body: { name, admin },
            csrf: state.csrfToken,
          });
          $("key-name").value = "";
          $("key-admin").checked = false;
          notify("Clé créée.");
          showSecret(created);
          await loadKeys();
        } catch (err) {
          handleApiError(err, "Échec de la création de la clé.");
        }
      });
    }
  }

  async function regenerateKey(key) {
    const ok = await confirmAction(
      "Régénérer le secret",
      `Régénérer le secret de « ${key.name || "(sans nom)"} » ? L'ancien secret cessera immédiatement de fonctionner.`,
      { danger: true, confirmText: "Régénérer" },
    );
    if (!ok) return;
    try {
      const regenerated = await apiRequest(
        `/api/librarian/keys/${encodeURIComponent(key.id)}/regenerate`,
        { method: "POST", csrf: state.csrfToken },
      );
      notify("Secret régénéré.");
      showSecret(regenerated);
      await loadKeys();
    } catch (err) {
      handleApiError(err, "Échec de la régénération.");
    }
  }

  async function deleteKey(key) {
    const ok = await confirmAction(
      "Supprimer la clé",
      `Supprimer définitivement la clé « ${key.name || "(sans nom)"} » ? Toute application qui l'utilise perdra l'accès.`,
      { danger: true, confirmText: "Supprimer" },
    );
    if (!ok) return;
    try {
      await apiRequest(`/api/librarian/keys/${encodeURIComponent(key.id)}`, {
        method: "DELETE",
        csrf: state.csrfToken,
      });
      notify("Clé supprimée.");
      await loadKeys();
    } catch (err) {
      handleApiError(err, "Échec de la suppression de la clé.");
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Lot 6 — paramètres
  // ════════════════════════════════════════════════════════════════════════

  /** État par réglage, consommé par `saveSettings`. */
  const settingState = new Map();

  const SOURCE_LABEL = { env: "env", file: "fichier", default: "défaut" };

  function renderSettings(groups) {
    const container = $("settings-form");
    if (!container) return;
    container.replaceChildren();
    settingState.clear();

    for (const group of groups) {
      const section = h("section", { class: "settings-group" });
      section.append(h("h4", { text: group.id }));
      for (const spec of group.settings) {
        section.append(renderSettingRow(spec));
      }
      container.append(section);
    }
  }

  function renderSettingRow(spec) {
    const row = h("div", { class: "setting-row" });

    const label = h("div", { class: "setting-label" });
    label.append(h("span", { class: "name", text: spec.name }));
    const sourceVariant = spec.source === "env" ? "env" : spec.source === "file" ? "" : "warn";
    label.append(detailBadge(SOURCE_LABEL[spec.source] || spec.source, sourceVariant || undefined));
    if (spec.restartRequired) label.append(detailBadge("redémarrage requis", "warn"));
    if (!spec.editable) {
      label.append(
        h("span", {
          class: "setting-help",
          text: "Fourni par l'environnement : lecture seule, non modifiable depuis l'interface.",
        }),
      );
    }
    row.append(label);

    const control = h("div", { class: "setting-control" });

    if (spec.sensitive) {
      const configured = spec.configured === true;
      control.append(detailBadge(configured ? "configuré" : "non configuré", configured ? "ok" : undefined));
      const input = h("input", {
        attrs: {
          type: "password",
          autocomplete: "new-password",
          placeholder: "•••• (vide = inchangé)",
          "aria-label": `Nouvelle valeur de ${spec.name}`,
        },
      });
      if (!spec.editable) input.disabled = true;
      control.append(input);

      let cleared = false;
      const clearBtn = h("button", {
        class: "btn btn--ghost",
        text: "Effacer",
        attrs: { type: "button" },
      });
      if (!spec.editable) {
        clearBtn.disabled = true;
      } else {
        clearBtn.addEventListener("click", () => {
          cleared = !cleared;
          input.disabled = cleared;
          if (cleared) input.value = "";
          clearBtn.textContent = cleared ? "Effacer (annulé)" : "Effacer";
        });
      }
      control.append(clearBtn);

      settingState.set(spec.name, { type: spec.type, sensitive: true, editable: spec.editable, input, getCleared: () => cleared });
      row.append(control);
      return row;
    }

    const original = spec.value !== undefined ? String(spec.value) : "";
    let input;
    if (spec.type === "boolean") {
      input = h("select", { attrs: { "aria-label": spec.name } });
      input.append(h("option", { text: "true", attrs: { value: "true" } }));
      input.append(h("option", { text: "false", attrs: { value: "false" } }));
      input.value = original === "true" ? "true" : "false";
    } else if (spec.type === "number") {
      input = h("input", { attrs: { type: "number", "aria-label": spec.name } });
      if (typeof spec.min === "number") input.setAttribute("min", String(spec.min));
      if (typeof spec.max === "number") input.setAttribute("max", String(spec.max));
      input.value = original;
    } else {
      input = h("input", { attrs: { type: "text", "aria-label": spec.name } });
      input.value = original;
    }
    if (!spec.editable) input.disabled = true;
    control.append(input);

    settingState.set(spec.name, { type: spec.type, sensitive: false, editable: spec.editable, input, original });
    row.append(control);
    return row;
  }

  async function loadSettings() {
    if (!state.authenticated) return;
    try {
      const data = await apiRequest("/api/admin/settings");
      state.settingsGroups = Array.isArray(data && data.groups) ? data.groups : [];
      renderSettings(state.settingsGroups);
    } catch (err) {
      handleApiError(err, "Impossible de charger les paramètres.");
    }
  }

  async function saveSettings() {
    const payload = {};
    for (const [name, st] of settingState) {
      if (st.sensitive) {
        if (!st.editable) continue;
        if (st.getCleared()) {
          payload[name] = null; // sentinelle d'effacement
        } else if (st.input.value.trim() !== "") {
          payload[name] = st.input.value;
        }
        continue;
      }
      if (!st.editable) continue;
      const value = st.input.value;
      if (value !== st.original) payload[name] = value;
    }

    if (Object.keys(payload).length === 0) {
      notify("Aucune modification à enregistrer.", "info");
      return;
    }

    try {
      const data = await apiRequest("/api/admin/settings", {
        method: "PUT",
        body: { settings: payload },
        csrf: state.csrfToken,
      });
      const updated = Array.isArray(data && data.updated) ? data.updated : [];
      notify(`Réglages enregistrés (${updated.length}).`);
      if (Array.isArray(data && data.groups)) {
        state.settingsGroups = data.groups;
        renderSettings(state.settingsGroups);
      } else {
        await loadSettings();
      }
    } catch (err) {
      handleApiError(err, "Échec de l'enregistrement des paramètres.");
    }
  }

  function wireSettings() {
    const save = $("settings-save");
    if (save) save.addEventListener("click", () => saveSettings());
  }

  // ════════════════════════════════════════════════════════════════════════
  // Démarrage
  // ════════════════════════════════════════════════════════════════════════

  /** Nom d'onglet porté par l'ancre d'URL (`#settings`), défaut « docs ». */
  function tabFromHash() {
    return (window.location.hash || "").replace(/^#/, "") === "settings" ? "settings" : "docs";
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      if (!tab.dataset.tab) return;
      activate(tab.dataset.tab);
      try {
        window.history.replaceState(null, "", `#${tab.dataset.tab}`);
      } catch {
        /* File/opaque origine : l'ancre reste optionnelle. */
      }
      if (tab.dataset.tab === "settings") {
        refreshSession();
      } else if (tab.dataset.tab === "docs" && state.authenticated && state.library.length === 0) {
        loadLibrary();
      }
    });
  }

  initTheme();
  activate(tabFromHash());
  wireDocs();
  wireLogin();
  wireLogout();
  wirePasswordChange();
  wireKeys();
  wireSettings();
  refreshSession();
})();
