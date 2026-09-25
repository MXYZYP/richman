# deploy-manual.ps1
# Manual scp deploy (fallback when git push fails). Run: .\deploy-manual.ps1
# WARNING: do NOT run deploy.sh on server after this (git reset --hard wipes changes).
#
# Passwordless note:
#   First run setup-ssh.ps1 once (generates a key and installs it on the server; you type the
#   password only that one time). After that this script connects with the key and never asks
#   for a password again. Connection multiplexing (ControlMaster) is intentionally NOT used, to
#   avoid the "getsockname failed: Not a socket" breakage from stale control sockets.

$server = "root@101.200.189.252"
$repo   = "/root/richman-main"
Set-Location $PSScriptRoot

# Source files (incremental by feature) + all client test files.
# Note: the server runs vue-tsc over the entire client package, so any test file left out of
# this list is type-checked against a stale server copy and fails with TS2739. Hence we
# include every *.test.ts.
$files = @(
  # Release catalog: apps/client/src/releaseCatalog.ts imports it at build time, so the root
  # file must be uploaded too. Skip it and the server keeps its old copy, and the deployed
  # bundle keeps showing the previous version number and changelog in the home screen.
  "release-notes.json",
  # ---------- Client source ----------
  "apps/client/index.html",
  "apps/client/src/main.ts",
  # main.ts imports these two stylesheets directly. They are not referenced by any .vue file,
  # so nothing else would pull them in: leave one out and the server vite build dies with
  # `Could not resolve "./style.css"` / `"./ui/darkMode.css"`.
  "apps/client/src/style.css",
  "apps/client/src/ui/darkMode.css",
  "apps/client/src/env.d.ts",
  "apps/client/src/pwaInstall.ts",
  "apps/client/src/audio/bgm.ts",
  "apps/client/src/components/MapPicker.vue",
  # Map thumbnail previews (P2-8b map picker), the unified settings dialog (#13) and the
  # mobile sheet. Each is imported by a view that IS listed: leave one out and the
  # server-side vue-tsc/vite build dies with TS2307 / "Could not resolve ...".
  "apps/client/src/components/MapThumbnail.vue",
  "apps/client/src/components/SettingsDialog.vue",
  # Release notes dialog (#13 embeds it in the settings sheet, and the settings sheet is
  # rendered by LobbyView/GameView). Unlisted and the server keeps its old copy: the version
  # line would keep the previous behaviour, and the `defer` guard would silently not ship.
  "apps/client/src/components/ReleaseNotesDialog.vue",
  "apps/client/src/components/MobileSheet.vue",
  "apps/client/src/components/PlayerAssetDialog.vue",
  "apps/client/src/components/ActionPanel.vue",
  # Bargain panel (#105 / #106): the shared trade-confirmation / auction-bidding console block,
  # imported by GameView. NEW component - if left out, the server vite build fails with
  # `Could not resolve "../components/BargainPanel.vue"`.
  "apps/client/src/components/BargainPanel.vue",
  "apps/client/src/components/ChatPanel.vue",
  "apps/client/src/components/GameBoard.vue",
  # Seat rail (top-of-board actor strip, #9/#94). Imported by GameView and by
  # PlayerRail.test.ts, so a stale server copy breaks vue-tsc.
  "apps/client/src/components/PlayerRail.vue",
  # PWA install row (unified settings entry). NEW component imported by LobbyView and
  # GameView; if left out of this list the server vite build fails with
  # `Could not resolve "../components/PwaInstallRow.vue"`.
  "apps/client/src/components/PwaInstallRow.vue",
  # Per-turn clock badge (#107), imported by GameView. NEW component: without it the server build
  # dies with `Could not resolve "../components/TurnCountdown.vue"`.
  "apps/client/src/components/TurnCountdown.vue",
  # First-run guide / "how to play" modal (#109), lazily imported by App.vue. NEW component.
  "apps/client/src/components/FirstRunGuide.vue",
  "apps/client/src/views/HomeView.vue",
  "apps/client/src/views/LobbyView.vue",
  "apps/client/src/App.vue",
  "apps/client/src/components/GameSetup.vue",
  "apps/client/src/views/GameView.vue",
  "apps/client/src/game/clientGame.ts",
  "apps/client/src/game/gameSetup.ts",
  "apps/client/src/session/gamePresenter.ts",
  "apps/client/src/session/appFlow.ts",
  "apps/client/src/session/gameSession.ts",
  "apps/client/src/session/invitation.ts",
  # Animation speed (local display preference). Imported by GameView and by
  # playbackPace.test.ts, so a stale server copy breaks vue-tsc.
  "apps/client/src/session/playbackPace.ts",
  # Turn clock helper (#107): pure deadline/formatting module used by GameView and onlineSession.
  "apps/client/src/session/turnTimer.ts",
  # First-run guide flag (#109) and chat quick phrases (#109). Pure modules imported by App.vue
  # and ChatPanel.vue; a missing upload leaves the server building against a stale copy.
  "apps/client/src/session/firstRunGuide.ts",
  "apps/client/src/session/quickPhrases.ts",
  "apps/client/src/session/sessionStorage.ts",
  "apps/client/src/session/onlineSession.ts",
  "apps/client/src/session/localSession.ts",
  # Local save store (#12 win/loss stats + resume). Imported by localSession.ts and by the
  # local resume view, so a stale server copy breaks vue-tsc.
  "apps/client/src/session/localGameSave.ts",
  "apps/client/src/session/playerStats.ts",
  "apps/client/src/audio/sfx.ts",
  "apps/client/src/ui/gameTheme.css",
  "apps/client/src/ui/themeManager.ts",
  # Map thumbnail renderer: pure TS module imported by MapThumbnail.vue and MapPicker.vue.
  # Miss it and the server vite build dies with "Could not resolve ... mapThumbnail".
  "apps/client/src/ui/mapThumbnail.ts",
  # Map rule summary (#13): pure TS module that turns the active MapPack into the human
  # readable "rules at a glance" list shown in SettingsDialog. SettingsDialog.vue IS listed,
  # so leaving this out breaks the server build with TS2307 / "Could not resolve ./mapRules".
  "apps/client/src/ui/mapRules.ts",
  # Client build config. The server runs `pnpm --filter @richman/client build`, which reads
  # THIS file: leave it out and the server keeps its old copy, so manualChunks / first-screen
  # code splitting (#104) and any asset rule silently diverge from the committed source.
  "apps/client/vite.config.ts",
  # ---------- PWA (P2-11): public assets must be uploaded explicitly, otherwise the server
  # build never copies them into dist ----------
  "apps/client/public/manifest.webmanifest",
  "apps/client/public/sw.js",
  "apps/client/public/icons/icon-192.png",
  "apps/client/public/icons/icon-512.png",
  # ---------- Engine / protocol / server ----------
  "vitest.config.ts",
  "packages/engine/src/types.ts",
  "packages/engine/src/moduleRegistry.ts",
  "packages/engine/src/engine.ts",
  "packages/engine/src/bot.ts",
  # Trading + auctions (#105 / #106). Imported by engine.ts (skip_buy -> auction) and by
  # index.ts (currentPendingTrade / currentPendingAuction / AUCTION_MIN_INCREMENT), so a
  # missing upload makes the server reject or mis-read every bargain-phase intent.
  "packages/engine/src/bargain.ts",
  "packages/engine/src/index.ts",
  "packages/engine/src/hydrate.ts",
  # ---------- Engine modules (scp only uploads what is listed; a missing file leaves a stale
  # copy on the server and tsx only fails at runtime. Keep the whole engine src set uploaded.) ----------
  "packages/engine/src/effects.ts",
  "packages/engine/src/moduleToolkit.ts",
  "packages/engine/src/movement.ts",
  "packages/engine/src/payments.ts",
  "packages/engine/src/rng.ts",
  "packages/engine/src/selectors.ts",
  "packages/engine/src/simulate.ts",
  "packages/engine/src/turns.ts",
  "packages/engine/src/victory.ts",
  "packages/engine/src/worldTourModule.ts",
  # great-wall@1 (P2-8b second rule module): beacons you can claim and charge tolls on.
  # Imported by moduleRegistry.ts, so a missing upload leaves a stale copy (or none) and the
  # server dies at startup with "Unknown rule module" while building the default registry.
  "packages/engine/src/greatWallModule.ts",
  # prison@1 (roadmap #127 third rule module, enabled only by the northeast-tour map):
  # goto-jail / jail cells, jail-exit rolls, jail-free cards and the optional bail cost.
  # Same hazard as greatWallModule.ts above: moduleRegistry.ts imports it, so a stale or
  # missing copy makes the server fail while building the default registry.
  "packages/engine/src/prisonModule.ts",
  # ---------- #23 "every map needs a rule": one module for each of the eight maps that
  # used to be pure core@1 (v2.16.0) ----------
  # moduleSupport.ts is the shared helper layer these eight modules are built on
  # (moduleKeyOf / withRawModuleState / pickRandomIndex / crossedTurnBoundary ...).
  # moduleRegistry.ts imports the eight modules, so a missing upload makes the server die
  # while building the default registry ("Unknown rule module").
  "packages/engine/src/moduleSupport.ts",
  "packages/engine/src/railHubModule.ts",
  "packages/engine/src/landmarkPassportModule.ts",
  "packages/engine/src/portTradeModule.ts",
  "packages/engine/src/piaohaoModule.ts",
  "packages/engine/src/caravanMarketModule.ts",
  "packages/engine/src/oasisCampModule.ts",
  "packages/engine/src/yangtzeFerryModule.ts",
  "packages/engine/src/riverTideModule.ts",
  # ---------- Engine tests (keep the server copies current with the 2.x registry API) ----------
  "packages/engine/src/__tests__/moduleEnvelope.test.ts",
  "packages/engine/src/__tests__/moduleRegistry.test.ts",
  "packages/engine/src/__tests__/hydrate.test.ts",
  "packages/engine/src/__tests__/surrender.test.ts",
  "packages/engine/src/__tests__/botDifficulty.test.ts",
  "packages/engine/src/__tests__/greatWallModule.test.ts",
  "packages/engine/src/__tests__/prisonModule.test.ts",
  # One suite per new v2.16.0 module. Same rule as everything else in this list: the server
  # type-checks and runs the engine package, so a stale copy would validate the old contract.
  "packages/engine/src/__tests__/railHubModule.test.ts",
  "packages/engine/src/__tests__/landmarkPassportModule.test.ts",
  "packages/engine/src/__tests__/portTradeModule.test.ts",
  "packages/engine/src/__tests__/piaohaoModule.test.ts",
  "packages/engine/src/__tests__/caravanMarketModule.test.ts",
  "packages/engine/src/__tests__/oasisCampModule.test.ts",
  "packages/engine/src/__tests__/yangtzeFerryModule.test.ts",
  "packages/engine/src/__tests__/riverTideModule.test.ts",
  # The per-map invariant suite. It now sweeps every production map (modules bound, no illegal
  # intents, cash conservation) instead of a couple of hand-picked seeds, so the server needs the
  # new copy -- a stale one would still pass while the money-leak bug stayed invisible.
  "packages/engine/src/__tests__/simulation.test.ts",
  # Bargain tests (#105 trade / #106 auction). The server runs the client build (vue-tsc) but
  # engine tests are executed there too; a stale copy would validate the old engine contract.
  "packages/engine/src/__tests__/bargain.test.ts",
  "packages/protocol/src/index.ts",
  # ---------- Board data (maps; server uses its initial clone, so new maps must be uploaded explicitly) ----------
  # china-tour / world-tour predate this list. They are listed here too so that a future edit to
  # either of them is actually uploaded instead of being rejected by the local precheck below.
  "packages/board-data/src/chinaTourMap.ts",
  "packages/board-data/src/worldTourMap.ts",
  "packages/board-data/src/classicTourMap.ts",
  "packages/board-data/src/silkRoadMap.ts",
  # great-wall map pack + the module-aware validation that registry.ts depends on. The server
  # builds the production registry at startup, so a stale mapValidation.ts would mis-validate
  # (or reject) the new map's `beacon` module cells.
  "packages/board-data/src/greatWallMap.ts",
  # types.ts carries GameConfig (incl. the optional prison bail cost) and the module cell
  # types; registry.ts / mapValidation.ts import it, so a stale copy breaks the build.
  "packages/board-data/src/types.ts",
  "packages/board-data/src/mapValidation.ts",
  "packages/board-data/src/validate.ts",
  "packages/board-data/src/registry.ts",
  "packages/board-data/src/index.ts",
  "packages/board-data/maps/china-tour/v1/board.json",
  "packages/board-data/maps/china-tour/v1/cards.json",
  "packages/board-data/maps/china-tour/v1/game-config.json",
  "packages/board-data/maps/china-tour/v1/manifest.json",
  "packages/board-data/maps/world-tour/v1/board.json",
  "packages/board-data/maps/world-tour/v1/cards.json",
  "packages/board-data/maps/world-tour/v1/game-config.json",
  "packages/board-data/maps/world-tour/v1/manifest.json",
  "packages/board-data/maps/classic-tour/v1/board.json",
  "packages/board-data/maps/classic-tour/v1/cards.json",
  "packages/board-data/maps/classic-tour/v1/game-config.json",
  "packages/board-data/maps/classic-tour/v1/manifest.json",
  # "Silk Road" map (P2-8b, geometrically different board: 60 cells / nested double ring).
  # The server keeps its own clone of this folder and reads the JSON at startup, so a missing
  # upload means the new map silently does not exist online. All four files are required.
  "packages/board-data/maps/silk-road/v1/board.json",
  "packages/board-data/maps/silk-road/v1/cards.json",
  "packages/board-data/maps/silk-road/v1/game-config.json",
  "packages/board-data/maps/silk-road/v1/manifest.json",
  # "Great Wall" map (P2-8b, first map that enables a non-core rule module: 48-cell snake grid
  # with six claimable beacons). Same rule: the server reads its own clone of this folder at
  # startup, so all four files must be uploaded.
  "packages/board-data/maps/great-wall/v1/board.json",
  "packages/board-data/maps/great-wall/v1/cards.json",
  "packages/board-data/maps/great-wall/v1/game-config.json",
  "packages/board-data/maps/great-wall/v1/manifest.json",
  # "Yellow River" map (64-cell 8x8 inward spiral: the first geometry that is neither a ring, a
  # nested double ring nor a snake grid). Pure core@1, so no extra rule module is needed.
  "packages/board-data/maps/yellow-river/v1/board.json",
  "packages/board-data/maps/yellow-river/v1/cards.json",
  "packages/board-data/maps/yellow-river/v1/game-config.json",
  "packages/board-data/maps/yellow-river/v1/manifest.json",
  "packages/board-data/maps/yangtze-tour/v1/board.json",
  "packages/board-data/maps/yangtze-tour/v1/cards.json",
  "packages/board-data/maps/yangtze-tour/v1/game-config.json",
  "packages/board-data/maps/yangtze-tour/v1/manifest.json",
  "packages/board-data/maps/pearl-tour/v1/board.json",
  "packages/board-data/maps/pearl-tour/v1/cards.json",
  "packages/board-data/maps/pearl-tour/v1/game-config.json",
  "packages/board-data/maps/pearl-tour/v1/manifest.json",
  "packages/board-data/maps/xinjiang-tour/v1/board.json",
  "packages/board-data/maps/xinjiang-tour/v1/cards.json",
  "packages/board-data/maps/xinjiang-tour/v1/game-config.json",
  "packages/board-data/maps/xinjiang-tour/v1/manifest.json",
  "packages/board-data/maps/shanxi-tour/v1/board.json",
  "packages/board-data/maps/shanxi-tour/v1/cards.json",
  "packages/board-data/maps/shanxi-tour/v1/game-config.json",
  "packages/board-data/maps/shanxi-tour/v1/manifest.json",
  "packages/board-data/maps/northeast-tour/v1/board.json",
  "packages/board-data/maps/northeast-tour/v1/cards.json",
  "packages/board-data/maps/northeast-tour/v1/game-config.json",
  "packages/board-data/maps/northeast-tour/v1/manifest.json",
  "packages/board-data/src/northeastTourMap.ts",
  "packages/board-data/src/__tests__/northeastTourMap.test.ts",
  "packages/board-data/src/shanxiTourMap.ts",
  "packages/board-data/src/__tests__/shanxiTourMap.test.ts",
  "packages/board-data/src/xinjiangTourMap.ts",
  "packages/board-data/src/__tests__/xinjiangTourMap.test.ts",
  "packages/board-data/src/__tests__/pearlTourMap.test.ts",
  "packages/board-data/src/pearlTourMap.ts",
  "packages/board-data/src/yangtzeTourMap.ts",
  "packages/board-data/src/__tests__/yangtzeTourMap.test.ts",
  "packages/board-data/src/yellowRiverMap.ts",
  # ---------- Board data tests (keep server copies current vs all six production maps) ----------
  "packages/board-data/src/__tests__/chinaTourMap.test.ts",
  "packages/board-data/src/__tests__/worldTourMap.test.ts",
  "packages/board-data/src/__tests__/greatWallMap.test.ts",
  "packages/board-data/src/__tests__/yellowRiverMap.test.ts",
  "packages/board-data/src/__tests__/mapValidation.test.ts",
  "packages/board-data/src/__tests__/mapTypes.test.ts",
  "packages/board-data/src/__tests__/registry.test.ts",
  "packages/board-data/src/__tests__/testMap.test.ts",
  "packages/board-data/src/__tests__/validate.test.ts",
  "packages/board-data/src/__tests__/hash.test.ts",
  "apps/server/src/game/gameRuntime.ts",
  "apps/server/src/rooms/roomManager.ts",
  "apps/server/src/rooms/roomErrors.ts",
  "apps/server/src/rooms/roomTypes.ts",
  "apps/server/src/rooms/roomSnapshotStore.ts",
  # Public game snapshot projection. It is the ONLY place that whitelists which engine fields
  # reach the wire, so a stale copy silently drops new fields (pendingTrade / pendingAuction /
  # auctionOnDecline, #105 / #106) and the client never sees a bargain in progress.
  "apps/server/src/publicGameSnapshot.ts",
  "apps/server/src/production.ts",
  "apps/server/src/socket/roomSocketAdapter.ts",
  "apps/server/src/server.ts",
  # ---------- Server tests (all; the server must run current 6-digit copies, not stale 4-digit ones) ----------
  "apps/server/src/__tests__/networkAddress.test.ts",
  "apps/server/src/__tests__/partyLauncher.test.ts",
  "apps/server/src/__tests__/production.test.ts",
  "apps/server/src/__tests__/roomSpectators.test.ts",
  "apps/server/src/__tests__/socketGameReconnect.test.ts",
  "apps/server/src/__tests__/roomGame.test.ts",
  "apps/server/src/__tests__/socketGame.test.ts",
  "apps/server/src/__tests__/clientOnlineSession.test.ts",
  "apps/server/src/__tests__/serverStatic.test.ts",
  "apps/server/src/__tests__/socketRooms.test.ts",
  "apps/server/src/__tests__/phase3MultiMap.test.ts",
  "apps/server/src/__tests__/roomManager.test.ts",
  "apps/server/src/__tests__/roomKick.test.ts",
  "apps/server/src/__tests__/gameRuntime.test.ts",
  "apps/server/src/__tests__/fullGameSmoke.test.ts",
  "apps/server/src/__tests__/roomSnapshot.test.ts",
  "apps/server/src/__tests__/roomUndo.test.ts",
  # Per-turn clock (#107): the server-side deadline / timeout-autoplay behaviour.
  "apps/server/src/__tests__/turnTimer.test.ts",
  # ---------- Client tests (all, so vue-tsc never uses stale copies) ----------
  "apps/client/src/components/boardRendering.test.ts",
  "apps/client/src/session/gamePresenter.test.ts",
  "apps/client/src/game/clientGame.test.ts",
  "apps/client/src/components/ActionPanel.test.ts",
  # Bargain panel (#105 trade confirmation / #106 auction bidding / propose form) SSR tests.
  "apps/client/src/components/BargainPanel.test.ts",
  "apps/client/src/components/BoardCell.test.ts",
  "apps/client/src/game/gameSetup.test.ts",
  "apps/client/src/components/GameSetup.test.ts",
  "apps/client/src/components/CellDetailPanel.test.ts",
  "apps/client/src/session/gameInteraction.test.ts",
  "apps/client/src/session/appFlow.test.ts",
  "apps/client/src/ui/boardLayout.test.ts",
  "apps/client/src/game/mapAssets.test.ts",
  "apps/client/src/game/mapResolver.test.ts",
  "apps/client/src/views/HomeView.test.ts",
  "apps/client/src/game/propertyAwards.test.ts",
  "apps/client/src/components/PlayerRail.test.ts",
  "apps/client/src/ui/debtPillLayout.test.ts",
  "apps/client/src/views/LobbyView.test.ts",
  "apps/client/src/game/settlement.test.ts",
  "apps/client/src/ui/cashFeedback.test.ts",
  "apps/client/src/views/localDeleteConfirmation.test.ts",
  "apps/client/src/components/ReleaseNotesDialog.test.ts",
  "apps/client/src/session/invitation.test.ts",
  "apps/client/src/views/localResumeUi.test.ts",
  "apps/client/src/session/localGameSave.test.ts",
  "apps/client/src/session/localSession.botFailure.test.ts",
  "apps/client/src/session/localSession.test.ts",
  "apps/client/src/session/localStartGuard.test.ts",
  "apps/client/src/session/onlineSession.test.ts",
  "apps/client/src/session/playerStats.test.ts",
  "apps/client/src/session/playbackPace.test.ts",
  "apps/client/src/session/sessionStorage.test.ts",
  "apps/client/src/ui/mapThumbnail.test.ts",
  "apps/client/src/components/MapThumbnail.test.ts",
  "apps/client/src/components/SettingsDialog.test.ts",
  "apps/client/src/ui/mapRules.test.ts",
  "apps/client/src/audio/sfx.test.ts",
  "apps/client/src/audio/bgm.test.ts",
  # Tests added by the third batch: turn clock (#107), public room list (#108),
  # first-run guide + chat quick phrases (#109). vue-tsc runs over the whole client package,
  # so a test file left out here is type-checked against a stale server copy.
  "apps/client/src/session/turnTimer.test.ts",
  "apps/client/src/session/quickPhrases.test.ts",
  "apps/client/src/session/firstRunGuide.test.ts",
  "apps/client/src/components/ChatPanel.test.ts",
  "apps/client/src/components/FirstRunGuide.test.ts",
  # Fourth batch: replay export (#115), achievements + leaderboard (#116), map workshop (#117),
  # map theme skins (#118), plus the leaderboard API and its IP rate limiter on the server.
  # Same rule as above: vue-tsc/tsc run over the whole package, so a file left out here gets
  # type-checked against a stale server copy -- or fails only at runtime under tsx.
  "apps/client/package.json",
  "apps/client/src/session/achievements.ts",
  "apps/client/src/session/achievements.test.ts",
  "apps/client/src/session/leaderboard.ts",
  "apps/client/src/session/leaderboard.test.ts",
  "apps/client/src/session/replayCode.ts",
  "apps/client/src/session/replayCode.test.ts",
  "apps/client/src/session/customMaps.ts",
  "apps/client/src/session/customMaps.test.ts",
  "apps/client/src/ui/themeManager.test.ts",
  "apps/client/src/components/ReplayDialog.vue",
  "apps/client/src/components/ReplayDialog.test.ts",
  "apps/client/src/components/MapWorkshopDialog.vue",
  "apps/client/src/components/MapWorkshopDialog.test.ts",
  "apps/server/src/__tests__/leaderboard.test.ts",
  "apps/server/src/http/slidingWindowRateLimiter.ts",
  "apps/server/src/leaderboard/leaderboardStore.ts",
  "apps/server/src/leaderboard/leaderboardRoutes.ts",
  # Fifth batch: cloud save ("stats in the cloud") through server-issued recovery codes (#123).
  # httpJson.ts is the shared helper module that leaderboardRoutes.ts now imports, so the two
  # must ship together -- a stale leaderboardRoutes.ts would still work, but a stale httpJson.ts
  # would not exist at all on the server.
  # playerAccountStore.ts keeps the sha256 hashes of the recovery codes (never the plaintext).
  # server.ts imports both route modules and mounts them BEFORE the static handler; tsx only
  # fails at runtime, so a stale or missing server copy stays silent until a player syncs.
  "apps/server/src/http/httpJson.ts",
  "apps/server/src/player/playerAccountStore.ts",
  "apps/server/src/player/playerAccountRoutes.ts",
  "apps/server/src/__tests__/playerAccount.test.ts",
  # Client side of the same feature: sync/delta helpers + the home-screen cloud-sync block.
  # HomeView.vue imports ./session/playerAccount, so leaving it out breaks vue-tsc TS2307.
  "apps/client/src/session/playerAccount.ts",
  "apps/client/src/session/playerAccount.test.ts"
)

