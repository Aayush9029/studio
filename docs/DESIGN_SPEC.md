# Studio — Design Specification

| | |
|---|---|
| Version | 1.0 (2026-11-25) |
| Audience | React Frontend team (primary), Rust+Electron team (window chrome, §3), Engine team (§7.6 preview cadence) |
| Companion | `API_CONTRACT.md` — every data shape, endpoint, IPC channel and file layout named here is defined there. Where the two disagree, `API_CONTRACT.md` wins for data, this document wins for appearance and behaviour. |
| Stack | Electron + React 19 + TypeScript + Vite + Tailwind CSS v4 + Zustand + Three.js + WebGL2 + Lucide |

Studio is a native Windows 11 creative studio for AI image generation, canvas image editing and 3D mesh generation. It replaces a node graph with four quiet rooms: **Generate**, **Edit**, **3D**, **Library**.

Contents: 1 Ideology · 2 Tokens · 3 Window and chrome · 4 Shared components · 5 Workspaces · 6 Models & Memory drawer · 7 Murmuration · 8 States and copy · 9 Keyboard map · 10 Accessibility and performance · 11 Frontend architecture · 12 Acceptance checklist

---

## 1. Ideology

**Zen + iA Writer + DiffusionBee + Apple Music on Windows.** Four references, each contributing one thing:

| Reference | What we take | What we leave |
|---|---|---|
| Zen | Emptiness as a material. One thing on stage at a time. | Decorative "zen" imagery (stones, bamboo, enso). |
| iA Writer | Typography as the interface. One accent colour. Content never competes with chrome. | Its monospace-everywhere look. |
| DiffusionBee (Mac) | A single floating prompt capsule that is the whole workflow. | Its settings sidebar. |
| Apple Music on Windows | Mica window, frosted translucent sidebar, hairline separators, native caption buttons. | Dense list rows and coloured artwork gradients in chrome. |

### 1.1 Rules

1. **The work is the only colourful thing.** Chrome is ink, paper and glass. Accent colour appears on exactly three kinds of element: the primary action, the active selection, and live progress.
2. **Icon-first, word-second.** Controls are icons with tooltips. A text label appears only where an icon would be ambiguous (model names, mode pills, numbers). No badges, no "New", no counters except selection count.
3. **One primary action per workspace.** Generate / Run / Generate 3D. It lives in the bottom capsule, bottom-right, always in the same place.
4. **Nothing modal.** No dialog boxes. Options live in popovers that open from the control that owns them; detail lives in slide-over drawers; confirmations are inline (the button itself asks twice).
5. **Numbers are monospace.** Seeds, dimensions, step counts, memory, vertex counts: JetBrains Mono, tabular figures.
6. **Stillness is the default.** Nothing moves unless the user or the engine caused it. When work finishes, every animation loop stops (§7.5, §10.2).
7. **Whisper, don't announce.** Feedback is a one-line pill that fades in near where the user is looking and leaves after 2.4 s. No toasts stacked in a corner.
8. **Generous room.** Minimum 16 px between unrelated controls, 48 px between the stage image and any chrome.

### 1.2 Voice

Sentence case everywhere. No exclamation marks. No "AI", "magic", "awesome". Verbs for actions (`Generate`, `Remove background`, `Send to Blender`), nouns for places (`Library`). Empty states are one serif line and one muted sans line (§8.2).

---

## 2. Design tokens

All tokens are CSS custom properties on `:root`, switched by `data-theme` on `<html>`. Tailwind v4 consumes them through `@theme inline` (§2.8). Components never use raw hex values.

### 2.1 Colour — complete token set

```css
/* app/src/styles/tokens.css */

:root,
:root[data-theme="zen-light"] {
  color-scheme: light;

  /* Canvas */
  --bg-canvas: #F6F5F1;                       /* warm alabaster paper (opaque fallback) */
  --bg-canvas-mica: rgba(246, 245, 241, 0.78); /* painted over Mica when material is active */
  --bg-stage: #EFEDE7;                        /* stage well behind images / 3D viewport */
  --bg-checker-a: #FFFFFF;                    /* transparency checker */
  --bg-checker-b: #E7E5DF;

  /* Surfaces */
  --surface-glass: rgba(255, 255, 255, 0.56);        /* sidebar, rails, pills */
  --surface-glass-strong: rgba(255, 255, 255, 0.76); /* prompt capsule, drawers, popovers */
  --surface-elevated: #FFFFFF;                       /* opaque menus, tooltips' inverse see 2.1.1 */
  --surface-sunken: rgba(24, 24, 27, 0.04);          /* inputs, slider tracks, memory bars */
  --surface-hover: rgba(24, 24, 27, 0.05);
  --surface-active: rgba(24, 24, 27, 0.09);
  --surface-tooltip: #18181B;
  --text-on-tooltip: #F6F5F1;

  /* Lines */
  --border-hairline: rgba(24, 24, 27, 0.08);
  --border-strong: rgba(24, 24, 27, 0.16);
  --border-glass: rgba(255, 255, 255, 0.70);  /* 1px inner top highlight on glass */

  /* Ink */
  --text-primary: #18181B;    /* crisp ink */
  --text-secondary: #52525B;  /* slate */
  --text-muted: #6E6E78;      /* placeholders, captions, telemetry labels */
  --text-faint: #A1A1AA;      /* disabled, decorative only — never for required reading */
  --text-on-accent: #FFFFFF;

  /* Accent: warm indigo */
  --accent: #4B50C8;
  --accent-hover: #4045B8;
  --accent-pressed: #373CA6;
  --accent-soft: rgba(75, 80, 200, 0.10);
  --accent-ring: rgba(75, 80, 200, 0.36);

  /* Semantic */
  --sage: #4F6F5B;                         /* warm / connected / done */
  --sage-soft: rgba(79, 111, 91, 0.13);
  --warn: #8F5F1E;                         /* warming / starting */
  --warn-soft: rgba(143, 95, 30, 0.12);
  --danger: #B8433A;
  --danger-hover: #A3372F;
  --danger-soft: rgba(184, 67, 58, 0.10);

  /* Editor */
  --mask-tint: rgba(75, 80, 200, 0.44);    /* inpaint mask overlay */
  --mask-edge: rgba(75, 80, 200, 0.90);
  --selection: rgba(75, 80, 200, 0.18);

  /* Overlays and depth */
  --scrim: rgba(24, 24, 27, 0.22);
  --shadow-1: 0 1px 2px rgba(24, 24, 27, 0.05);
  --shadow-2: 0 4px 16px -4px rgba(24, 24, 27, 0.10), 0 1px 2px rgba(24, 24, 27, 0.05);
  --shadow-3: 0 16px 48px -12px rgba(24, 24, 27, 0.18), 0 2px 6px rgba(24, 24, 27, 0.06);
  --glass-blur: 28px;
  --glass-saturate: 1.5;

  /* Murmuration palette (read by JS, §7.4) */
  --murmur-ink: 24, 24, 27;          /* r,g,b */
  --murmur-ink-alpha: 0.62;
  --murmur-pane-a: 250, 249, 246;
  --murmur-pane-b: 232, 230, 238;
  --murmur-glow: 75, 80, 200;

  /* 3D viewport */
  --viewport-bg-top: #F2F0EA;
  --viewport-bg-bottom: #E4E1D9;
  --clay: #B9B4AA;
  --wire: rgba(24, 24, 27, 0.38);
}

:root[data-theme="zen-dark"] {
  color-scheme: dark;

  --bg-canvas: #0D0E12;                       /* deep obsidian */
  --bg-canvas-mica: rgba(13, 14, 18, 0.72);
  --bg-stage: #08090C;
  --bg-checker-a: #1B1C22;
  --bg-checker-b: #14151A;

  --surface-glass: rgba(30, 31, 38, 0.58);          /* frosted smoky graphite */
  --surface-glass-strong: rgba(30, 31, 38, 0.80);
  --surface-elevated: #1A1B21;
  --surface-sunken: rgba(0, 0, 0, 0.28);
  --surface-hover: rgba(236, 235, 230, 0.06);
  --surface-active: rgba(236, 235, 230, 0.11);
  --surface-tooltip: #ECEBE6;
  --text-on-tooltip: #0D0E12;

  --border-hairline: rgba(236, 235, 230, 0.08);
  --border-strong: rgba(236, 235, 230, 0.18);
  --border-glass: rgba(255, 255, 255, 0.07);

  --text-primary: #ECEBE6;    /* soft alabaster ink */
  --text-secondary: #A9A9B2;  /* pewter */
  --text-muted: #84858F;
  --text-faint: #55565F;
  --text-on-accent: #0D0E12;

  --accent: #9BA6FF;          /* luminous periwinkle */
  --accent-hover: #AEB7FF;
  --accent-pressed: #8792F2;
  --accent-soft: rgba(155, 166, 255, 0.14);
  --accent-ring: rgba(155, 166, 255, 0.42);

  --sage: #9DBBA6;
  --sage-soft: rgba(157, 187, 166, 0.14);
  --warn: #D9A766;
  --warn-soft: rgba(217, 167, 102, 0.14);
  --danger: #F0857A;
  --danger-hover: #F49A90;
  --danger-soft: rgba(240, 133, 122, 0.14);

  --mask-tint: rgba(155, 166, 255, 0.42);
  --mask-edge: rgba(155, 166, 255, 0.95);
  --selection: rgba(155, 166, 255, 0.22);

  --scrim: rgba(0, 0, 0, 0.46);
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.40);
  --shadow-2: 0 6px 20px -6px rgba(0, 0, 0, 0.55), 0 1px 2px rgba(0, 0, 0, 0.40);
  --shadow-3: 0 20px 56px -12px rgba(0, 0, 0, 0.70), 0 2px 6px rgba(0, 0, 0, 0.45);
  --glass-blur: 32px;
  --glass-saturate: 1.3;

  --murmur-ink: 236, 235, 230;
  --murmur-ink-alpha: 0.72;
  --murmur-pane-a: 26, 27, 34;
  --murmur-pane-b: 18, 19, 27;
  --murmur-glow: 155, 166, 255;

  --viewport-bg-top: #15161C;
  --viewport-bg-bottom: #0A0B0E;
  --clay: #8E8A82;
  --wire: rgba(236, 235, 230, 0.34);
}
```

#### 2.1.1 Usage rules

| Token | Use for | Never for |
|---|---|---|
| `--bg-canvas-mica` | `<body>` when Mica is active (`html[data-material="mica"]`) | Anything else |
| `--bg-canvas` | `<body>` when Mica is unavailable (`html[data-material="none"]`) | — |
| `--surface-glass` | Sidebar, tool rails, action rails, filmstrip tray | Text-heavy panels (use `-strong`) |
| `--surface-glass-strong` | Prompt capsule, popovers, drawers, inspector | — |
| `--surface-elevated` | Menus and the colour picker, where blur behind text would hurt legibility | Large areas |
| `--text-muted` | Placeholders, captions, units | Body text |
| `--text-faint` | Disabled glyphs, separators' dots | Anything the user must read |
| `--accent` | Primary button fill, active tool glyph, progress, focus ring, selection outline | Body text, borders of idle controls |
| `--sage` | `Warm` state dot, Blender connected dot, completed milestone tick | Buttons |
| `--danger` | Delete glyph on hover, destructive confirm state, error whisper | Idle icons (trash is `--text-secondary` until hovered) |

Contrast targets (hand-computed from the hex values above; re-verify with tooling during implementation): `--text-primary` ≥ 15:1, `--text-secondary` ≥ 7:1, `--text-muted` ≥ 4.5:1 on `--bg-canvas` and `--surface-elevated` in both themes; `--text-on-accent` on `--accent` ≥ 6:1.

### 2.2 Glass recipe

One utility, used everywhere glass appears:

```css
.glass {
  background: var(--surface-glass);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border: 1px solid var(--border-hairline);
  box-shadow: inset 0 1px 0 var(--border-glass), var(--shadow-2);
}
.glass-strong { background: var(--surface-glass-strong); /* rest identical */ }
```

