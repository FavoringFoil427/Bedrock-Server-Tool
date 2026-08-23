# Admin Suite — Server Tools

An all-in-one server management addon for **Minecraft Bedrock**, built on the
Script API. Roles and permissions for staff, moderation tools, an economy with
a shop and auction house, land claims, progression systems, and a menu-driven
interface for all of it.

Everything is reachable three ways: a **form menu** (two in-game items), **97
commands** in both chat (`!home`) and native (`/adm:home`) form, and
**interactive NPCs** you place in the world.

---

## Quick start

1. Download `AdminSuite-v1.0.0.mcaddon` from `dist/` (or build it — see below)
   and open it. Minecraft installs both packs.
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
| **Shop & auction** | Category shop with static buy/sell pricing, sell-hand, and a player-run auction house |
| **Land claims** | Rectangular claims with trust lists, container and PvP flags, chunk-indexed protection |
| **Teleporting** | Homes, warps, `!tpa`/`!tpahere` with warmup, random teleport, `!back`, spawn |
| **Progression** | Rank ladder (automatic and purchasable), five passive skills with milestone perks, jobs that pay for ordinary play, quests |
| **Rewards** | Starter kits, daily reward streaks, configurable kits, redeemable codes |
| **Social** | Clans with a shared bank and clan chat, wagered duels in a bounded ring |
| **Display** | Custom chat format, custom nametags, scoreboard sidebar, per-player action bar, holograms with live leaderboards |
| **Content** | Interactive NPCs (shopkeeper, kit master, daily rewards, job board, travel agent, rank shop), rotating broadcasts |
| **Accounts** | Optional password gate on join |
| **Gravestones** | Inventories survive lava, the void and `/kill`; recover with `!grave` |
| **Combat tagging** | Trading hits blocks teleport escapes for a configurable window |
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
running — all 97 commands remain available in their `/adm:` form.

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

### Installing a dev build manually

Copy `dist/BP` into `development_behavior_packs/` and `dist/RP` into
`development_resource_packs/` inside your `com.mojang` folder, then enable both
on the world.

### Testing

Minecraft cannot be launched from CI, so `npm run test` builds the bundle
against mock implementations of `@minecraft/server` and `@minecraft/server-ui`
and executes it in Node. It verifies that the bundle loads, registers all 97
native commands, wires its event handlers and background loops, round-trips a
chat command end to end, handles gameplay events, and persists data across a
shutdown.

This catches load-order faults and startup crashes, but it is not a substitute
for playing the pack — behaviour that depends on real world state still needs
in-game testing.

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
- **Module order matters** in `src/main.ts`: `land` installs PvP protection that
  `duels` deliberately overrides, and `combat` loads after `duels` so duellists
  are exempt from combat tagging.
- **The sidebar is world-global.** Bedrock has no per-viewer scoreboard, so
  sidebar rows carry only server-wide values and each player's own figures go to
  their action bar instead.

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
