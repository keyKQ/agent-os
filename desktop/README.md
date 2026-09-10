# AgentOS Desktop

macOS desktop shell for AgentOS, built with Electron + React + TypeScript.
**macOS is the only supported platform**: the window chrome (`hiddenInset`
title bar, traffic-light inset), menu bar, quit semantics and CLI lookup paths
all assume Darwin, and `package.json` declares `"os": ["darwin"]`.
It is a thin client: the app locates the installed `agentos` CLI, supervises
`agentos gateway run`, and renders its own desktop UI on top of the gateway's
WebSocket/REST API.

## Shares logic with the web console, never UI

The renderer imports the console's non-visual layer straight from
`frontend/src` through the `@/` alias — the WebSocket RPC client, the chat
hooks (`useTranscript`, `useAttachments`, `useSlashCommands`, `useRoutePin`,
`usePendingQueue`), the approvals monitor, the imperative transcript
renderer, and the session/chat pure logic. One protocol implementation, one
place to fix a gateway change.

What it does **not** take is the console's appearance. `frontend`'s
stylesheets are never imported here; `views/chat/chat.css` restyles the
shared transcript class names (`.msg`, `.chat-tools-collapse`,
`.msg-artifact-*`, …) in the desktop's own vocabulary, and the composer is a
desktop component that merely matches the console's prop contract so the
shared hooks can drive it. Desktop code lives under the `~/` alias; `@/` is
always the console.

## Layout

```
desktop/
├── electron.vite.config.ts   # main / preload / renderer targets + the @ and ~ aliases
├── vitest.config.ts          # unit tests (jsdom by default, node per-file)
├── electron-builder.yml      # .app / .dmg packaging
├── tsconfig.node.json        # main + preload + shared
├── tsconfig.web.json         # renderer + shared + the console's sources
├── resources/                # icons and other packaging assets
└── src/
    ├── shared/               # contracts used by all three processes
    │   ├── ipc.ts            #   channel names + DesktopApi shape
    │   ├── theme.ts          #   ThemePreference / PaletteId / resolveTheme
    │   ├── settings.ts       #   DesktopSettings + normalizer
    │   └── gateway.ts        #   GatewayStatus
    ├── main/                 # Electron main process (Node)
    │   ├── index.ts          #   lifecycle, single instance, loopback Origin, quit hook
    │   ├── window.ts         #   BrowserWindow (vibrancy, hiddenInset, sandbox)
    │   ├── menu.ts           #   macOS menu bar
    │   ├── ipc/              #   one file per IPC domain, registered in index.ts
    │   ├── settings/store.ts #   atomic JSON settings in userData/
    │   └── gateway/          #   cli-locator + process supervisor (spawn, adopt, health)
    ├── preload/index.ts      # contextBridge -> window.agentos (typed DesktopApi)
    └── renderer/             # React app (browser, no Node access)
        ├── index.html        #   CSP locked to self + loopback
        └── src/
            ├── app/          #   App, AppShell, GatewayProviders (rpc + approvals), router
            ├── views/chat/   #   ChatView + chat.css — the desktop skin for the
            │                 #   console's transcript DOM
            ├── views/jobs/   #   Scheduled jobs panel (a layer over the window, not a
            │                 #   route): job list + blueprints, detail pane, create/edit
            │                 #   sheet with the natural schedule builder
            ├── views/projects/ # Project page (`/projects/:id`): renamable title,
            │                 #   self-saving brief, the chats filed there
            ├── views/settings/
            ├── components/   #   Sidebar (+ resizer, project folders, session list),
            │                 #   Toolbar, Menu, composer/
            ├── theme/        #   theme system (see below)
            ├── stores/       #   zustand: gateway, sessions, projects, live, settings, ui
            ├── lib/          #   desktop-api bridge, motion curves, relative time
            ├── i18n/         #   t() catalog for desktop-only copy
            └── assets/fonts/ #   Bricolage Grotesque (wordmark) + JetBrains Mono
```

## Theme system

Two axes, both persisted in settings and mirrored to macOS:

| Axis         | Values                           | Where it lives                   |
| ------------ | -------------------------------- | -------------------------------- |
| `preference` | `system` \| `light` \| `dark`    | `shared/theme.ts`                |
| `palette`    | `tactical` (brand) \| `graphite` | `renderer/src/theme/palettes.ts` |