# ---------- Pre-flight guard (added 2026-09-23 after a failed deploy) ----------
# scp only uploads the files listed in $files. A NEW or CHANGED client/server/engine source
# file that is left out of the list makes the SERVER build fail at the very end
# (vite: `Could not resolve "../components/X.vue"`, or vue-tsc TS2307), after 80+ uploads.
# That is exactly what happened with the new PwaInstallRow.vue. Fail fast LOCALLY instead:
# every file that `git status` reports as modified/untracked under apps/ or packages/ must be
# in $files. Root-level scripts, docs and dev-only folders are ignored.
Write-Host "Pre-flight: every changed file under apps/ or packages/ must be in the upload list..."
try {
  $changed = @(git status --porcelain)
  $missing = @()
  foreach ($line in $changed) {
    if ($line.Length -lt 4) { continue }
    $rel = $line.Substring(3).Trim().Trim('"')
    if (-not ($rel.StartsWith("apps/") -or $rel.StartsWith("packages/"))) { continue }
    # Native shell projects (HarmonyOS / Android / iOS) are NOT part of this deploy: scp only
    # ships client + server + engine, so their files must never be demanded in $files. Without
    # this skip, any touch under apps/harmonyos blocks an unrelated deploy -- including a pending
    # rename (EntryAbility.ts -> EntryAbility.ets), where the deleted .ts shows up as a missing entry.
    if ($rel.StartsWith("apps/harmonyos/") -or $rel.StartsWith("apps/android/") -or $rel.StartsWith("apps/ios/")) { continue }
    $targets = @()
    if ($rel.EndsWith("/")) {
      $root = (Get-Location).Path
      $targets = @(Get-ChildItem -LiteralPath $rel -Recurse -File |
        ForEach-Object { ($_.FullName.Substring($root.Length + 1)) -replace '\\', '/' })
    } else {
      $targets = @($rel)
    }
    foreach ($t in $targets) {
      if ($t -notmatch '\.(ts|vue|css|html|webmanifest|js|png|json)$') { continue }
      if ($files -notcontains $t) { $missing += $t }
    }
  }
  $missing = @($missing | Sort-Object -Unique)
  if ($missing.Count -gt 0) {
    Write-Host "MISSING FROM UPLOAD LIST:"
    foreach ($m in $missing) { Write-Host ("  - " + $m) }
    Write-Error "Pre-flight failed: add the files above to `$files (scp only uploads listed files)."
    exit 2
  }
  Write-Host "Pre-flight OK."
} catch {
  Write-Host ("Pre-flight check skipped: " + $_.Exception.Message)
}

