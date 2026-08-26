# Admin Suite — Server Tools

An all-in-one server management addon for **Minecraft Bedrock**, built on the
Script API. Roles and permissions for staff, moderation tools, an economy with
a shop and auction house, land claims, progression systems, and a menu-driven
interface for all of it.

Everything is reachable three ways: a **form menu** (two in-game items), **102
commands** in both chat (`!home`) and native (`/adm:home`) form, and
**interactive NPCs** you place in the world.

---

## Quick start

1. Download the latest `AdminSuite-v<version>.mcaddon` from the Releases page
   (or build it — see below) and open it. Minecraft installs both packs.
2. Create your world with:
   - **Beta APIs** — ON (see [Why Beta APIs](#why-beta-apis))
   - **Cheats** — ON
3. Apply **both** the behaviour pack and the resource pack to the world.
4. Join, then give yourself bootstrap access:

   ```
   /tag @s add admin
   ```

5. Run `/adm:getsuite` to receive the **Admin Suite** item, then right-click it
   to open the admin panel.
6. Open **Roles & Permissions**, assign yourself the **Owner** role, and remove
   the bootstrap tag with `/tag @s remove admin`.

Every player automatically receives a **Member Suite** book on first join, plus
the starter kit.

> Unlike setups that make you build a role from scratch before anything works,
> a full role ladder (Owner, Admin, Mod, Builder, Member) exists from first
> launch. The `admin` tag is only a bootstrap so a fresh world is never locked
> out.

---

## What's included

| System | What it does |
| --- | --- |
| **Roles & permissions** | Unlimited roles, ~60 permission nodes with wildcards (`players.*`), priority ordering, chat prefixes, default roles |
| **Player management** | Browse every known player online or off; teleport, game mode, heal, inventory view/edit, vault, balance, roles |
| **Moderation** | Timed and permanent bans, mutes, kick, freeze, vanish, staff spy channel, player reports, chat word filter, anti-spam |
| **World management** | Time, weather, difficulty, game rules, entity cleanup, soft world border |
| **Economy** | Balances, transfers with configurable tax, leaderboard, admin adjustment, bulk `!deposit` |
| **Shop & auction** | Shop starts empty. Staff add unlimited-stock server listings; any player can open a stall backed by their own stock at their own price. Plus sell-hand, bulk deposit and a one-off auction house |
| **Land claims** | Rectangular claims with trust lists, container and PvP flags, chunk-indexed protection |
| **Teleporting** | Three tiers of destination — private homes, staff-curated server warps, and public player warps anyone can publish — plus `!tpa`/`!tpahere` with warmup, random teleport, `!back` and spawn |
| **Progression** | Rank ladder (automatic and purchasable), five passive skills with milestone perks, jobs that pay for ordinary play, quests, and reward XP that doubles as spendable enchanting levels |
| **Quality of life** | Handheld offhand torch with dynamic lighting, menu items that survive death, teleport requests from the member menu, searchable lists, and sound on every action |
| **Rewards** | Fully editable kits (contents, cooldown, price, access), an optional starter kit on first join pointed at any kit, daily reward streaks, redeemable codes |
| **Social** | Clans with a shared bank and clan chat, wagered duels in a bounded ring |
| **Display** | Custom chat format, custom nametags, scoreboard sidebar, per-player action bar, holograms with live leaderboards |
| **Content** | Interactive NPCs (shopkeeper, kit master, daily rewards, job board, travel agent, rank shop, stylist), rotating broadcasts |
| **Cosmetics** | Buyable particle trails, auras and halos on a shared, throttled render loop |
| **Accounts** | Optional password gate on join |
| **Gravestones** | Inventories survive lava, the void and `/kill`; recover with `!grave` |
| **Combat tagging** | Trading hits blocks teleport escapes for a configurable window |
| **Block quotas** | Optional daily break/place limits per player, with staff bypass |
| **Vaults** | Inspectable per-player server-side storage |
| **Languages** | English, Indonesian and Spanish included, with a drop-in framework for more |

Full list: **[docs/COMMANDS.md](docs/COMMANDS.md)** ·
**[docs/PERMISSIONS.md](docs/PERMISSIONS.md)** ·
**[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**

---

## Why Beta APIs

Minecraft's Script API only exposes chat interception
(`world.beforeEvents.chatSend`) behind the **Beta APIs** experimental toggle —
it has never been promoted to the stable surface. Four features depend on it:

- the `!command` chat prefix
- the custom chat format
- mute enforcement
- the chat word filter and anti-spam

**Everything else works without it.** If Beta APIs are off, the addon detects
this at startup, logs a notice, disables just those four features and keeps
running — all 102 commands remain available in their `/adm:` form.

To build a pack that declares only the stable module:

```bash
npm run build -- --stable
```

---

## Building from source

Requires Node.js 18+.

```bash
npm install
npm run check      # typecheck + smoke test + build
npm run package    # produces dist/AdminSuite-v<version>.mcaddon
```

| Script | Purpose |
| --- | --- |
| `npm run build` | Bundle to `dist/BP/scripts/main.js` and assemble both packs |
| `npm run build -- --stable` | Same, declaring the stable API module instead of beta |
| `npm run watch` | Rebuild on change |
| `npm run package` | Build and zip a `.mcaddon` |
| `npm run typecheck` | TypeScript, no emit |
| `npm run test` | Smoke test (see below) |
| `npm run docs` | Regenerate the reference docs from the source |
| `npm run icons` | Regenerate the UI icon set into the resource pack |

### Pack formats

`npm run package` writes three files, and they are **not** interchangeable:

| File | Contains | Use it when |
| --- | --- | --- |
| `AdminSuite-v<version>.mcaddon` | both packs, each in its own folder | normal install — this is the one you want |
| `AdminSuite-BehaviourPack-v<version>.mcpack` | the behaviour pack alone, manifest at the archive root | installing one side at a time |
| `AdminSuite-ResourcePack-v<version>.mcpack` | the resource pack alone, manifest at the archive root | installing one side at a time |

Renaming one format to the other does not work: a `.mcpack` must have its
`manifest.json` at the root of the archive, while a `.mcaddon` has none there
and holds a folder per pack.

> **Downloading the repository as a ZIP and renaming it will not work either.**
> The source tree has no built script in `packs/BP/scripts/` — it is produced by
> `npm run build` — so the manifest would point at a `main.js` that does not
> exist, and GitHub's ZIP additionally wraps everything in an extra top-level
> folder. Use a packaged file from the Releases page, or build one yourself.

### Installing a dev build manually

Copy `dist/BP` into `development_behavior_packs/` and `dist/RP` into
`development_resource_packs/` inside your `com.mojang` folder, then enable both
on the world.

### Testing

Minecraft cannot be launched from CI, so `npm run test` builds the bundle
against mock implementations of `@minecraft/server` and `@minecraft/server-ui`
and executes it in Node. It verifies that the bundle loads, registers all 102
native commands, wires its event handlers and background loops, round-trips a
chat command end to end, handles gameplay events, and persists data across a
shutdown.

The mocks reproduce the engine's early-execution restriction, so code that
reads storage at module scope fails here rather than in a world. The test also
validates pack assets that no compiler can see: item icons resolving through
the atlas to a real PNG, translations existing for each identifier, item
schemas staying within a supported baseline, and every entity geometry,
texture and render controller resolving to something the pack actually defines.

This catches load-order faults, startup crashes and dangling asset references,
but it is not a substitute for playing the pack — behaviour that depends on
real world state still needs in-game testing.

---

## How it is put together

```
src/
  core/         engine: storage, profiles, permissions, commands, UI, i18n
  modules/      one file per feature system, each exporting install()
  menus/        the admin and member form trees
packs/BP,RP/    manifests, items, entities, textures
test/           mocks and the smoke test
```

A few decisions worth knowing:

- **Persistence** uses world dynamic properties. A single property has a size
  ceiling, so each table is JSON-serialised and split across numbered chunks,
  cached in memory and flushed on a short debounce.
- **Commands** are declared once and exposed both as native custom commands and
  as chat commands. Handlers always run deferred through `system.run`, because
  both entry points fire in a read-only context where world mutation throws.
- **Startup is two-phase.** The engine rejects world state access during early
  execution, and a throw there aborts the whole script before any command is
  registered. A module's `install()` may only register commands and subscribe
  to events; anything touching storage belongs in `init()`, which runs on the
  first tick.
- **Module order matters** in `src/main.ts`: `land` installs PvP protection that
  `duels` deliberately overrides, and `combat` loads after `duels` so duellists
  are exempt from combat tagging.
- **Menu items are restored from entitlement, not from the corpse.** By the
  time a death event reaches script the inventory has usually already been
  emptied, so anything that inspects it then finds nothing. The profile records
  what a player should have and every spawn tops them up, which also covers an
  item lost to lava, the void or a full inventory.
- **A freeze actually holds.** Movement, jumping, sneaking, mounting and the
  camera are all locked, and breaking, placing, interacting and attacking are
  refused. Teleporting is refused too, with no bypass: staff freeze somebody
  precisely so they cannot leave, and every teleport route in the addon -
  command, menu and NPC alike - goes through one gated function so none of them
  can quietly become an exit.
- **The resource pack declares PBR compatibility.** A pack that declares
  neither the `pbr` capability nor an addon `product_type` silently caps the
  whole game at Fancy graphics, so Vibrant Visuals cannot be turned on. Nothing
  errors and nothing logs, which makes it very hard to trace back to a pack.
  Both are declared, and a test fails the build if either goes missing.
- **A menu button does the thing.** Printing "use !claim 16 to confirm" is not
  a menu, it is a manual with extra steps. Every button carries out the action
  itself, which meant lifting the logic out of the command handlers into shared
  functions both call, so the two can never drift apart. A test fails the build
  if a button goes back to printing a command.
- **Dynamic light is real blocks, so cleanup is the feature.** Bedrock exposes
  no way to set a light level, so the handheld torch places a `light_block` and
  moves it. A stray one is invisible and effectively permanent, so every path
  that ends the effect clears it, only air is ever replaced, and only a light
  block is ever cleared.
- **Three tiers of destination, deliberately separate.** A home is private to
  one player; a server warp is public but staff-only to create; a player warp is
  public and anyone may publish one. They live in separate tables and separate
  menus so the destinations staff curate are never mixed in with whatever
  players have published. Publishing is blocked inside a claim you could not
  build in, since a warp there would hand everyone a doorway into someone's base.
- **Two kinds of XP, kept apart.** Skill XP levels the five passive skills and
  drives the job pay multiplier. Account XP is a lifetime total that feeds rank
  progression, and deliberate rewards - daily, kits, codes, quests, duel wins -
  also hand out matching *vanilla* experience, so the number is spendable at an
  enchanting table. Passive block and kill ticks add to the lifetime total only:
  the game already pays XP for ore and mobs, and topping that up per event would
  make enchanting free.
- **A feature toggle removes the feature, not just its effect.** Jobs are the
  worked example: with the switch off the commands refuse, the menu entry is
  hidden and the Job Board NPC says it is closed, rather than players taking a
  job that silently pays nothing. Stored job choices are kept, so turning it
  back on restores everyone's job.
- **Player stalls are stock-backed on purpose.** Players price what they sell
  but never what the shop buys back. A player-set buy-back price would let
  anyone list dirt at a fortune and sell it to the server forever; backing a
  listing with real stock keeps the money moving between players instead of
  being minted.
- **Icons are ours, not vanilla's.** Menu buttons pointed at vanilla texture
  paths, which is a bet that each path exists and keeps its name; several did
  not and rendered as the magenta missing-texture square. The pack now ships
  its own icon set, generated by `npm run icons`, and the test rejects any
  reference outside it.
- **Every icon is a thing from the game.** An emerald for the shop, an ender
  pearl for warps, a carrot for farming - not the person, cog and cart that
  any dashboard would use, because a player recognises the object before they
  read the label. They are authored as 16x16 character maps, the resolution
  vanilla item art uses, and doubled to 32x32 so the pixel grid stays crisp
  rather than resampled. A typo in art that dense is invisible until it ships,
  so the generator fails the build on a wrong-length row or an unknown colour.
- **An empty list has to say it is empty.** A list screen with no items renders
  as a form containing nothing but a Back button, which reads as broken rather
  than empty - reported by a server owner who assumed warps were not working.
  Every list now explains itself, and a test fails the build if a new one does
  not.
- **One screen at a time, per player.** A single physical click can raise more
  than one event - using an item at a block raises both `itemUse` and
  `playerInteractWithBlock` - so one click could start two menus. The second
  could not show while the first was up, waited in the busy-retry loop, then
  appeared in the gap between one screen closing and the next opening: a click
  that throws you back to the top, and two screens to dismiss at the end. A
  player who already has a form up is never handed a second one.
- **Silence reads as failure.** A menu that answers without a sound feels
  broken even when it worked, so outcomes carry a cue. Only the first cue in a
  tick is played: an arrival makes its own sound and the caller then confirms
  it in chat, and two at once reads as a glitch rather than as feedback. That
  is handled centrally, so call sites never have to coordinate.
- **The sidebar is world-global.** Bedrock has no per-viewer scoreboard, so
  sidebar rows carry only server-wide values and each player's own figures go to
  their action bar instead.

### Adding a language

English, Indonesian and Spanish ship in `src/core/i18n.ts`. A locale only needs
the keys it translates — anything missing falls back to English, so a partial
translation is always safe:

```ts
import { registerLocale } from './core/i18n';

registerLocale('fr', {
  'err.noPermission': "Vous n'avez pas la permission de faire cela.",
  'err.playerNotFound': 'Joueur introuvable.',
});
```

New locales appear automatically in the language dropdown under
**Admin Suite -> Server Settings -> General**.

### Adding a feature

Each system is one file in `src/modules/` exporting `install()`, added to the
`MODULES` list in `src/main.ts`. Declare commands with `register()`, add any new
permission nodes to `PERMISSION_GROUPS` in `src/core/permissions.ts` so they
appear in the role editor, and persist state with a `Table` from
`src/core/storage.ts`.

---

## Known platform limits

These are constraints of the Script API, not omissions:

- **Ender chests cannot be read or written** by scripts. The addon provides
  inspectable per-player **vaults** instead, which is what staff actually need
  when investigating items.
- **No per-player scoreboard sidebar** — see above.
- **Chat needs Beta APIs** — see above.
- **No `kick` API** — kicking is issued through the `/kick` command.
- **The password gate is a convenience lock, not authentication.** Passwords are
  stored as a non-cryptographic digest and typed into an ordinary form. It stops
  a sibling joining on your gamertag; it is not a security boundary.

## Credits

Inspired by the feature set of *Admin Suite – Server Tools* by Heraclaus. This
is an independent implementation written from scratch; no code from that addon
was used.

## Licence

MIT — see [LICENSE](LICENSE).