Flow:

1. `main/ipc/theme.ts` sets `nativeTheme.themeSource` from the saved preference
   so window chrome and `prefers-color-scheme` agree with the app.
2. `renderer/src/theme/theme-store.ts` (`initTheme`) loads settings, resolves
   the mode, and paints via `apply.ts`: `data-theme`, `data-palette`,
   `color-scheme`, and every colour token as a `--<name>` custom property on
   `<html>`.
3. `theme/tokens.css` maps those custom properties into Tailwind (`bg-primary`,
   `text-muted-foreground`, …) and owns the palette-independent parts: fonts,
   radius scale, z-index, base element styles.
4. OS appearance changes reach the store through `matchMedia` and the
   `theme:changed` IPC push; they only repaint while preference is `system`.

Adding a palette: add an id to `PALETTE_IDS` in `shared/theme.ts` and a full
`PaletteDefinition` in `palettes.ts`. The type forces every token for both
modes; `palettes.test.ts` fails otherwise.

UI: `ThemeToggle` (title bar, cycles preference) and `ThemePicker` (Settings
view, mode segmented control + palette cards).

## Commands

The console's dependencies are separate; `frontend/` has its own
`npm ci`. This app only needs its own.

```sh
npm ci                      # Node >= 22
npm run dev                 # electron-vite dev with HMR
npm run check               # tsc (node + web), eslint, prettier, vitest
npm run build               # out/{main,preload,renderer}
npm run package:dir         # unpacked .app in release/
npm run package:mac         # dmg + zip (ad-hoc signed)
```

If `npm ci` did not download the Electron binary (sandboxed installs skip
postinstall), run `node node_modules/electron/install.js` once.

## Conventions

- Renderer never imports `electron` or Node modules (eslint enforces it).
  Everything crosses `window.agentos`, typed by `shared/ipc.ts`.
- `lib/desktop-api.ts` provides a localStorage-backed fallback so the renderer
  also runs in a plain browser tab and in vitest.
- Settings live in `~/Library/Application Support/AgentOS/settings.json`
  (Electron `userData`), validated by `shared/settings.ts` on every read.
- Desktop-only copy goes through `~/i18n`'s `t()`; copy that belongs to the
  shared chat surface stays in the console's catalog (`@/i18n`).
- Preload is emitted as CommonJS (`out/preload/index.cjs`) because the window
  runs sandboxed.
- The main process rewrites the `Origin` header on loopback requests: the
  gateway's WebSocket guard rejects `file://`, and the renderer is the local
  operator, the same trust the browser console gets.
- The gateway is started (or adopted, if one is already running) when the app
  launches, and stopped on quit; the chat and jobs views wait for `running`
  before they connect.
- Scheduled jobs open as a panel over whatever is on screen (the `jobsOpen`
  flag in `stores/ui.ts`, toggled from the sidebar), so checking a schedule
  never leaves the conversation. The panel reuses the console's cron model end to end (`@/views/cron/logic`:
  `seedForm`, `buildSavePayload`, the cron parser and humanizer) and the same
  `cron.*` RPCs, so a job created here reads identically in the web console.
  Only the presentation is the desktop's: health buckets, the natural-language
  schedule builder (`views/jobs/logic.ts`), native time/date pickers, and the
  session picker fed by the sidebar's session list.
- Projects are folders in the sidebar (Notes posture), not a page of their
  own: each project is a disclosure row with its chats inside, "+" opens an
  inline name row (Return creates, Escape discards), and a session dragged
  onto a folder is filed there (onto the "Sessions" header, unfiled). A
  folder's page (`views/projects/ProjectView.tsx`) has a title you click to
  rename and a brief that saves itself after a pause, on blur, on ⌘S and on
  leaving the page, with the gateway's compare-and-swap (`expectedUpdatedAt`)
  behind every write. The chat header shows a project chip whose menu moves
  the session between folders. All of it is the console's project model and
  `projects.*` / `sessions.patch` RPCs (`@/views/projects/logic`); the desktop
  owns only filing, disclosure state, and the autosave (`views/projects/logic.ts`).