# SSH options shared by every connection:
#  - ControlMaster=no : avoid the "getsockname failed: Not a socket" breakage.
#  - ConnectTimeout / ServerAlive* : a hung connection dies fast instead of blocking the
#    whole deploy forever (previously a flaky key auth would fall back to a password prompt
#    with no terminal input and hang indefinitely at one file).
#  - BatchMode=yes : never fall back to an interactive password prompt; error out immediately
#    if the key is missing, so the script fails loud-and-clear rather than stalling.
$sshOpts = @("-o", "ControlMaster=no", "-o", "ConnectTimeout=15", `
             "-o", "ServerAliveInterval=20", "-o", "ServerAliveCountMax=3", "-o", "BatchMode=yes")

# Create every destination directory in ONE connection up front (scp does not create parents).
# Use a forward-slash-safe directory extraction: Split-Path -Parent on Windows PowerShell
# mishandles "/" delimiters in relative paths and returns the wrong parent. Root-level files
# (no "/") need no directory.
$dirs = @()
foreach ($f in $files) {
  if ($f.Contains('/')) {
    $dirs += ($repo + "/" + $f.Substring(0, $f.LastIndexOf('/')))
  }
}
$dirs = $dirs | Sort-Object -Unique
Write-Host "Create destination dirs (one connection)..."
ssh $sshOpts $server ("mkdir -p " + ($dirs -join " "))
if ($LASTEXITCODE -ne 0) {
  Write-Error "mkdir failed for destination dirs"
  exit $LASTEXITCODE
}

# Upload each file with a fresh, passwordless connection (the key is already installed).
foreach ($f in $files) {
  Write-Host ("Upload: " + $f)
  scp $sshOpts $f ($server + ":" + $repo + "/" + $f)
  if ($LASTEXITCODE -ne 0) {
    Write-Error ("Upload failed: " + $f)
    exit $LASTEXITCODE
  }
}

Write-Host "Build client on server..."
ssh $sshOpts $server ("cd " + $repo + "; pnpm --filter @richman/client build")
if ($LASTEXITCODE -ne 0) {
  Write-Error "Client build failed; pm2 not restarted"
  exit $LASTEXITCODE
}

# Server is run by tsx (no emit) so a missing import / wrong arg only blows up at RUNTIME
# (this is exactly what froze online bots: gameRuntime used defaultRuleModuleRegistry without importing it).
# Type-check the server too, and abort before restart so such errors never reach production.
Write-Host "Type-check server on server..."
ssh $sshOpts $server ("cd " + $repo + "; pnpm --filter @richman/server build")
if ($LASTEXITCODE -ne 0) {
  Write-Error "Server type-check failed; pm2 not restarted"
  exit $LASTEXITCODE
}

# Full-game smoke gate: type-checking cannot catch a wrong-but-well-typed wiring, and the unit
# tests mostly inject a FAKE gateway, so neither could catch the frozen-bot incident. This runs
# a real whole game through RoomManager + the real defaultGameGateway + real maps and fails the
# deploy if it stalls, errors, or never reaches game_over.
Write-Host "Run server full-game smoke test on server..."
ssh $sshOpts $server ("cd " + $repo + "; pnpm exec vitest run apps/server/src/__tests__/fullGameSmoke.test.ts")
if ($LASTEXITCODE -ne 0) {
  Write-Error "Full-game smoke test failed; pm2 not restarted"
  exit $LASTEXITCODE
}

Write-Host "Restart pm2..."
ssh $sshOpts $server "pm2 restart richman"
