# pipoe

Small service and CLI that talks to the PoE switch of the Raspberry Pi production ecosystem and switches power to named devices: read which ports are active and what they draw, turn PoE on or off per port, or cycle a port. First target: the **PLANET SGS-4210-16P2S** at `192.168.1.2` (16 gigabit PoE ports + 2 SFP) in the church rack.

Scope is deliberately small: on-demand reads and switches only. No polling, no watchdog and no automatic cycling. Callers (for example picam's camera freeze handling, see `jsilvanus/picam` `docs/camera-diagnostics-proposal.md`) decide when to cycle.

> **Status: never run against the real switch.** The SNMP driver is built on the standard PoE MIB (RFC 3621) and tested against a fake SNMP session and a simulated switch only. Which OIDs the SGS-4210 actually answers, the port numbering, and per-port power draw all still have to be confirmed with read-only probes (below).

## What it does

- `GET /api/v1/poe`: all PoE ports (PoE on/off, status `delivering|searching|disabled|fault|other`, link up/down, power in W if known) and switch totals (budget, consumed).
- `GET /api/v1/poe/ports/{port}`: one port, by number or configured name.
- `POST /api/v1/poe/ports/{port}/power` `{ "enabled": true|false }`: switch PoE; the state is read back and a mismatch is an error.
- `POST /api/v1/poe/ports/{port}/cycle` `{ "offMs": 5000 }`: off, wait (1 to 60 s), on. If a cycle fails halfway it tries to switch the port back on.
- `GET /openapi.json`, `GET /health`.

Safety: only ports with a name in `PIPOE_PORT_NAMES` can be switched (reads work for every port, `PIPOE_ALLOW_UNLISTED=1` lifts this), one switch or cycle at a time per port (409 otherwise), optional bearer token `PIPOE_API_KEY` on `/api`. The service holds the SNMP write community, so keep it off the open network.

## Run

```bash
npm install
npm run build
PIPOE_MODE=production npm start    # default mode is simulation (a fake 16-port switch)
npx pipoe list                     # CLI, PIPOE_URL defaults to http://127.0.0.1:3302
npx pipoe cycle cam1
```

Configuration is in `.env.example`. Defaults to port 3302.

## Switch setup (SNMP)

On the PLANET switch enable SNMP (v2c) and set a read community; a write community is needed for on/off/cycle. Put them in `PIPOE_SNMP_COMMUNITY` / `PIPOE_SNMP_WRITE_COMMUNITY`. Never commit them.

The driver reads, per `PIPOE_PSE_GROUP` (default 1) and port:

| Value | OID |
|---|---|
| PoE admin enable (read/write; 1 on, 2 off) | `1.3.6.1.2.1.105.1.1.1.3.<group>.<port>` |
| PoE detection status (3 = delivering) | `1.3.6.1.2.1.105.1.1.1.6.<group>.<port>` |
| Link (ifOperStatus) | `1.3.6.1.2.1.2.2.1.8.<port>` (assumes ifIndex = port number) |
| PoE budget / consumed, watts | `1.3.6.1.2.1.105.1.3.1.1.2.<group>` / `.4.<group>` |

Per-port watts are not in the standard MIB. If the switch's own MIB has them, set `PIPOE_SNMP_PORT_POWER_OID` (prefix, the port number is appended) and `PIPOE_SNMP_PORT_POWER_SCALE` (multiplier to watts). Otherwise `powerW` is `null`.

### Read-only probes to confirm on the real switch

Run from the Pi (needs `snmp` tools); these only read:

```bash
SW=192.168.1.2; C=public
snmpwalk -v2c -c $C $SW 1.3.6.1.2.1.105.1.1.1.3   # admin enable per port
snmpwalk -v2c -c $C $SW 1.3.6.1.2.1.105.1.1.1.6   # detection status per port
snmpwalk -v2c -c $C $SW 1.3.6.1.2.1.105.1.3.1.1   # budget and consumption
snmpwalk -v2c -c $C $SW 1.3.6.1.2.1.2.2.1.2       # ifDescr: ifIndex to port name
snmpwalk -v2c -c $C $SW 1.3.6.1.2.1.2.2.1.8       # link state
snmpwalk -v2c -c $C $SW 1.3.6.1.4.1.10456         # PLANET enterprise subtree (find per-port power)
```

## Development

`npm test` runs the unit tests (simulated switch, fake SNMP session, HTTP via `inject`). `npm run build` type-checks and compiles.

## Pi ecosystem

This repository is part of the Pi production ecosystem. Per the other Pi repos' rule, changes to its role, API, ports or status belong in `piecosystem` (`docs/projects-catalog.md`, `docs/inter-service-matrix.md`).