Constraints: never nest glass inside glass (a popover that opens from the capsule is a sibling in a portal, not a child). At most **four** `backdrop-filter` surfaces visible at once. While the Murmuration canvas is running, `backdrop-filter` surfaces that overlap the stage image are forbidden except the prompt capsule.

### 2.3 Typography

Bundled, no network: `@fontsource/plus-jakarta-sans` (400, 500, 600), `@fontsource/instrument-serif` (400, 400-italic), `@fontsource/jetbrains-mono` (400, 500). Import only those weight files, Latin subset.

```css
:root {
  --font-sans: "Plus Jakarta Sans", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  --font-serif: "Instrument Serif", "Iowan Old Style", Georgia, serif;
  --font-mono: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
}
body { font-family: var(--font-sans); font-feature-settings: "ss01", "cv11"; -webkit-font-smoothing: antialiased; }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-feature-settings: "zero", "calt" 0; }
```

| Token | Family | Size / line-height | Weight | Tracking | Use |
|---|---|---|---|---|---|
| `display` | Instrument Serif | 40 / 46 | 400 | −0.01em | Empty-state headline |
| `title` | Instrument Serif | 28 / 34 | 400 | −0.005em | Drawer titles, Library header |
| `heading` | Instrument Serif | 22 / 28 | 400 | 0 | Inspector section lead, model family name |
| `subhead` | Plus Jakarta Sans | 15 / 22 | 600 | −0.005em | Popover titles |
| `prompt` | Plus Jakarta Sans | 15 / 24 | 400 | 0 | Prompt and instruction textareas |
| `body` | Plus Jakarta Sans | 14 / 22 | 400 | 0 | Inspector text, descriptions |
| `ui` | Plus Jakarta Sans | 13 / 18 | 500 | 0 | Pills, buttons, sidebar labels, menu items |
| `caption` | Plus Jakarta Sans | 12 / 16 | 500 | 0.005em | Tooltips, titlebar indicator, helper lines |
| `micro` | Plus Jakarta Sans | 11 / 14 | 600 | 0.06em, uppercase | Section labels (`STEPS`, `SAMPLER`) — the only uppercase in the app |
| `mono` | JetBrains Mono | 12 / 16 | 400 | 0 | Seeds, dimensions, telemetry, model stats |
| `mono-sm` | JetBrains Mono | 11 / 14 | 400 | 0 | Whisper metadata pill, HUD, filmstrip overlays |
| `mono-lg` | JetBrains Mono | 14 / 20 | 500 | 0 | Memory figures in the drawer |

Serif italic is reserved for the second half of empty-state headlines (`Describe an image, *then let it gather.*`). Serif is never used below 22 px or for interactive labels.

### 2.4 Space, size, radius

4 px base. Allowed spacing steps: `2, 4, 6, 8, 12, 16, 20, 24, 32, 48, 64, 96`.

| Token | Value | Use |
|---|---|---|
| `--r-xs` | 6 px | Swatches, checkboxes |
| `--r-sm` | 8 px | Sidebar rows, menu items, inputs |
| `--r-md` | 12 px | Popovers, library tiles, filmstrip thumbs (10 px) |
| `--r-lg` | 14 px | Stage image, 3D viewport inset |
| `--r-xl` | 22 px | Prompt capsule, drawers' inner cards |
| `--r-full` | 999 px | Pills, icon buttons, rails |
| `--titlebar-h` | 40 px | |
| `--sidebar-w` | 212 px | Expanded |
| `--sidebar-rail-w` | 56 px | Collapsed |
| `--filmstrip-h` | 76 px | |
| `--capsule-max-w` | 760 px | |
| `--drawer-w` | 420 px | Models & Memory |
| `--inspector-w` | 380 px | Library inspector |
| Hit target | 32 × 32 px minimum | Icon buttons are 32 px (glyph 16 px, stroke 1.75); primary action 40 px |

### 2.5 Motion

```css
:root {
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);      /* default for everything entering */
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);   /* layout shifts (sidebar collapse) */
  --dur-instant: 90ms;   /* hover, press */
  --dur-fast: 160ms;     /* popover, tooltip, pill state */
  --dur-base: 240ms;     /* drawers, sidebar, filmstrip insert */
  --dur-reveal: 300ms;   /* Phase C reveal — fixed, see 7.5 */
  --dur-slow: 450ms;     /* 3D camera preset moves */
}
```

Rules: only `opacity` and `transform` animate (the sidebar width is the single exception). Entering elements translate 6 px and fade; leaving elements only fade, at 0.7× the duration. No spring bounce, no scale-on-hover. `prefers-reduced-motion: reduce` sets every duration to 1 ms and swaps Murmuration for its reduced variant (§7.8).

### 2.6 Icons

`lucide-react`, `size={16}` (sidebar 18, primary action 18), `strokeWidth={1.75}`, `absoluteStrokeWidth`. Colour is `currentColor`: `--text-secondary` idle, `--text-primary` hover, `--accent` active/selected. Icon names in this document are Lucide component names. If a name is absent in the installed version, substitute the listed fallback and do not draw a custom glyph.

### 2.7 Elevation order (z-index)

`0` stage · `10` filmstrip · `20` rails and capsule · `30` sidebar · `40` titlebar · `50` drawers + scrim · `60` popovers/menus · `70` tooltips · `80` whisper.

### 2.8 Tailwind v4 binding

```css
/* app/src/styles/index.css */
@import "tailwindcss";
@import "./tokens.css";

@theme inline {
  --color-canvas: var(--bg-canvas);
  --color-stage: var(--bg-stage);
  --color-glass: var(--surface-glass);
  --color-glass-strong: var(--surface-glass-strong);
  --color-elevated: var(--surface-elevated);
  --color-sunken: var(--surface-sunken);
  --color-hover: var(--surface-hover);
  --color-active: var(--surface-active);
  --color-hairline: var(--border-hairline);
  --color-line: var(--border-strong);
  --color-ink: var(--text-primary);
  --color-ink-2: var(--text-secondary);
  --color-ink-3: var(--text-muted);
  --color-ink-4: var(--text-faint);
  --color-accent: var(--accent);
  --color-accent-soft: var(--accent-soft);
  --color-on-accent: var(--text-on-accent);
  --color-sage: var(--sage);
  --color-warn: var(--warn);
  --color-danger: var(--danger);
  --font-sans: var(--font-sans);
  --font-serif: var(--font-serif);
  --font-mono: var(--font-mono);
  --radius-sm: 8px; --radius-md: 12px; --radius-lg: 14px; --radius-xl: 22px;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
}
```

Theme switching: `document.documentElement.dataset.theme = "zen-light" | "zen-dark"`, then `window.studio.window.setTheme(theme)` so the native frame, Mica tint and caption-button glyphs follow. First launch follows the OS setting; afterwards the stored choice wins. The swap is instant (no cross-fade — a 240 ms fade of `backdrop-filter` surfaces stutters).

---

## 3. Window and chrome

### 3.1 Electron window (owned by Rust+Electron team)

```ts
new BrowserWindow({
  width: 1440, height: 920, minWidth: 1080, minHeight: 700,
  show: false,
  icon: "assets/studio.ico",
  backgroundMaterial: "mica",            // Windows 11 22H2+
  backgroundColor: "#00000000",
  titleBarStyle: "hidden",               // frameless look, native frame behaviours kept (snap, shadow, rounded corners)
  titleBarOverlay: { color: "#00000000", symbolColor: "#18181B", height: 40 }, // native caption buttons
  webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
});
```

- **Caption controls are the real Windows ones**, drawn by `titleBarOverlay`. This keeps Snap Layouts on maximize-hover and correct high-contrast behaviour. The renderer reserves **138 px** at the top-right of the titlebar and draws nothing there. `window.studio.window.setTheme()` calls `win.setTitleBarOverlay({ symbolColor })` (`#18181B` light, `#ECEBE6` dark) and sets `nativeTheme.themeSource`.
- **Fallback ladder.** Main reports `material: "mica" | "none"` in `AppInfo`. If Mica cannot be applied (unsupported build, transparency effects disabled in Windows, or the installed Electron renders it black with a hidden title bar), main sets an opaque `backgroundColor` (`#F6F5F1` / `#0D0E12`) and reports `"none"`; the renderer sets `html[data-material="none"]` and uses `--bg-canvas`. Glass surfaces keep working because they blur page content, not the desktop.
- Window shows on `ready-to-show`. Size, position and maximized state persist in settings.
- When the window loses focus, Windows desaturates Mica on its own. The renderer does nothing.

### 3.2 Frame layout

```
┌───────────────┬────────────────────────────────────────────────────────────┐
│  sidebar      │  titlebar 40px      · Generate — Z-Image Turbo ·   [— ▢ ✕]  │
│  212 / 56 px  ├────────────────────────────────────────────────────────────┤
│  (glass,      │                                                            │
│  full height) │                     workspace stage                        │
│               │                                                            │
│               │            ┌──────── prompt capsule ────────┐              │
│               │            └────────────────────────────────┘              │
│               ├────────────────────────────────────────────────────────────┤
│               │  filmstrip 76px (Generate only)                            │
└───────────────┴────────────────────────────────────────────────────────────┘
```

The sidebar runs the full window height; the titlebar spans only the content column. Both the titlebar and the top 40 px of the sidebar are `-webkit-app-region: drag`; every interactive child sets `no-drag`.

### 3.3 Titlebar

Height 40 px, transparent. One element, centred in the content column: the **mode indicator**.

- Idle: `Generate — Z-Image Turbo` in `caption`, `--text-muted`. The workspace name is `--text-secondary`. Separator is an em-dash with thin spaces. In Edit it reads `Edit — Smart edit`; in 3D `3D — Pixal3D`; in Library `Library — 248 items` (count in `mono-sm`).
- Running: a 6 px `--accent` dot (opacity pulse 1 → 0.35, 1.6 s) precedes the text and a `mono-sm` step counter follows: `● Generate — Z-Image Turbo  4/9`. During non-sampling phases the counter is replaced by the phase word in `caption`: `warming`, `encoding`, `decoding`, `saving` (from `job.progress.phase`).
- Double-click on the bar toggles maximize (native behaviour of the drag region).

### 3.4 Left glass sidebar

`.glass`, no outer shadow, 1 px right hairline. Width animates 212 ↔ 56 px over `--dur-base` with `--ease-in-out`; labels fade out in the first 90 ms of collapsing. State persists.

