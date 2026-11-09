# Windows Chrome release QA checklist

Use this checklist on the presentation PC after the current source has been
copied or cloned there. The Codex environment cannot start Chromium because
system libraries are missing. This checklist does not authorize a wallet
connection, signing, mainnet access, or contract deployment.

## Start the app

In WSL Ubuntu, from the repository root, start the API in one terminal:

```sh
NEAR_NETWORK=localnet npm run dev:api
```

Start the dashboard in another terminal:

```sh
npm run dev:dashboard
```

Open `http://localhost:3000` in current stable Windows Chrome. WSL localhost
forwarding should expose the dashboard. If RPC contract IDs are not configured,
the dashboard may show telemetry as unavailable; leave that state visible and
do not imply it is Sandbox evidence. Use the dashboard's local demo control to
show the unified event stream. The terminal-only `npm run demo:local` validates
the backend gate but does not launch a browser.

## Desktop checks

- [ ] At 1440×900 and 1280×720, Overview, sidebar, header and main content fit
  without clipped text or horizontal scrolling.
- [ ] Open every route from the navigation: Overview, Recovery Network,
  GUARDIAN/Security, REWIND/Escrow, SENTINEL, Blockchain Explorer, Analytics,
  Token Economics, Methodology & Data, Developers and About. Each route shows
  its own page content and the expected active navigation state.
- [ ] Overview phoenix background is clear; other pages use the prepared silver
  orbital treatment. Images load without broken-image icons.
- [ ] Theme switcher works for Dark, Light and System. Refresh and confirm the
  selected preference remains applied without a visible theme flash.
- [ ] Hover effects remain subtle. Keyboard Tab reaches every control; focus is
  visible; Enter/Space activates buttons; Escape closes menus/dialogs.
- [ ] Browser console has no uncaught exceptions, hydration warnings or failed
  local asset requests.
- [ ] The recovery timeline shows only events from the just-started local demo.
  Pending, failed and unavailable states remain distinguishable; no payment or
  proof is shown as successful without corresponding scenario evidence.

## Responsive and motion checks

Use Chrome DevTools device emulation at 1024×768, 768×1024, 390×844 and
360×800.

- [ ] Navigation collapses into usable mobile controls; no horizontal page
  scrolling, overlapping cards, clipped tables or tiny tap targets.
- [ ] No custom cursor or magnetic movement appears in touch emulation.
- [ ] In Windows **Settings → Accessibility → Visual effects → Animation
  effects Off**, reload and navigate. Motion is reduced or removed and all
  content remains available.
- [ ] At 200% browser zoom, content remains readable and interactive.

## Security boundary

- [ ] Leave wallet disconnected. Confirm wallet actions show disabled/setup
  state with the documented default backend configuration.
- [ ] Do not connect a wallet, approve a prompt, sign a transaction, visit
  mainnet, deploy a contract, or use real funds during this UI QA.
- [ ] Keep the Sandbox label visible when showing the local event demo. Describe
  the receipt as signed and backend-validated against scenario evidence, not as
  an independently verified NEAR transaction proof.

## Capture and report

- [ ] Record the actual running app without cuts during the two-minute script in
  [demo-script.md](demo-script.md). Show the Sandbox event stream and fresh JSON
  evidence path.
- [ ] Save desktop/mobile screenshots and the unedited recording outside the
  source tree, then review them for private data before posting.
- [ ] If any item fails, record the route, viewport, browser version, screenshot
  and console message. Do not hide the failure in the public demo.
