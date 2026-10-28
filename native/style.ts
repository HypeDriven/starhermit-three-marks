// The look of the HUD, rails, screens, sheets and toasts: the browser build's
// css/style.css, rewritten class-based in tools/ui-style.css and converted
// once with `starhermit css` into assets/ui-style.json (`npm run css`),
// registered at start with the theme the runtime's own widgets (scroll bars,
// focus rings, selects, check boxes) take. The runtime's high contrast
// option is the old .high-contrast token set.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  bg: "#101218", panel: "rgba(22, 25, 34, 0.92)", "panel-solid": "#161922", text: "#ece7db", "text-dim": "#a8a49a",
  accent: "#e8b64c", "accent-2": "#7fd4c1", danger: "#e0604f", line: "rgba(236, 231, 219, 0.14)", "focus-ring": "#ffd97a",
  ink: "#201808", "warn-text": "#f2b8b0",
};
/** .high-contrast. */
const CONTRAST: Tokens = {
  panel: "rgba(0, 0, 0, 0.95)", "panel-solid": "#000000", text: "#ffffff", "text-dim": "#d8d8d8", line: "rgba(255, 255, 255, 0.45)", "focus-ring": "#ffffff",
};
let current: Tokens = { ...BASE };
let css: ui.CssStyles | null = null;
let key = "";
export function initStyles(): void {
  css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: BASE.text!, muted: BASE["text-dim"]!, panel: "#161922", control: "#1f2330", hovered: "#2a2f3d",
    pressed: "#343a4a", field: "#161922", accent: BASE.accent!, focus: BASE["focus-ring"]!, outline: "#3a3d45",
  });
  key = "";
  applyTokens(false);
}
/** The base or high-contrast tokens and styles (cheap when unchanged). */
export function applyTokens(highContrast: boolean): void {
  const k = String(highContrast);
  if (k === key || !css) return;
  key = k;
  current = { ...BASE, ...(highContrast ? CONTRAST : {}) };
  ui.setTokens({ ...css.tokens, ...current });
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "$focus-ring", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "#3a3d45", radius: 4 } } },
    dialog: { background: "$panel-solid", border: { width: 1, color: "$line" }, radius: 14, padding: 25.6, parts: { backdrop: { background: "rgba(6, 8, 12, 0.55)" } } },
  });
  ui.setTheme({
    text: current.text!, muted: current["text-dim"]!, accent: current.accent!, focus: current["focus-ring"]!,
    panel: highContrast ? "#000000" : "#161922", field: highContrast ? "#000000" : "#161922",
  });
}
export function token(name: string): string { return current[name] ?? "#000000"; }
