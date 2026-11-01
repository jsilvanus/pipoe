process.env["NODE_ENV"] = "test";
import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig, parsePortNames } from "../src/config.js";
import { PoeService } from "../src/poe-service.js";
import { SimulatedSwitch } from "../src/sim-switch.js";
import { OID, SnmpSwitch, type SnmpAccess, type SnmpValue } from "../src/snmp-switch.js";

function service(extra: { allowUnlisted?: boolean } = {}) {
  const sleeps: number[] = [];
  const svc = new PoeService({
    driver: new SimulatedSwitch(16, [1, 2]),
    portNames: { cam1: 1, cam2: 2 },
    poePorts: 16,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra
  });
  return { svc, sleeps };
}

test("port names parse and resolve", () => {
  assert.deepEqual(parsePortNames("cam1=5, Cam2=6,bad,x=y"), { cam1: 5, cam2: 6 });
  const { svc } = service();
  assert.equal(svc.resolvePort("CAM2"), 2);
  assert.equal(svc.resolvePort("7"), 7);
  assert.throws(() => svc.resolvePort("17"), /No PoE port/);
  assert.throws(() => svc.resolvePort("nope"), /Unknown port name/);
});

test("off and on are verified by read-back", async () => {
  const { svc } = service();
  const off = await svc.setPower("cam1", false);
  assert.equal(off.poeEnabled, false);
  assert.equal(off.delivering, false);
  const on = await svc.setPower("cam1", true);
  assert.equal(on.delivering, true);
  assert.equal(on.name, "cam1");
});

test("unnamed ports cannot be switched unless allowed", async () => {
  await assert.rejects(service().svc.setPower("9", false), /refusing/);
  const { svc } = service({ allowUnlisted: true });
  assert.equal((await svc.setPower("9", false)).poeEnabled, false);
});

test("cycle waits at least a second and ends powered", async () => {
  const { svc, sleeps } = service();
  const state = await svc.cycle("cam1", 10);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(state.delivering, true);
});

test("a failing cycle switches the port back on", async () => {
  const driver = new SimulatedSwitch(16, [1]);
  const real = driver.setPoeEnabled.bind(driver);
  let calls = 0;
  driver.setPoeEnabled = async (port, enabled) => {
    calls++;
    if (calls === 2) throw new Error("boom"); // the "on" step of the cycle
    return real(port, enabled);
  };
  const svc = new PoeService({ driver, portNames: { cam1: 1 }, poePorts: 16, sleep: async () => {} });
  await assert.rejects(svc.cycle("cam1"), /boom/);
  assert.equal((await svc.get("cam1")).poeEnabled, true);
});

test("a second switch on a busy port is refused", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const svc = new PoeService({ driver: new SimulatedSwitch(16, [1]), portNames: { cam1: 1 }, poePorts: 16, sleep: () => gate });
  const first = svc.cycle("cam1");
  await new Promise((r) => setImmediate(r));
  await assert.rejects(svc.setPower("cam1", false), /busy/);
  release();
  await first;
});

test("HTTP API: list, get, power, cycle, auth", async () => {
  const config = { ...loadConfig({ PIPOE_PORT_NAMES: "cam1=1,cam2=2", PIPOE_API_KEY: "k" }) };
  const { app } = buildApp(config);
  const auth = { authorization: "Bearer k" };
  assert.equal((await app.inject({ url: "/api/v1/poe" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/health" })).statusCode, 200);
  const list = (await app.inject({ url: "/api/v1/poe", headers: auth })).json();
  assert.equal(list.ports.length, 16);
  assert.equal(list.ports[0].name, "cam1");
  assert.equal((await app.inject({ url: "/api/v1/poe/ports/zzz", headers: auth })).statusCode, 404);
  const bad = await app.inject({ method: "POST", url: "/api/v1/poe/ports/cam1/power", headers: auth, payload: {} });
  assert.equal(bad.statusCode, 400);
  const off = await app.inject({ method: "POST", url: "/api/v1/poe/ports/cam1/power", headers: auth, payload: { enabled: false } });
  assert.equal(off.json().poeEnabled, false);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/poe/ports/5/power", headers: auth, payload: { enabled: false } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/openapi.json" })).statusCode, 200);
  await app.close();
});

function fakeSnmp(store: Map<string, number>): SnmpAccess & { sets: Array<[string, number]> } {
  const sets: Array<[string, number]> = [];
  return {
    sets,
    async get(oids) {
      return oids.map((oid): SnmpValue => ({ oid, value: store.get(oid) ?? null }));
    },
    async setInteger(oid, value) {
      sets.push([oid, value]);
      store.set(oid, value);
    },
    close() {}
  };
}

test("SNMP driver reads RFC 3621 OIDs and writes admin enable", async () => {
  const store = new Map<string, number>([
    [`${OID.mainPsePower}.1`, 230],
    [`${OID.mainPseConsumption}.1`, 17],
    [`${OID.portAdminEnable}.1.1`, 1],
    [`${OID.portDetectionStatus}.1.1`, 3],
    [`${OID.ifOperStatus}.1`, 1],
    [`${OID.portAdminEnable}.1.2`, 2],
    [`${OID.portDetectionStatus}.1.2`, 1],
    [`${OID.ifOperStatus}.1`.replace(/1$/, "2"), 2],
    ["1.3.6.1.4.1.9999.1.1", 8500]
  ]);
  const access = fakeSnmp(store);
  const sw = new SnmpSwitch(access, access, { pseGroup: 1, poePorts: 2, portPowerOid: "1.3.6.1.4.1.9999.1" });
  const { ports, totals } = await sw.readAll();
  assert.deepEqual(totals, { budgetW: 230, consumedW: 17 });
  assert.equal(ports[0]!.delivering, true);
  assert.equal(ports[0]!.link, "up");
  assert.equal(ports[0]!.powerW, 8.5);
  assert.equal(ports[1]!.poeEnabled, false);
  assert.equal(ports[1]!.status, "disabled");
  assert.equal(ports[1]!.link, "down");
  await sw.setPoeEnabled(2, true);
  assert.deepEqual(access.sets, [[`${OID.portAdminEnable}.1.2`, 1]]);
  assert.equal((await sw.readAll()).ports[1]!.poeEnabled, true);
});
