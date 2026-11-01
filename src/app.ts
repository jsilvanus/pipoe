import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { PoeService } from "./poe-service.js";
import { SimulatedSwitch } from "./sim-switch.js";
import { netSnmpAccess, SnmpSwitch } from "./snmp-switch.js";
import { PoeError, type SwitchDriver } from "./types.js";

export function buildDriver(config: AppConfig): SwitchDriver {
  if (config.mode === "simulation") {
    const connected = Object.values(config.portNames);
    return new SimulatedSwitch(config.poePorts, connected.length ? connected : [1, 2]);
  }
  return new SnmpSwitch(
    netSnmpAccess(config.switchHost, config.snmpPort, config.snmpCommunity, config.snmpTimeoutMs),
    netSnmpAccess(config.switchHost, config.snmpPort, config.snmpWriteCommunity, config.snmpTimeoutMs),
    {
      pseGroup: config.pseGroup,
      poePorts: config.poePorts,
      portPowerOid: config.portPowerOid,
      portPowerScale: config.portPowerScale
    }
  );
}

export function buildApp(config: AppConfig, driver: SwitchDriver = buildDriver(config)): { app: FastifyInstance; service: PoeService } {
  const app = Fastify({ logger: { level: process.env["NODE_ENV"] === "test" ? "silent" : "info" } });
  const service = new PoeService({
    driver,
    portNames: config.portNames,
    poePorts: config.poePorts,
    allowUnlisted: config.allowUnlisted
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof PoeError) return reply.status(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: status >= 500 ? "Internal error" : (err as Error).message });
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!config.apiKey || !req.url.startsWith("/api")) return;
    if (req.headers.authorization !== `Bearer ${config.apiKey}`) return reply.status(401).send({ error: "Unauthorized" });
  });

  app.get("/health", async () => ({ ok: true, mode: config.mode }));
  app.get("/openapi.json", async (_req, reply) => {
    const file = new URL("../openapi/openapi.json", import.meta.url);
    return reply.type("application/json").send(readFileSync(file, "utf8"));
  });

  app.get("/api/v1/poe", async () => service.list());
  app.get<{ Params: { port: string } }>("/api/v1/poe/ports/:port", async (req) => service.get(req.params.port));
  app.post<{ Params: { port: string }; Body: { enabled?: unknown } }>("/api/v1/poe/ports/:port/power", async (req) => {
    if (typeof req.body?.enabled !== "boolean") throw new PoeError(400, "Body must be {\"enabled\": true|false}");
    return service.setPower(req.params.port, req.body.enabled);
  });
  app.post<{ Params: { port: string }; Body: { offMs?: unknown } | undefined }>("/api/v1/poe/ports/:port/cycle", async (req) => {
    const offMs = req.body?.offMs;
    if (offMs !== undefined && (typeof offMs !== "number" || !Number.isFinite(offMs))) throw new PoeError(400, "offMs must be a number");
    return service.cycle(req.params.port, offMs as number | undefined);
  });

  app.addHook("onClose", async () => service.close());
  return { app, service };
}