| Zone | Content |
|---|---|
| Top (40 px, drag) | Collapse toggle at left 12 px: `PanelLeftClose` / `PanelLeftOpen`. Tooltip `Collapse sidebar · Ctrl+\`. |
| Workspaces (from y = 56 px) | Four rows, 36 px high, 8 px side margin, `--r-sm`: `Image` Generate · `Brush` Edit · `Box` 3D · `LayoutGrid` Library. Shortcuts `Ctrl+1…4`. |
| Spacer | Empty. No recents, no projects. |
| Bottom cluster (12 px padding, 6 px gaps) | Memory pill · Blender row · Theme toggle |

Row states: idle `--text-secondary`; hover `--surface-hover` + `--text-primary`; active `--surface-active`, `--text-primary`, icon `--accent`. No left bar, no bold. While a job runs in a workspace the user has left, that row's icon carries a 5 px `--accent` dot at its top-right.

**Memory pill** (button, opens the Models & Memory drawer; `Ctrl+M`):
- Expanded: 44 px tall, `--surface-sunken`, `--r-md`. Line 1: `Cpu` icon + `mono` `21.4 / 102 GB`. Line 2: a 2 px bar for VRAM (`--accent` fill on `--surface-active`) and, 3 px below, a 2 px bar for RAM (`--text-muted` fill). Tooltip: `GPU memory 21.4 of 102 GB · System memory 31.0 of 64 GB`.
- Rail: a 28 px ring gauge (two concentric 2 px arcs, VRAM outer in accent, RAM inner in muted), drawn with one inline SVG, updated by setting `stroke-dashoffset`.
- Above 90 % VRAM the outer bar/arc turns `--warn`. Values come from `telemetry` events (§4.5 of the contract); the pill re-renders at most once per second.

**Blender row** (32 px): 6 px dot + `Blender` label (label hidden in rail). Dot: `--sage` connected, `--text-faint` hollow ring when not found. Tooltip `Blender 5.3 connected` / `Blender not running — click to open`. Click when disconnected calls `window.studio.blender.launch()`; click when connected does nothing but show the tooltip.

**Theme toggle** (32 px icon button): `Sun` in Zen Dark (click → light), `Moon` in Zen Light. Tooltip `Zen Light` / `Zen Dark`. `Ctrl+Shift+L`.

**Engine state** has no permanent indicator. When the engine process is not `ready`, the memory pill shows the state instead of numbers (§8.1).

---

## 4. Shared components

All in `app/src/components/ui/`. Each has exactly the variants listed.

| Component | Spec |
|---|---|
| `IconButton` | 32 px circle, transparent; hover `--surface-hover`; pressed `--surface-active`; `aria-label` required; tooltip required. Variants: `ghost` (default), `glass` (on-image use, `.glass`), `danger` (glyph turns `--danger` on hover). |
| `Pill` | 28 px high, 10 px side padding, `--r-full`, `ui` text, optional leading icon 14 px, optional trailing `ChevronDown` 12 px when it opens a popover. Idle `--surface-sunken`; hover `--surface-hover`; selected `--accent-soft` + `--accent` text. |
| `Segmented` | A row of pills sharing one `--surface-sunken` track (2 px padding); the selected segment is `--surface-elevated` with `--shadow-1` and slides (`transform`, `--dur-fast`). Used for mode toggles and Auto-unload. |
| `PrimaryButton` | 40 px circle, `--accent` fill, `--text-on-accent` glyph. Generate glyph `ArrowUp`; Stop glyph `Square` (filled, 12 px). Disabled: `--surface-active` fill, `--text-faint` glyph. While running, a 2 px progress ring (`--accent`) wraps the button on a 46 px track, driven by `job.progress.progress`. |
| `Slider` | 4 px track `--surface-sunken`, fill `--accent`, 14 px thumb `--surface-elevated` with `--shadow-1` and hairline. Value shown at right in `mono`. Arrow keys ±1 step, `Shift` ±10 steps, double-click resets to default. |
| `NumberField` | `mono`, 28 px high, `--surface-sunken`, `--r-sm`; scroll or ↑/↓ to step; invalid input reverts on blur. |
| `Tooltip` | Opens after 450 ms hover or immediately on keyboard focus; `caption`; `--surface-tooltip` / `--text-on-tooltip`; 6 px radius; 6 × 8 px padding; shortcut in `mono-sm` at 65 % opacity after a middle dot: `Mask brush · M`. Max one line. |
| `Popover` | `.glass-strong`, `--r-md`, 12 px padding, opens toward free space with 8 px gap, `--dur-fast`. Closes on outside click, `Esc`, or losing focus. Focus is trapped while open and returns to the trigger. |
| `Menu` | `--surface-elevated`, `--shadow-3`, `--r-md`, 4 px padding; items 32 px, `ui`, leading icon, trailing shortcut in `mono-sm`. |
| `Drawer` | Slides from the right over a `--scrim`; `.glass-strong`; full height below the titlebar; 24 px padding; close with `Esc`, scrim click, or `X` at top-right. |
| `Whisper` | One-line pill, `caption`, `.glass-strong`, centred 16 px above the prompt capsule (or bottom-centre in Library). Auto-dismiss 2.4 s; errors stay 6 s and include one text action. Only one whisper exists; a new one replaces the old. `role="status"`. |
| `Checker` | CSS conic-gradient checkerboard from `--bg-checker-a/b`, 12 px cells, behind any image with alpha. |

Focus: every focusable element shows `outline: 2px solid var(--accent-ring); outline-offset: 2px` on `:focus-visible` only.

---

## 5. Workspaces

Workspaces stay mounted once visited (state and canvases persist); the inactive ones are `display: none` and their render loops are stopped.

### 5.1 Generate (text → image)

```
                         titlebar
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│                    ┌──────────────────┐ ┌──┐                     │
│                    │                  │ │⇩ │  action rail        │
│                    │   stage image    │ │⧉ │  (on hover)         │
│                    │   / murmuration  │ │✎ │                     │
│                    │                  │ │◇ │                     │
│                    └──────────────────┘ │🗑│                     │
│                    1024 × 1024 · seed 3829104412 · 9 steps · 4.2 s│
│                                                                  │
│      ┌──────────────────────────────────────────────────────┐    │
│      │ A heron standing in morning fog…                     │    │
│      │ [Z-Image Turbo ▾] [1:1 ▾] [⚄ 3829104412 🔒] [⚙]   ✦  ( ↑ )│
│      └──────────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────┤
│ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢                                  filmstrip     │
└──────────────────────────────────────────────────────────────────┘
```

#### 5.1.1 Stage

- The stage is everything between titlebar and filmstrip. The **image rect** is the largest rectangle of the target aspect ratio that fits inside the stage with insets: top 24, left/right 64, bottom = capsule height + 40. Radius `--r-lg`, `--shadow-2`. The image rect is computed in one place (`useStageRect`) and shared by the `<img>`, the Murmuration canvas and the hover rail.
- **Empty** (no image yet, no job): serif `display` headline centred in the stage, `--text-primary`: `Describe an image,` + italic `then let it gather.` Below, `body` `--text-muted`: `Ctrl+Enter to generate`. Nothing else.
- **Running**: the Murmuration canvas (§7) fills the stage. The image rect shows the frosted pane (Phase A), then the live preview (Phase B).
- **Done**: the final PNG in an `<img>` (decoded before reveal). The Murmuration canvas is hidden and its loop stopped.
- **Batch > 1**: after completion the stage shows the first image; a row of 6 px dots under the image (one per image, active dot `--accent`) switches between them (`←`/`→`). Each finished image also enters the filmstrip as it is saved (`job.progress` with `phase: "saved"`).

**Zoom and pan.** Click the image to enter inspect mode: capsule, rails and filmstrip fade to 0 (`--dur-fast`), cursor becomes `zoom-in`. Wheel zooms about the cursor (0.25×–8×, 1.1× per notch); drag pans; double-click toggles Fit ↔ 100 %; `Esc` or a click without drag exits. A `mono-sm` zoom readout (`183%`) sits bottom-centre while inspecting. Implementation: CSS `transform` on the `<img>` (`image-rendering: auto` below 400 %, `pixelated` above).

**Metadata whisper pill.** 8 px below the image, left-aligned to it, `mono-sm`, `--text-muted`, no background: `1024 × 1024 · seed 3829104412 · 9 steps · 4.2 s`. Clicking the seed copies it (whisper `Seed copied`). Hidden while running.

**Quick action rail.** Vertical `.glass` pill, 8 px to the right of the image rect, vertically centred on it; appears on image hover or keyboard focus within the stage (`--dur-fast`), hidden while running. Five `IconButton`s, 4 px gap:

| Icon | Tooltip · shortcut | Action |
|---|---|---|
| `Download` | `Save a copy · Ctrl+S` | `window.studio.files.saveCopy(path)` (native save dialog) |
| `Copy` | `Copy image · Ctrl+C` | `window.studio.clipboard.writeImage(path)`; whisper `Copied` |
| `Brush` | `Edit in canvas · E` | Opens the image in Edit as the base layer |
| `Box` | `Make 3D · 3` | Opens 3D in `Image → 3D` with this image as source |
| `Trash2` (danger) | `Delete · Del` | `window.studio.library.delete([item.sidecarPath])`; image leaves stage and filmstrip; whisper `Moved to Recycle Bin` |

#### 5.1.2 Prompt capsule

Floating, centred in the content column, `bottom: var(--filmstrip-h) + 16px`, width `min(var(--capsule-max-w), 100% − 96px)`. `.glass-strong`, `--r-xl`, `--shadow-3`, padding 12 × 14 px.

**Row 1 — prompt.** Borderless `<textarea>`, `prompt` type, auto-grows 1–6 lines then scrolls, placeholder `Describe an image` in `--text-muted`. `Ctrl+Enter` runs. `Enter` inserts a newline. Text persists per workspace across restarts.

**Row 1b — negative prompt (collapsed by default).** Toggled by a `CircleMinus` `IconButton` at the right end of row 1 (tooltip `Exclude · Ctrl+Shift+N`). When open: a 1 px hairline, then a single-line growing textarea (max 3 lines), `body`, placeholder `Leave out…`. When CFG is 1.0 the negative prompt has no effect on these turbo models; the row then shows a trailing `caption` hint in `--text-muted`: `Applies when CFG is above 1`. The toggle icon is `--accent` when the field is non-empty.

**Row 2 — controls** (8 px gaps, wraps never; below 700 px capsule width the seed pill collapses to its dice icon):

| Order | Control | Behaviour |
|---|---|---|
| 1 | **Model pill** `Z-Image Turbo ▾` | Popover with two rows. Each row: family name in `ui`, state dot (`Cold` faint ring / `Warming` warn pulse / `Warm` sage), and a `mono-sm` line `9 steps · 16 px grid` / `8 steps · 32 px grid`. Switching model resets Steps to that model's default and re-snaps W×H to its grid. |
| 2 | **Aspect pill** `1:1 ▾` (leading glyph: an outlined rectangle of that ratio) | Popover: five preset tiles with ratio glyph + `mono-sm` size, then a hairline, then `W` × `H` `NumberField`s with a `Link2` lock-ratio toggle between them. Presets (valid for both models): `1:1` 1024×1024 · `2:3` 832×1248 · `3:2` 1248×832 · `9:16` 768×1344 · `16:9` 1344×768. Custom range 256–2048, snapped on blur to a multiple of 16 (Z-Image) or 32 (Qwen); the pill then reads `1152 × 896` in `mono`. |
| 3 | **Seed pill** | `Dices` button (randomize now) · editable `mono` seed (0–4294967295) · `Lock` / `LockOpen` toggle. Unlocked (default): a new random seed is drawn on every run and shown here once `job.started` arrives. Locked: the shown seed is reused. Clicking the number selects it; `Ctrl+C` while focused copies it. Right-click → `Copy seed`. |
| 4 | **Settings** `SlidersHorizontal` | Popover 280 px: `STEPS` slider 1–50 · `CFG` slider 1.0–10.0 step 0.1 · `SAMPLER` select · `SCHEDULER` select · `BATCH` segmented 1 / 2 / 3 / 4. A `RotateCcw` `IconButton` at the popover's top-right resets to model defaults. The settings icon turns `--accent` when any value differs from the default. Options and defaults come from `GET /api/models` (`defaults`, `samplers`, `schedulers`). |
| — | flexible space | |
| 5 | **Enhance** `Sparkles` | Rendered only when `health.inklingAvailable` is true. Click toggles auto-enhance (`enhancePrompt: true` on the next runs); on = `--accent` glyph on `--accent-soft`. `Ctrl+E` or Shift-click enhances **in place now**: calls `POST /api/enhance-prompt`, the glyph spins once per second while waiting, the textarea text is replaced (native undo stack preserved, so `Ctrl+Z` restores). Tooltip `Enhance prompt · Ctrl+E`. When Inkling becomes unreachable the icon disappears and the toggle state is kept but ignored. |
| 6 | **Generate / Stop** `PrimaryButton` | Disabled when the prompt is empty or the engine is not ready. While a job is active in this workspace it is Stop (`POST /api/cancel`); `Esc` also stops when the textarea is not focused. |

When auto-enhance rewrote the prompt, the enhanced text appears as a two-line-clamped `caption` in `--text-muted` under the metadata pill, prefixed with a 12 px `Sparkles` glyph; clicking it copies the enhanced prompt into the textarea.

#### 5.1.3 Filmstrip

Persistent tray along the bottom of the content column, 76 px, `.glass` with only a top hairline. Horizontal list of the 24 most recent `image` items (from the Library store), newest at the left; thumbs 56 × 56, `object-fit: cover`, radius 10 px, 8 px gap, 16 px side padding. Wheel scrolls horizontally. No scrollbar; 24 px fade masks at both ends.

- Click: show that item on the stage (its params do **not** overwrite the capsule; right-click → `Reuse prompt and seed` does).
- The shown item has a 2 px `--accent` outline at 2 px offset.
- Hover: thumb lifts 2 px; a 20 px `Trash2` `IconButton` (`glass`, `danger`) appears at its top-right. Click deletes to the Recycle Bin.
- New items insert at the left with a 240 ms width + opacity animation. During a job, a placeholder tile with a slow accent shimmer ring holds the next slot.
- Empty: the tray is present but blank (no placeholder text).

### 5.2 Edit & Canvas

```
┌──────────────────────────────────────────────────────────────────────┐
│          [ ◐ size ▬▬●▬  hard ▬●▬▬  opac ▬▬▬● │ ■■■■■■ #4B50C8 ]       │  brush bar (B/M/E only)
│ ┌──┐                                              [↶ ↷ │ 100% ⤢ │ ◫] │  view cluster
│ │V │        ┌────────────────────────────────┐                 ┌───┐ │
│ │B │        │                                │                 │ 1 │ │  reference strip
│ │M │        │      canvas document           │                 │ 2 │ │  (Smart edit only)
│ │E │        │                                │                 │ + │ │
│ │──│        │                                │                 │ + │ │
│ │◑ │        └────────────────────────────────┘                 └───┘ │
│ │⊘ │                                                                 │
│ │👁│     ┌───────────────────────────────────────────────────────┐   │
│ │──│     │ [Smart edit] [Inpaint] [Img2Img]      denoise ▬▬●▬ 0.60│   │
│ │✂ │     │ Make the jacket deep green…                            │   │
│ └──┘     │ [⚄ seed 🔒] [⚙]                              ✦   ( ↑ )│   │
│          └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

#### 5.2.1 Document model

A document is three same-sized layers plus a view transform:

| Layer | Backing | Meaning |
|---|---|---|
| `base` | `OffscreenCanvas` RGBA at document resolution | The image. May contain alpha (after Remove background). |
| `paint` | `OffscreenCanvas` RGBA | Colour strokes from the Paintbrush. Flattened over `base` when sent to the engine. |
| `mask` | `OffscreenCanvas`, alpha channel only is meaningful | Inpaint mask. Alpha 255 = regenerate. |

One visible `<canvas>` (Canvas2D, `desynchronized: true`) composites: checker → `base` → `paint` → mask overlay (`--mask-tint` fill through the mask alpha plus a 1 px `--mask-edge` outline computed once per stroke end) → brush cursor ring. It redraws only on change (dirty flag + a single `requestAnimationFrame`); there is no continuous loop.

- **Opening an image**: drop a file on the workspace, paste (`Ctrl+V`), `Ctrl+O`, or `Edit in canvas` from Generate/Library. Long edge above 2048 px is downscaled to 2048 (Lanczos via `createImageBitmap` `resizeQuality: "high"`), with whisper `Fitted to 2048 px`. Opening over unsaved strokes replaces the document; the previous document remains reachable through Undo.
- **Empty state**: serif `display`: `Drop an image` + italic `to begin.`; `body` muted: `or paste, or press Ctrl+O`. The tool rail and capsule are visible but disabled (40 % opacity).
- **View**: fit on open. Zoom 10 %–1600 % about the cursor (`Ctrl+wheel`, pinch, `Ctrl+=`/`Ctrl+-`), `Ctrl+0` fit, `Ctrl+Alt+0` 100 %. Plain wheel pans vertically, `Shift+wheel` horizontally. Above 800 % nearest-neighbour sampling and a 1 px pixel grid in `--border-hairline`.

#### 5.2.2 Tool rail

Vertical `.glass` pill, 44 px wide, left 16 px, vertically centred in the stage. `IconButton`s (36 px here), groups separated by 1 px hairlines with 6 px margin.

| Group | Icon | Tool / action | Shortcut |
|---|---|---|---|
| Tools | `MousePointer2` | Select / Pan — drag pans the view | `V`; hold `Space` from any tool |
| | `Brush` | Paintbrush — paints on `paint` | `B` |
| | `CircleDashed` | Mask brush — paints on `mask` | `M` |
| | `Eraser` | Eraser — erases whichever of `paint`/`mask` was last painted on; `Alt` flips the target | `E` |
| Mask | `Contrast` | Invert mask | `Ctrl+I` |
| | `CircleSlash` | Clear mask | `Ctrl+Shift+X` |
| | `Eye` / `EyeOff` | Toggle mask visibility (overlay only; the mask still applies) | `H` |
| Instant | `Scissors` | **Remove background** | `Ctrl+Shift+B` |

The active tool's button is `--accent-soft` with an `--accent` glyph. Mask-group buttons are disabled when the mask is empty.

**Remove background** is a one-click action, not a mode. It flattens `base + paint`, calls `POST /api/generate/edit` with `mode: "remove_bg"`, shows Phase A murmuration over the document, and replaces `base` with the returned RGBA PNG — the canvas becomes genuinely transparent (checker visible) with no intermediate dialog. `paint` is cleared; `mask` is kept. One history entry. The result is also saved to the Library as an `edit` item.

#### 5.2.3 Brush bar

Horizontal `.glass` pill, top-centre of the stage, 16 px below the titlebar; visible only while `B`, `M` or `E` is active (`--dur-fast` fade).

| Control | Range / default | Notes |
|---|---|---|
| Size | 1–512 px (document pixels), default 48; logarithmic slider | `[` / `]` step by 10 % (min 1 px). A live preview dot left of the slider shows size and hardness. |
| Hardness | 0–100 %, default 80 (paint), 100 (mask) | Radial falloff: fully opaque inside `hardness × r`, smoothstep to 0 at `r`. |
| Opacity | 1–100 %, default 100 | Per stroke: stamps accumulate in a stroke buffer capped at this opacity, then composite on pointer-up. Hidden for Mask brush (mask is binary-ish: always 100 %). |
| Colour | Paintbrush only | Six swatches (20 px, `--r-xs`): `#18181B`, `#FFFFFF`, `#B8433A`, `#C9A227`, `#4F6F5B`, `#4B50C8`; then the current colour chip, which opens a popover with a saturation/value square, hue strip, hex field (`mono`) and an eyedropper (`Pipette`, or hold `Alt` on canvas). The last six custom colours replace swatches right-to-left. |

**Brush engine.** Pointer Events with `getCoalescedEvents()`; stamps spaced at `max(1, 0.12 × size)` along a Catmull-Rom-smoothed path; pen pressure scales size (50–100 %) when `pointerType === "pen"`. The cursor is a 1 px ring at brush size (two rings, ink + paper, so it reads on any image), hidden below 4 screen px in favour of a crosshair. `Shift`-click draws a straight line from the last stamp.

#### 5.2.4 View cluster

`.glass` pill, top-right of the stage (16 px inset): `Undo2` (`Ctrl+Z`) · `Redo2` (`Ctrl+Y`, `Ctrl+Shift+Z`) · hairline · zoom readout in `mono-sm` (click opens a menu: `Fit · Ctrl+0`, `100% · Ctrl+Alt+0`, `200%`, `400%`) · `Scan` (fit) · hairline · `Columns2` Before/After (`\`).

**History.** Linear stack, 40 entries. Stroke entries store only the dirty rectangle's before/after `ImageData` for the affected layer. Base replacements (generation result, remove background, open) store a full bitmap reference; at most 8 such bitmaps are retained (older base states are dropped from the bottom of the stack). Undo/redo never contacts the engine.

**Before / After.** Enabled once the document has an edit result. Toggling shows a vertical divider (1 px `--text-on-accent` line with a 28 px round `.glass` grip carrying `ChevronsLeftRight`) over the document: left of it the pre-edit base, right of it the current base. Drag the grip or anywhere on the divider; `←`/`→` nudge by 2 %. Labels `Before` / `After` in `caption` pills at the top corners. When the result has different dimensions from the original (Smart edit), both are fitted to the same on-screen rect. Painting is disabled while comparing.

#### 5.2.5 Reference strip (Smart edit only)

Vertical `.glass` pill, right 16 px, vertically centred, four 64 × 64 slots (`--r-md`), 8 px gap. Slot **1** is the canvas itself (live thumbnail, non-removable, `mono-sm` index `1` at its corner). Slots **2–4** are additional reference images: empty slots show a `Plus` glyph in `--text-faint`; click opens a file picker, and files can be dropped or pasted onto a slot. Filled slots show the image, their index, and an `X` on hover. References are uploaded once through `POST /api/upload` and sent as paths in `referenceImages`. The index numbers matter: the instruction can say "the pattern from image 2". Hidden in Inpaint and Img2Img.

#### 5.2.6 Edit capsule

Same shell and position as the Generate capsule (no filmstrip here, so `bottom: 20px`).

**Row 0 — mode.** `Segmented`: `Smart edit` · `Inpaint` · `Img2Img`. Tooltips carry the model: `Qwen-Image 2.1 — edit by instruction`, `Z-Image Turbo — repaint the masked area`, `Z-Image Turbo — reinterpret the whole image`. To its right, in Inpaint and Img2Img only: **Denoise** slider 0.05–1.00, step 0.01 (defaults: Inpaint 0.85, Img2Img 0.60), label `micro` `DENOISE`, value `mono`.

**Row 1 — instruction.** Textarea as in Generate. Placeholders by mode: `Describe the change` / `Describe what belongs in the masked area` / `Describe the image you want`.

**Row 2 — controls.** Seed pill · Settings popover (`STEPS`, `CFG`, `SAMPLER`, `SCHEDULER`; plus `RESOLUTION` segmented `768 / 1024 / 1280 / 1536` in Smart edit; plus negative prompt field) · space · Enhance (`style: "edit"`) · Run / Stop.

Run rules:
- Inpaint with an empty mask: Run is disabled; tooltip `Paint a mask first · M`; pressing `Ctrl+Enter` selects the Mask brush and whispers the same hint.
- What is sent: `imageBase64` = PNG of `base` flattened with `paint`; `maskBase64` = 8-bit grayscale PNG from the mask alpha (Inpaint only). See contract §3.11.
- While running: Phase A then Phase B murmuration clipped to the document's on-screen rect. In Inpaint, the live preview is shown only inside the mask (the shader receives the mask as `uClipMask`; outside it the untouched base shows through).
- On completion: the result becomes the new `base` (document resizes if Smart edit changed dimensions); `paint` and `mask` are cleared; one history entry; Before/After becomes available; whisper `Saved to Library`.

### 5.3 3D Studio

```
┌────────────────────────────────────────────────────────────────────────┐
│      ▢──▢──▢──▢──▣──○──○     Source · Cutout · Depth · Structure ·    │  milestone strip
│                              Shape · Texture · Mesh    [Export ▾] [Send to Blender ●]
│                                                                  ┌──┐  │
│                                                                  │F │  │
│                    three.js PBR viewport                         │S │  │  viewport rail
│                                                                  │T │  │
│                                                                  │I │  │
│                                                                  │↺ │  │
│  V 152,340 · T 300,000 · 1.00 × 0.82 × 0.64 m                    │──│  │
│                                                                  │◐ │  │
│      ┌────────────────────────────────────────────────────┐      │☀ │  │
│      │ [Text → 3D | Image → 3D]                           │      │⟳ │  │
│      │ A weathered bronze fox statue…                     │      └──┘  │
│      │ [Pixal3D ▾] [Quality ▾] [⚄ seed 🔒]        ✦  ( ↑ )│            │
│      └────────────────────────────────────────────────────┘            │
└────────────────────────────────────────────────────────────────────────┘
```

#### 5.3.1 Capsule

- **Row 0** — `Segmented`: `Text → 3D` · `Image → 3D`.
- **Row 1** — Text mode: prompt textarea, placeholder `Describe one object`. Image mode: a 72 × 72 source slot (`--r-md`, dashed hairline, `ImagePlus` glyph; drop, paste, click to browse, or filled by `Make 3D` from elsewhere) followed by a `body` muted line `One object, plain background works best`. A filled slot shows the image with an `X` on hover.
- **Row 2** — **Engine pill** `Pixal3D ▾` / `TRELLIS.2 ▾` (popover rows with state dot and `mono-sm` size on disk) · **Quality pill** (popover, 280 px): `TARGET FACES` slider 100k–700k, step 50k, default 300k, value `mono` `300,000`; `REMESH` segmented `512 / 768 / 1024`, default 512, with a `caption` muted note under 1024: `Uses the most memory — other models unload first`; `Remove background` switch, default on · **Seed pill** · space · **Enhance** (Text mode only, `style: "3d"`) · **Generate / Stop**.

#### 5.3.2 Milestone strip

Top-left of the stage, 16 px inset, a row of seven 56 × 56 tiles (`--r-md`) joined by 16 px hairline connectors; under each a `caption` label: `Source`, `Cutout`, `Depth`, `Structure`, `Shape`, `Texture`, `Mesh`.

| Tile state | Appearance |
|---|---|
| Pending | `--surface-sunken`, label `--text-faint` |
| Active | 1.5 px `--accent` ring, slow shimmer sweep, label `--text-primary`; if the stage reports steps, a `mono-sm` `6/12` replaces the label |
| Done | The milestone thumbnail from `job.stage_preview.imagePath` (fade-in 240 ms), label `--text-secondary`; if `imagePath` is null, a `Check` glyph in `--sage` |
| Skipped | A short dash, label `--text-faint` (TRELLIS.2 skips `Depth`; `Cutout` is skipped when Remove background is off) |
| Error | `--danger` ring on the failed tile, later tiles stay pending |

Hover on a done tile opens a 320 px preview popover of that milestone image. Clicking `Mesh` reframes the camera. The strip is hidden until the first job starts and stays afterward, reflecting the mesh currently in the viewport (stage files are stored with the asset, contract §5).

#### 5.3.3 Viewport

Three.js `WebGLRenderer` (`antialias: true`, `powerPreference: "high-performance"`, `outputColorSpace: SRGBColorSpace`, `toneMapping: NeutralToneMapping`), pixel ratio `min(devicePixelRatio, 2)`. Background: CSS vertical gradient `--viewport-bg-top → --viewport-bg-bottom` behind a transparent canvas. **Render on demand**: a frame is drawn only when controls change, damping is settling, auto-rotate is on, or a camera tween is active.

- **Camera**: perspective, FOV 35°, fitted to the bounding sphere with 1.35× margin. `OrbitControls`: `enableDamping`, `dampingFactor 0.08`, distance limits 0.25×–8× radius, pan with right-drag or `Shift`-drag, double-click resets the orbit target to the picked point.
- **Model**: `GLTFLoader`. On load: centre on the origin in X/Z, rest on Y = 0, compute stats. The previous model's geometries, materials and textures are disposed.
- **Ground**: no grid. A single soft contact-shadow disc (pre-baked radial gradient texture, `MeshBasicMaterial`, multiply) under the model.
- **While generating**: the viewport keeps showing the previous mesh dimmed to 35 % (or the empty state), with Phase A murmuration over it. In Text mode, Phase B shows the source image forming (stage `source` emits previews). When `Shape` completes with a clay thumbnail it appears large in the viewport centre as a still until the final GLB loads, at which point the mesh fades in over 300 ms with a 15° settle-rotation.
- **Empty state**: serif `display`: `Give it a subject,` + italic `get it in the round.`

**Viewport rail** — vertical `.glass` pill, right 16 px, vertically centred:

| Group | Control | Detail |
|---|---|---|
| Camera | Four `mono-sm` letter buttons `F` `S` `T` `I` and `RotateCcw` | Front (`1`), Side (`2`, +X), Top (`3`), Iso (`4`, azimuth 35°, elevation 25°), Reset (`0`). Tween 450 ms `--ease-out`. |
| Shading | `Circle` button opening a 4-item menu | `Lit PBR` (`L`), `Clay` (`C`), `Wireframe` (`W`), `Normals` (`N`). Clay: `MeshStandardMaterial` `--clay`, roughness 0.9, metalness 0. Wireframe: clay at full opacity plus a `LineSegments`/`wireframe` overlay in `--wire`. Normals: `MeshNormalMaterial`. Original materials are kept and swapped back, never mutated. |
| Lighting | `Sun` button opening a menu + exposure slider | `Studio` (RoomEnvironment via PMREM, intensity 1.0, soft key from front-left), `Warm` (same environment at 0.7 plus a 3200 K key and faint cool fill), `Rim` (environment 0.2, two back rim lights). `EXPOSURE` slider 0.25–2.50, default 1.00. |
| Motion | `Rotate3d` toggle | Auto-rotate, one turn per 40 s; pauses while the pointer is down; `R`. |

**HUD** — bottom-left, 16 px inset, `mono-sm`, `--text-muted`, no background: `V 152,340 · T 300,000 · 1.00 × 0.82 × 0.64 m`. Values come from the sidecar `mesh` block, not recomputed.

**Export and Blender** — top-right, 16 px inset:
- `Export ▾` `Pill` → `Menu`: `.glb` · `.obj` · `.stl` · `.fbx` · `.blend`. `.glb` is a file copy; the others convert through headless Blender (`window.studio.mesh.export`). While converting, the menu item shows a spinner and the pill reads `Exporting…`; on success whisper `Exported fox.fbx` with action `Show` (reveals in Explorer). If Blender is not installed the four converted formats are disabled with tooltip `Needs Blender 5.3`.
- **Send to Blender** — the one prominent secondary action in the app: 36 px pill, `--accent-soft` fill, `--accent` text, `Send` icon, a 6 px connection dot at the right (`--sage` connected / hollow `--text-faint`). Connected: imports the current GLB via `window.studio.blender.import`; the label becomes `Sent` with a `Check` for 2 s. Disconnected: label `Open Blender`; click launches Blender with the bridge enabled, and once the dot turns sage the button returns to `Send to Blender` (it does not auto-send). `Ctrl+B`.

### 5.4 Library

```
┌──────────────────────────────────────────────────────────────────────┐
│  Library                    [All] [Images] [Edits] [3D]   ♡   🔍 Search   [Select]
│                                                                      │
│  ▢▢  ▢   ▢▢▢  ▢                                         ┌──────────┐ │
│  ▢▢  ▢▢  ▢▢▢  ▢▢      masonry, virtualized              │ inspector│ │
│  ▢   ▢▢  ▢    ▢▢                                        │ 380 px   │ │
│  ▢▢  ▢   ▢▢   ▢                                         │          │ │
└──────────────────────────────────────────────────────────────────────┘
```

- **Header** (64 px, 32 px side padding): `title` serif `Library` at left. Right-aligned in order: filter `Pill`s `All` · `Images` · `Edits` · `3D` (single-select); `Heart` toggle `IconButton` (favorites only); search field (220 px, `--surface-sunken`, `Search` icon, placeholder `Search prompts`, `Ctrl+F`, 150 ms debounce, matches prompt, enhanced prompt, seed and model label); `Select` pill.
- **Grid**: masonry by columns, column width 220–280 px (`repeat(auto-fill, minmax(220px, 1fr))` semantics), 12 px gutters, tiles `--r-md`, natural aspect ratio from sidecar `width`/`height` (3D tiles are square). Thumbnails are the 512 px WebP files from `studio-core` loaded through `studio://thumbs/…`. Virtualized (only rows within 1.5 viewports are mounted). Newest first. Date separators are not shown.
- **Tile**: image only. A 3D tile carries a 14 px `Box` glyph in a `.glass` chip at bottom-left. On hover: a soft bottom gradient, `Heart` (top-right) and `Trash2` (`danger`, next to it) `glass` `IconButton`s. A favorited tile shows a filled `Heart` in `--accent` permanently. Focus ring per §4.
- **Click** opens the Inspector. **Double-click** opens the item in its home workspace (image → Generate stage, edit → Edit, 3D → 3D viewport).
- **Delete**: hover trash, `Delete` key on the focused/selected tile(s), or the Inspector. Single delete is immediate: the tile collapses (240 ms) and a whisper reads `Moved to Recycle Bin`. All deletion goes through `window.studio.library.delete` → `studio-core delete` → Windows Recycle Bin, so recovery is always possible from the Bin.
- **Select mode** (`Select` pill or `Ctrl`-click any tile): tiles gain a 20 px check circle at top-left; click toggles; `Shift`-click selects a range; `Ctrl+A` selects all filtered. The header's right side is replaced by a selection bar: `mono` `12 selected` · `Heart` · `Delete selected` (danger pill) · `Done`. `Delete selected` with 2+ items asks twice inline: first click turns it into a filled `--danger` pill reading `Delete 12 — confirm` for 3 s; the second click deletes. `Esc` leaves select mode.
- **Empty states**: none at all — serif `Nothing here yet.` + muted `What you make appears in this room.`; no search results — serif `No match.` + muted `Try fewer words`.

#### 5.4.1 Inspector drawer

Slide-over from the right, `--inspector-w`, `.glass-strong`, **no scrim** (the grid stays interactive and reflows to the remaining width); `Esc` closes; `←`/`→` move to the previous/next item.

Top to bottom, 24 px padding, 20 px between blocks:

1. Preview: the image (or the 3D preview render) fitted to the drawer width, `--r-md`, click to open in its workspace.
2. Action row, six `IconButton`s with tooltips: `RotateCcw` `Reuse prompt and seed` (fills the Generate / Edit / 3D capsule and switches there) · `Brush` `Send to Edit` · `Box` `Send to 3D` · `Send` `Send to Blender` (3D items only; disabled when disconnected) · `FolderOpen` `Reveal in Explorer` · `Copy` `Copy image`. Then, right-aligned: `Heart` and `Trash2`.
3. `micro` `PROMPT` — the prompt in `body`, selectable, with a `Copy` icon on hover.
4. `micro` `ENHANCED` — only when `params.enhanced` is true; `body`, `--text-secondary`.
5. A two-column definition list, labels `caption` muted, values `mono`: `Seed` (click copies) · `Model` · `Size` `1024 × 1024` · `Steps` · `CFG` · `Sampler` `euler / simple` · `Denoise` (edits) · `Mode` · `Took` `4.2 s` · `Created` `25 Nov 2026, 14:30`.
6. 3D items add: `Engine`, `Vertices`, `Triangles`, `Bounds`, and the seven milestone thumbnails in a 4-column mini grid.
7. Negative prompt, if any, under `micro` `EXCLUDED`.

---

## 6. Models & Memory drawer

`Drawer` (§4), `--drawer-w`, opened from the sidebar memory pill or `Ctrl+M`.

```
Models & Memory                                                    ✕
GPU memory      ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬     21.4 / 102.0 GB
System memory   ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬     31.0 /  64.0 GB

Z-Image Turbo                                    ● Warm      [Unload]
19.5 GB on disk · 4 files · used 2 min ago
  ▸ files

Qwen-Image 2.1                                   ○ Cold     [Warm up]
…
3D · Pixal3D  /  3D · TRELLIS.2  /  BiRefNet

Auto-unload idle        [Off | 5m | 10m | 15m | 30m]
                                              [ Unload all models ]
```

- **Title**: serif `title`.
- **Memory bars**: label `ui`, 6 px bar (`--surface-sunken` track, `--accent` fill for GPU, `--text-secondary` fill for system; `--warn` above 90 %), figures `mono-lg` right-aligned. The GPU bar is segmented: one segment per warm family (alternating `--accent` at 100 % and 70 % opacity) followed by an `other` segment in `--text-faint`; hovering a segment shows a tooltip `Z-Image Turbo · 19.9 GB (estimate)`. Width transitions 400 ms linear. On this unified-memory machine GPU and system memory share physical RAM; the two bars are shown independently and never summed.
- **Family cards** (in this order: `Z-Image Turbo`, `Qwen-Image 2.1`, `3D · Pixal3D`, `3D · TRELLIS.2`, `BiRefNet`), separated by hairlines, no card background:
  - Line 1: family label in serif `heading`. Right: state badge, then one action button.
  - State badge = 6 px dot + `caption` word: `Cold` (hollow ring, `--text-muted`), `Warming` (`--warn`, dot pulses; word is followed by nothing — no percentage), `Warm` (`--sage`), `Unloading` (`--text-muted`, dot pulses).
  - Action: `Warm up` (ghost pill) when cold; `Unload` (ghost pill) when warm; disabled spinner pill while warming/unloading. Both are disabled while a job is active (tooltip `Busy generating`).
  - Line 2, `mono-sm` `--text-muted`: `19.51 GB on disk · 4 files · used 2 min ago` (exact bytes in the tooltip: `20,948,784,834 bytes`).
  - Disclosure `ChevronRight` `files` expands a list: one row per file — role label in `caption` (`Diffusion model`, `Text encoder`, `VAE`, `LoRA`, `Preview decoder`, `Vision encoder`, `Geometry`, `Matting`), filename in `mono-sm` (middle-ellipsis), size in `mono-sm`, and under it the safetensors facts from `studio-core scan-models`: `BF16 · 1,204 tensors · 6.15 B params` plus any of `modelspec.architecture`, `modelspec.title` present in the header metadata. A file shared with another family carries a `Link2` glyph with tooltip `Shared with 3D · TRELLIS.2`. A missing file shows `--danger` text `Missing` and disables `Warm up` for the family.
- **Footer** (sticks to the bottom, top hairline): `Auto-unload idle` label + `Segmented` `Off · 5m · 10m · 15m · 30m` (writes `POST /api/settings`); below it, right-aligned, `Unload all models` — ghost pill with `--danger` text, asks twice inline like bulk delete (`Unload all — confirm`).
- Data: `GET /api/models` on open, then live from `models.status` and `telemetry` WebSocket events; file facts from `window.studio.core.scanModels()` cached for the session. If the engine is offline the cards render from the static family table (contract Appendix A) joined with the scan, all states `Cold`, actions disabled.

---

## 7. Murmuration — WebGL2 boids + diffusion distortion

One reusable module, `app/src/murmuration/`, used by Generate, Edit and 3D. It turns waiting into something worth watching and then gets out of the way completely.

### 7.1 Phases

| Phase | Trigger | What is on screen |
|---|---|---|
| `idle` | Initial; after reveal; after cancel fade | Nothing. Canvas `visibility: hidden`. **No `requestAnimationFrame` scheduled.** |
| **A — `warming`** | `job.started` | A frosted glass pane in the shape of the coming image, filled with a slow noise gradient; a flock of ~3,000 boids swirling inside it, spilling slightly past its edge. |
| **B — `preview`** | First `PREV` binary frame (step 1) | The actual blurry diffusion image inside the pane, refracted by an organic curl-noise wave; the flock now drifts along the image's luminance contours. As progress goes 0 → 1 the distortion and frost decay to zero and the flock thins, disperses outward and fades. |
| **C — `reveal`** | `job.completed` (final image decoded) | 300 ms ease-out cross-dissolve from the last preview to the crisp final image, distortion already ≈ 0. Then → `idle`. |

Jobs without previews (remove background, 3D stages other than `source`) stay in Phase A until completion, then run a 300 ms fade-out instead of a reveal.

### 7.2 Coordinate system

Stage space: origin at the canvas centre, `y` up, the canvas height spans `[-1, 1]`, width spans `[-uAspect, uAspect]`. The **pane** (image rect) is `uPane = (cx, cy, halfW, halfH)` in stage space. All simulation lengths are in stage units, so behaviour is resolution-independent.

### 7.3 GPU resources (allocated once in `init`, reused forever)

| Resource | Format / size | Purpose |
|---|---|---|
| `stateA`, `stateB` | `ARRAY_BUFFER`, `Float32`, `N × 4` (`pos.xy`, `vel.xy`), `DYNAMIC_COPY` | Boid state, ping-ponged by transform feedback |
| `seedBuf` | `ARRAY_BUFFER`, `Float32`, `N × 1`, `STATIC_DRAW` | Per-boid random in [0,1) |
| `vaoUpdate[2]`, `vaoDraw[2]`, `tf[2]` | — | One VAO + transform feedback object per ping-pong direction |
| `fieldTex` + `fieldFbo` | `RGBA16F`, 64 × 64, full mip chain, `LINEAR_MIPMAP_LINEAR` | Flock field: `xy = Σ vel·w`, `z = Σ w` (density) |
| `prevTex[2]` | `RGBA8`, mipmapped, sized to the preview (re-allocated only when preview dimensions change) | Previous and current diffusion preview, cross-faded |
| `finalTex` | `RGBA8`, final image size (max 2048²), no mips | Phase C target; deleted on entering `idle` |
| `clipTex` | `R8`, ≤ 512 px | Optional inpaint mask (Edit) |
| `quadVao` | — | Fullscreen triangle |
| Programs | `update`, `field`, `composite`, `particles` | Four programs, uniform locations cached at link time |

`N` (boid count) = 3000 by default; quality ladder in §7.7. Requires `EXT_color_buffer_float` (or `EXT_color_buffer_half_float`) for the field target. If neither exists, the field pass is skipped and `uFlock.xyz` are forced to 0 — boids then follow only swirl, luminance drift and containment, which still reads as a flock.

### 7.4 Frame pipeline

Per animation frame, in order. `dt = min(now − last, 33.3 ms)`.

1. **FIELD** — bind `fieldFbo`, viewport 64², clear to 0, blend `ONE, ONE`, draw `N` points from the current state with the `field` program. Then `generateMipmap(fieldTex)`.
2. **UPDATE** — `RASTERIZER_DISCARD` on; `update` program; bind `vaoUpdate[i]`, transform feedback into the other state buffer; `drawArrays(POINTS, 0, N)`; swap `i`.
3. **COMPOSITE** — default framebuffer, canvas viewport, blending off, clear to transparent, draw the fullscreen triangle with the `composite` program (pane background or distorted preview, premultiplied alpha).
4. **PARTICLES** — blend `ONE, ONE_MINUS_SRC_ALPHA`, draw `N` points with the `particles` program.

Context attributes: `{ alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "high-performance", preserveDrawingBuffer: false, desynchronized: true }`.

#### 7.4.1 Uniforms

| Uniform | Type | Programs | Source |
|---|---|---|---|
| `uTime` | float (s) | update, composite | Accumulated `dt` since `begin()` |
| `uDt` | float (s) | update | Clamped frame delta |
| `uAspect` | float | all | canvas width / height |
| `uPane` | vec4 | update, composite, particles | Stage-space image rect |
| `uCorner` | float | composite | Pane corner radius in stage units (14 px equivalent) |
| `uField` | sampler2D | update, composite | `fieldTex` |
| `uPrevA`, `uPrevB` | sampler2D | composite; `uPrevB` also update + particles | Previous / current preview |
| `uPreviewMix` | float 0–1 | composite | 180 ms linear cross-fade started at each `pushPreview` |
| `uFinal` | sampler2D | composite | Final image |
| `uClipMask`, `uUseClip` | sampler2D, float | composite | Inpaint mask clip |
| `uPhaseB` | float 0–1 | update, composite, particles | 0 in Phase A; eases to 1 over 400 ms when the first preview lands |
| `uProgress` | float 0–1 | composite | Smoothed progress (see below) |
| `uDistort` | float | composite | `0.028 · (1 − uProgress)^1.6 · (1 − uReveal)` (UV units) |
| `uFrost` | float | composite | Preview mip LOD bias: `3.0 · (1 − smoothstep(0, 0.9, uProgress))` |
| `uReveal` | float 0–1 | composite, particles | Phase C clock, `easeOutCubic(t / 300 ms)` |
| `uDisperse` | float 0–1 | update, particles | `smoothstep(0.55, 1.0, uProgress)`; forced to 1 during reveal and cancel fade |
| `uFade` | float 0–1 | composite, particles | Global alpha: fade-in 300 ms at `begin`, fade-out 200 ms on cancel |
| `uFlock` | vec4 | update | `(cohesion, alignment, separation, swirl)` — defaults `(0.9, 1.4, 1.8, 0.35)` |
| `uSpeed` | vec3 | update | `(minSpeed, maxSpeed, maxAccel)` — defaults `(0.06, 0.24, 1.6)` stage units/s |
| `uLumaDrift` | float | update | Default `0.7` |
| `uPointSize` | float (px) | particles | `2.6 · dpr` |
| `uInk`, `uInkAlpha` | vec3, float | particles | From `--murmur-ink`, `--murmur-ink-alpha` |
| `uPaneA`, `uPaneB`, `uGlow` | vec3 | composite | From `--murmur-pane-a/b`, `--murmur-glow` |

All vector uniforms are written from module-level preallocated `Float32Array`s. Theme colours are read from CSS once per `begin()` and on theme change, never per frame.

**Progress smoothing.** Diffusion reports discrete steps (9 of them for Z-Image). The target is `step / totalSteps` from the latest `PREV` header; `uProgress` follows it with `p += (target − p) · (1 − exp(−6 · dt))`, so decay is continuous rather than stepped. `uProgress` never decreases within a job.

#### 7.4.2 `update` vertex shader (transform feedback) — reference implementation

```glsl
#version 300 es
precision highp float;
precision highp sampler2D;

layout(location = 0) in vec2  aPos;    // stage space
layout(location = 1) in vec2  aVel;    // stage units / s
layout(location = 2) in float aSeed;   // [0,1), static

uniform sampler2D uField;     // xy = Σ vel·w, z = Σ w
uniform sampler2D uPrevB;     // current preview (mipmapped)
uniform float uTime, uDt, uAspect;
uniform vec4  uPane;          // cx, cy, halfW, halfH
uniform vec4  uFlock;         // cohesion, alignment, separation, swirl
uniform vec3  uSpeed;         // min, max, maxAccel
uniform float uPhaseB, uDisperse, uLumaDrift;

out vec2 vPos;
out vec2 vVel;

float snoise(vec3 v);         // vendored 3D simplex noise (§7.9)

vec2 stageToUv(vec2 p) { return p / vec2(uAspect, 1.0) * 0.5 + 0.5; }
vec2 paneToUv(vec2 p)  { return (p - uPane.xy) / uPane.zw * 0.5 + 0.5; }

vec2 densityGrad(vec2 uv, float lod) {
  float e = exp2(lod) / 64.0;                       // one texel at this LOD
  float dx = textureLod(uField, uv + vec2(e, 0.0), lod).z - textureLod(uField, uv - vec2(e, 0.0), lod).z;
  float dy = textureLod(uField, uv + vec2(0.0, e), lod).z - textureLod(uField, uv - vec2(0.0, e), lod).z;
  return vec2(dx / uAspect, dy);                    // uv gradient -> stage-space direction
}

float luma(vec2 uv) {
  return dot(textureLod(uPrevB, clamp(uv, 0.0, 1.0), 4.0).rgb, vec3(0.2126, 0.7152, 0.0722));
}

vec2 curl(vec2 p, float t) {                        // divergence-free 2D flow from a scalar potential
  const float e = 0.01;
  float n  = snoise(vec3(p, t));
  float nx = snoise(vec3(p + vec2(e, 0.0), t));
  float ny = snoise(vec3(p + vec2(0.0, e), t));
  return vec2(ny - n, -(nx - n)) / e;
}

void main() {
  vec2 uv = stageToUv(aPos);

  // Separation: move down the fine density gradient, only where it is crowded.
  float crowd = textureLod(uField, uv, 0.0).z;
  vec2 sep = -densityGrad(uv, 0.0) * smoothstep(1.5, 4.0, crowd);

  // Alignment: steer toward the neighbourhood's mean velocity.
  vec3 m = textureLod(uField, uv, 1.5).xyz;
  vec2 ali = (m.xy / max(m.z, 1e-3) - aVel) * step(1e-3, m.z);

  // Cohesion: move up the coarse density gradient (toward the flock's mass).
  vec2 coh = densityGrad(uv, 3.0);
  coh /= max(length(coh), 1e-4);

  // Swirl: slow curl noise, phase-shifted per boid so the flock shears and folds.
  vec2 swirl = curl(aPos * 0.9 + aSeed * 0.35, uTime * 0.07);

  // Phase B: stream along iso-luminance contours of the preview; half the flock each way.
  vec2 puv = paneToUv(aPos);
  const float le = 0.03;
  vec2 g = vec2(luma(puv + vec2(le, 0.0)) - luma(puv - vec2(le, 0.0)),
                luma(puv + vec2(0.0, le)) - luma(puv - vec2(0.0, le)));
  vec2 drift = vec2(-g.y, g.x) * (aSeed < 0.5 ? 1.0 : -1.0) * 14.0 + g * 3.0;

  // Containment: soft elliptical well around the pane; released and reversed while dispersing.
  vec2 q = (aPos - uPane.xy) / (uPane.zw * 1.08);
  float r = length(q);
  vec2 home = -q * smoothstep(0.85, 1.25, r) * 2.2;
  vec2 flee = normalize(q + 1e-4) * uDisperse * 1.4;

  vec2 acc = coh   * uFlock.x * (1.0 - uDisperse)
           + ali   * uFlock.y
           + sep   * uFlock.z
           + swirl * uFlock.w
           + drift * uLumaDrift * uPhaseB * (1.0 - uDisperse)
           + home  * (1.0 - uDisperse)
           + flee;

  float a = length(acc);
  if (a > uSpeed.z) acc *= uSpeed.z / a;

  vec2 v = aVel + acc * uDt;
  float s = length(v);
  v = v / max(s, 1e-5) * clamp(s, uSpeed.x, uSpeed.y * (1.0 + uDisperse));

  vPos = aPos + v * uDt;
  vVel = v;
}
```

Fragment shader for this program is an empty `void main() {}`. Varyings captured: `["vPos", "vVel"]`, `INTERLEAVED_ATTRIBS`.

#### 7.4.3 `field` program

```glsl
// vertex
layout(location = 0) in vec2 aPos; layout(location = 1) in vec2 aVel;
uniform float uAspect; out vec2 vMom;
void main() { vMom = aVel; gl_Position = vec4(aPos / vec2(uAspect, 1.0), 0.0, 1.0); gl_PointSize = 3.0; }

// fragment
precision highp float; in vec2 vMom; out vec4 o;
void main() {
  float w = smoothstep(1.0, 0.0, length(gl_PointCoord * 2.0 - 1.0));
  o = vec4(vMom * w, w, 1.0);
}
```

#### 7.4.4 `composite` fragment shader — behaviour

For each fragment with stage position `p` and pane UV `puv`:

1. **Pane mask** — rounded-rect signed distance from `uPane` and `uCorner`; `inside = smoothstep(1.5 px, 0, sdf)`. Outside the pane the output is fully transparent (the DOM stage shows through).
2. **Phase A glass** — `n = 0.5 + 0.5 · snoise(vec3(p · 0.6, uTime · 0.03))`; `glass = mix(uPaneA, uPaneB, n)`; add a flock halo `uGlow · 0.06 · smoothstep(0, 6, textureLod(uField, stageUv, 2.0).z)` so the glass brightens faintly where the birds gather.
3. **Distortion flow** — two octaves of the same `curl()`:
   `flow = curl(p · 1.7, uTime · 0.12) + 0.5 · curl(p · 4.3 + 7.1, uTime · 0.20)`; `d = flow · uDistort`.
4. **Frosted, refracted preview** — three chroma-split taps per texture, blurred by mip LOD:
   `c(tex) = vec3(textureLod(tex, puv + d, uFrost).r, textureLod(tex, puv + d · 0.92, uFrost).g, textureLod(tex, puv + d · 0.84, uFrost).b)`;
   `preview = mix(c(uPrevA), c(uPrevB), uPreviewMix)`.
5. **Phase blend** — `col = mix(glass, preview, uPhaseB)`; then `col = mix(col, texture(uFinal, puv).rgb, uReveal)`.
6. **Inpaint clip** (when `uUseClip` = 1) — multiply alpha by `texture(uClipMask, puv).r` so only the masked region is covered.
7. **Grain** — add `(hash(gl_FragCoord.xy + uTime) − 0.5) · (2.0 / 255.0)` to kill banding in the gradients.
8. Output `vec4(col, 1.0) · inside · uFade` (premultiplied).

Budget: at most three simplex evaluations for the flow plus one for the glass, and at most six preview taps, per fragment.

#### 7.4.5 `particles` program — behaviour

- Vertex: `gl_Position` from `aPos`; `gl_PointSize = uPointSize · (0.75 + 0.5 · fract(aSeed · 91.7))`; pass the unit velocity direction and a per-boid alpha `a = (0.55 + 0.45 · fract(aSeed · 17.3)) · (1 − uDisperse)^1.5 · (1 − uReveal) · uFade`. In Phase B, sample `uPrevB` luminance at the boid (LOD 4) and pass `contrast = smoothstep(0.35, 0.65, luma)`.
- Fragment: rotate `gl_PointCoord` into the velocity frame and shape an elongated soft dash: `q = R(dir) · (pc · 2 − 1)`; `d = length(q · vec2(1.0, 2.6))`; `shape = smoothstep(1.0, 0.25, d)`. Colour: in Phase A `uInk`; in Phase B `mix(lightInk, darkInk, contrast)` so birds stay visible over both dark and bright regions of the preview (`lightInk = vec3(0.96)`, `darkInk = vec3(0.07)`), blended by `uPhaseB`. Output premultiplied `vec4(colour, 1) · shape · a · uInkAlpha`.

### 7.5 Lifecycle and the zero-idle guarantee

```ts
// app/src/murmuration/index.ts
export interface Murmuration {
  /** Phase A. Seeds the flock deterministically from `seed`, starts the frame loop. */
  begin(opts: { aspect: number; seed: number; clipMask?: ImageBitmap }): void;
  /** Phase B. Uploads a decoded preview; first call triggers the A→B transition. */
  pushPreview(frame: ImageBitmap, step: number, totalSteps: number): void;
  /** Phase C. 300 ms reveal into `final`; resolves when the loop has stopped. */
  complete(final: ImageBitmap): Promise<void>;
  /** Phase A-only jobs: 300 ms fade-out; resolves when the loop has stopped. */
  finish(): Promise<void>;
  /** Cancel / error: 200 ms fade-out, then idle. */
  cancel(): Promise<void>;
  /** Stage or pane geometry changed (ResizeObserver). */
  layout(stage: DOMRectReadOnly, pane: DOMRectReadOnly): void;
  readonly phase: "idle" | "warming" | "preview" | "reveal";
  dispose(): void;
}
export function createMurmuration(canvas: HTMLCanvasElement): Murmuration; // picks WebGL2 or Canvas2D
```

Rules — these are requirements, not suggestions:

1. **Exactly one `requestAnimationFrame` handle exists while phase ≠ `idle`, and none exists while phase = `idle`.** The loop function is a single module-level function (no closure created per frame). Entering `idle` calls `cancelAnimationFrame`, sets the handle to 0, and sets the canvas to `visibility: hidden`. There are no `setInterval`/`setTimeout` timers in the module; all transitions are clocked inside the frame loop.
2. **Reveal hand-off without a flash.** Before `complete()` is called, the caller has already placed the decoded final image in the `<img>` underneath the canvas (opacity 1, same rect). The shader dissolves to the same pixels over 300 ms (`--dur-reveal`, `easeOutCubic`). On the frame where `uReveal` reaches 1 the canvas is hidden; what remains on screen is the plain `<img>`. After that frame the GPU does no work for the stage.
3. **Stop when unseen.** On `document.visibilitychange → hidden` (minimized or fully occluded window) the loop stops and resumes on `visible` with `dt` reset. When the workspace is not the active one the loop stops as well; incoming previews are still uploaded (latest only), so switching back shows the current state.
4. **Frame cap 60 fps.** On higher-refresh displays the loop early-returns unless ≥ 15.5 ms have passed since the last rendered frame.
5. **Deterministic flock.** `begin()` fills the state buffer from a `mulberry32(seed)` generator into a preallocated `Float32Array`, then one `bufferSubData`. The same seed always produces the same opening choreography.
6. **Preview uploads.** `PREV` JPEG bytes → `createImageBitmap(blob)` (off the main thread) → `pushPreview`. The module swaps the `prevTex` roles, uploads with `texSubImage2D` (or `texImage2D` if the size changed), calls `generateMipmap`, closes the `ImageBitmap`, and restarts the 180 ms `uPreviewMix` cross-fade. If a newer frame arrives before an older one finished decoding, the older one is dropped.
7. **Context loss.** On `webglcontextlost`: `preventDefault`, stop the loop. On `webglcontextrestored`: rebuild resources; if a job is active, resume in its current phase with the latest preview.

### 7.6 Engine cadence this design assumes

One `PREV` frame per sampler step, long edge ≤ 768 px, JPEG quality 80 (contract §4.3). Z-Image previews come from TAEF1 (sharp-ish from step 2); Qwen-Image 2.1 previews are a 64-channel Latent2RGB projection upscaled to 512 px (blocky) — `uFrost` deliberately starts at LOD 3 to hide that blockiness early. No special-casing per model in the shader.

### 7.7 Mandatory GPU caps and quality ladder

| Cap | Value |
|---|---|
| Device pixel ratio | `min(window.devicePixelRatio, 1.5)` |
| Backing store | ≤ 2.5 megapixels; if `cssW · cssH · dpr²` exceeds it, lower `dpr` until it fits |
| Frame rate | ≤ 60 fps; 30 fps while the window is unfocused |
| Boids | 3000 default; never above 4500 |
| Field texture | 64 × 64 `RGBA16F`, fixed |
| Per-frame JS heap allocations | **Zero.** No object/array/closure creation, no string building, no `getUniformLocation`, no `getBoundingClientRect` inside the loop. Verified with the allocation timeline: 10 s of Phase B shows no sawtooth attributable to the module. |
| Texture/buffer churn | None per frame. Previews reuse two textures; state reuses two buffers. |

Adaptive ladder (evaluated on a 30-frame moving average of frame time, steps only downward within one job): above 12 ms → `dpr = 1.0`; still above 12 ms → `N = 1500`; still above → disable chroma split (one tap per texture). The chosen rung is remembered for the session.

### 7.8 Fallbacks

**Canvas2D** (WebGL2 unavailable or context creation fails) — same `Murmuration` interface:
- 600 particles in one preallocated `Float32Array` (`x, y, vx, vy` × 600), advected by a JS 2D simplex curl field plus the elliptical containment; no neighbour forces. Drawn as 1.5 × 4 px rotated rects via a single `beginPath`/`fill` per frame with `globalAlpha`.
- Pane: a two-stop gradient fill. Preview: `drawImage` with `ctx.filter = blur(Npx)` where `N = 14 · (1 − progress)`; previous → current cross-fade with `globalAlpha`. No refraction.
- Reveal: 300 ms `globalAlpha` cross-fade to the final image, then stop the loop exactly as in §7.5.
- 30 fps cap, `dpr` capped at 1.0.

**Reduced motion** (`prefers-reduced-motion: reduce`): no particles and no distortion. Phase A is the static pane with a 2 s opacity pulse done in CSS; Phase B shows each preview with a 180 ms cross-fade and the blur decay only; Phase C is the same 300 ms dissolve.

### 7.9 Files

```
app/src/murmuration/
  index.ts            createMurmuration(), feature detection, shared interface
  webgl.ts            resources, frame loop, phase machine
  canvas2d.ts         fallback
  config.ts           every tunable constant in this section, in one place
  glsl/update.vert  field.vert  field.frag  composite.frag  particles.vert  particles.frag
  glsl/snoise3.glsl   Ashima Arts / Ian McEwan 3D simplex noise (MIT) — keep the licence header
```

Constants in §7.4 are tuned starting values; they live in `config.ts` and may be adjusted during visual QA without a spec change. The phase behaviour, caps and zero-idle rules may not.

---

## 8. States and copy

### 8.1 Engine states

`window.studio.engine` reports the process state; `GET /api/health` and the WebSocket confirm readiness.

| State | Memory pill | Primary buttons | Other |
|---|---|---|---|
| `starting` | `--warn` dot + `Starting…` | Disabled, tooltip `Engine is starting` | Everything else usable (Library, canvas painting, 3D viewing) |
| `ready` | Numbers | Enabled | — |
| `busy` (job active) | Numbers | The owning workspace shows Stop; the other workspaces' primary buttons are disabled with tooltip `Busy — one thing at a time` | Titlebar indicator runs |
| `crashed` / `stopped` | `--danger` dot + `Engine stopped` | Disabled | Error whisper `The engine stopped.` with action `Restart` → `window.studio.engine.restart()` |

Only one job runs at a time (contract: `409 BUSY`). There is no queue and no queue UI.

### 8.2 Empty-state lines

| Place | Serif `display` | Sans muted |
|---|---|---|
| Generate | Describe an image, *then let it gather.* | Ctrl+Enter to generate |
| Edit | Drop an image *to begin.* | or paste, or press Ctrl+O |
| 3D | Give it a subject, *get it in the round.* | Text or a single image |
| Library | Nothing here yet. | What you make appears in this room. |
| Library search | No match. | Try fewer words |

### 8.3 Errors

Errors are whispers (6 s, one action at most), mapped from contract error codes:

| Code | Whisper | Action |
|---|---|---|
| `OUT_OF_MEMORY` | Not enough memory for that. | `Free memory` → opens the drawer |
| `MODEL_FILES_MISSING` | A model file is missing. | `Show` → opens the drawer, expands the family |
| `BUSY` | Still working on the last one. | — |
| `IMAGE_DECODE_FAILED` | That file isn't an image Studio can read. | — |
| `INVALID_DIMENSIONS` | (prevented by snapping; if seen) That size isn't supported. | — |
| `ENGINE_UNREACHABLE` (client-side) | Can't reach the engine. | `Restart` |
| `BLENDER_UNREACHABLE` | Blender isn't running. | `Open Blender` |
| `INTERNAL` / other | Something went wrong. | `Details` → copies the error JSON to the clipboard |

A cancelled job shows no whisper: the murmuration fades (200 ms) and the stage returns to its previous content.

---

## 9. Keyboard map

Shortcuts are ignored while a text field is focused unless they use `Ctrl`.

| Scope | Keys | Action |
|---|---|---|
| Global | `Ctrl+1` / `2` / `3` / `4` | Generate / Edit / 3D / Library |
| | `Ctrl+\` | Collapse or expand sidebar |
| | `Ctrl+M` | Models & Memory drawer |
| | `Ctrl+Shift+L` | Toggle Zen Light / Zen Dark |
| | `Ctrl+Enter` | Run the workspace's primary action |
| | `Esc` | Stop the running job (when no popover/drawer/inspect mode is open); otherwise close the topmost layer |
| | `Ctrl+E` | Enhance prompt in place (when Inkling is available) |
| | `Ctrl+L` | Focus the prompt / instruction field |
| Generate | `Ctrl+Shift+N` | Toggle negative prompt |
| | `Ctrl+S` / `Ctrl+C` / `Del` | Save copy / copy image / delete (stage image) |
| | `E` / `3` | Edit in canvas / Make 3D |
| | `←` `→` | Previous / next in batch or filmstrip |
| Edit | `V`, `Space` (hold), `B`, `M`, `E` | Select-Pan, temporary pan, Paintbrush, Mask brush, Eraser |
| | `[` `]` | Brush size − / + |
| | `Alt` (hold) | Eyedropper (Paintbrush); flip erase target (Eraser) |
| | `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` | Undo / redo / redo |
| | `Ctrl+I` / `Ctrl+Shift+X` / `H` | Invert mask / clear mask / toggle mask visibility |
| | `Ctrl+0` / `Ctrl+Alt+0` / `Ctrl+=` / `Ctrl+-` | Fit / 100 % / zoom in / zoom out |
| | `\` | Before / After |
| | `Ctrl+Shift+B` | Remove background |
| | `Ctrl+O` / `Ctrl+V` | Open / paste image |
| 3D | `1` `2` `3` `4` `0` | Front / Side / Top / Iso / Reset |
| | `L` `C` `W` `N` | Lit PBR / Clay / Wireframe / Normals |
| | `R` | Auto-rotate |
| | `Ctrl+B` | Send to Blender |
| Library | `Ctrl+F` | Search |
| | `Del` | Delete focused or selected |
| | `F` | Toggle favorite |
| | `Ctrl+A` / `Esc` | Select all / leave select mode |
| | `Enter` / `←` `→` | Open inspector / previous-next item |

`Ctrl+1`–`4` always switch workspace, in every scope; no workspace rebinds them.

---

## 10. Accessibility and performance

### 10.1 Accessibility

- Every `IconButton` has an `aria-label` equal to its tooltip text without the shortcut. Toggle buttons expose `aria-pressed`; segmented controls are `role="radiogroup"`.
- Full keyboard reachability in DOM order: sidebar → workspace content → capsule. Popovers and drawers trap focus and restore it.
- The stage image has `alt` = the prompt (truncated to 200 characters). Canvases (Murmuration, editor, 3D) are `aria-hidden` with adjacent visually-hidden live text: `Generating, step 4 of 9`, updated at most once per second (`aria-live="polite"`).
- Text contrast per §2.1.1. Colour is never the only carrier of state: state dots are paired with a word or a shape change (hollow ring vs filled dot).
- Windows High Contrast (`forced-colors: active`): glass and shadows are dropped; borders use `CanvasText`; the accent maps to `Highlight`.
- Minimum window 1080 × 700: at this size the sidebar auto-collapses to the rail and the capsule narrows to its 560 px minimum.

### 10.2 Performance budgets

| Budget | Target |
|---|---|
| Idle GPU utilization (nothing generating, mouse still) | 0 % attributable to Studio: no rAF loops, no CSS animations running, no auto-rotate unless the user enabled it |
| Idle CPU | < 1 % (telemetry arrives every 2 s over WebSocket; nothing polls from the renderer) |
| Cold start to interactive UI | < 1.5 s (the engine keeps starting in the background) |
| Workspace switch | < 50 ms (workspaces stay mounted) |
| Murmuration frame | ≤ 6 ms CPU+GPU at 2.5 MP on the Radeon 8060S |
| Editor stroke latency | ≤ 1 frame from pointer event to pixels |
| Library scroll | 60 fps with 5,000 items (virtualized, decoded thumbs only) |
| Preview frame handling | Decode off-thread; drop stale frames; never more than 2 preview textures alive |

Continuous CSS animations (pulsing dots, shimmer) run only while a job is active, and use `opacity`/`transform` only.

---

## 11. Frontend architecture

### 11.1 Structure

```
app/
  electron/            main.ts, preload.ts, ipc/*          (Rust+Electron team)
  src/
    main.tsx  App.tsx
    shared/contract.ts            verbatim types from API_CONTRACT.md §8 — single source for src/ and electron/
    shared/families.ts            static family table (contract Appendix A)
    styles/tokens.css  index.css
    lib/engine/http.ts            typed fetch client for 127.0.0.1:48210
    lib/engine/socket.ts          WebSocket client, PREV frame parser, reconnect
    lib/format.ts                 bytes, durations, counts (mono formatting)
    stores/                       Zustand stores (below)
    components/ui/                §4 primitives
    components/chrome/            Titlebar, Sidebar, MemoryPill, Whisper, ModelsDrawer
    components/capsule/           PromptCapsule and its pills/popovers (shared by all three creative workspaces)
    murmuration/                  §7
    workspaces/generate/  edit/  three/  library/
```

### 11.2 Stores

| Store | Holds | Notes |
|---|---|---|
| `useUiStore` | workspace, sidebarCollapsed, theme, drawer/inspector open, whisper | Persisted via `window.studio.settings` |
| `useEngineStore` | process status, health, model family statuses, latest telemetry, socket state | Written only by `lib/engine/socket.ts` and the `engine` IPC listener |
| `useJobStore` | active job: `jobId`, `owner` workspace, `stages`, `stageIndex`, `phase`, `step`, `totalSteps`, `progress`, `batchIndex`, `enhancedPrompt` | Single active job. **Preview bitmaps do not go through React state** — the socket hands them straight to the active `Murmuration` instance. |
| `useGenerateStore` | prompt, negative, model, width, height, seed, seedLocked, steps, cfg, sampler, scheduler, batch, enhance toggle, current stage item | Persisted |
| `useEditStore` | mode, instruction, denoise, tool, brush settings, references, document meta | Pixel data lives in a non-reactive `EditorDocument` class instance |
| `useThreeStore` | mode, engine, prompt, source image, quality, viewport settings, current asset, milestone states | Three.js objects live outside the store |
| `useLibraryStore` | items (`OutputItem[]`), filter, query, favoritesOnly, selection, inspected id | Refreshed from `window.studio.library.scan()` at start and on `library-changed`; new outputs from `job.completed` are prepended immediately |

### 11.3 Data flow of one generation

1. Capsule → `POST /api/generate/t2i` → `202 { jobId }`. Store marks `owner: "generate"`.
2. WS `job.started` → `Murmuration.begin({ aspect, seed })`; seed pill shows the actual seed.
3. WS `job.progress` → titlebar indicator, progress ring.
4. WS binary `PREV` → parse 16-byte header → `createImageBitmap` → `Murmuration.pushPreview`.
5. WS `job.completed` → decode the final PNG (`studio://outputs/…`) → set `<img>` → `Murmuration.complete(bitmap)` → prepend outputs to the Library store and filmstrip.
6. WS `job.error` / `job.cancelled` → `Murmuration.cancel()`; whisper per §8.3.

---

## 12. Acceptance checklist

- [ ] Both themes are produced solely by the tokens in §2.1; no hex literals in components.
- [ ] Only the three bundled font families render; no network font requests.
- [ ] Caption buttons are native (Snap Layouts flyout appears on maximize hover) and their glyph colour follows the theme.
- [ ] Mica is visible behind the sidebar on Windows 11; the opaque fallback is correct when transparency effects are off.
- [ ] Sidebar collapses to a 56 px icon rail with tooltips; state persists.
- [ ] Generate: `Ctrl+Enter` runs; Phase A appears within one frame of `job.started`; the first blurry preview appears on step 1; reveal lasts 300 ms; afterwards the Performance panel shows no animation frames firing.
- [ ] With the app idle and visible, Task Manager shows 0 % GPU for Studio.
- [ ] A 10 s heap allocation timeline during Phase B shows no allocations from `murmuration/`.
- [ ] `devicePixelRatio` 2.0 display: the Murmuration backing store uses 1.5.
- [ ] Forcing WebGL2 off yields the Canvas2D fallback with the same lifecycle.
- [ ] Edit: brush, mask, eraser, undo/redo, invert/clear/hide mask, before/after, 4-slot references, three modes, and one-click Remove background producing a transparent canvas.
- [ ] 3D: seven milestones fill in as `job.stage_preview` events arrive; viewport shading, lighting, camera presets, exposure, auto-rotate, HUD, export menu and Send to Blender all work; the viewport renders on demand only.
- [ ] Library: filters, search, favorites, select + two-step bulk delete, `Delete` key, inspector actions; deleted files are found in the Windows Recycle Bin.
- [ ] Models & Memory: exact disk sizes, safetensors facts, state badges, Warm up / Unload, Unload all (two-step), Auto-unload selector, live bars.
- [ ] The Enhance icon exists only while Inkling at `:8080` is reachable. There is no chat surface anywhere.
- [ ] No modal dialogs exist in the app (native file pickers excepted).
