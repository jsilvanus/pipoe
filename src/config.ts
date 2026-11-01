export interface AppConfig {
  host: string;
  port: number;
  mode: "simulation" | "production";
  apiKey?: string | undefined;
  switchHost: string;
  snmpPort: number;
  snmpCommunity: string;
  snmpWriteCommunity: string;
  snmpTimeoutMs: number;
  poePorts: number;
  pseGroup: number;
  /** name -> port number */
  portNames: Record<string, number>;
  allowUnlisted: boolean;
  portPowerOid?: string | undefined;
  portPowerScale: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isNaN(n) ? fallback : n;
}

export function parsePortNames(value: string | undefined): Record<string, number> {
  const names: Record<string, number> = {};
  for (const part of (value ?? "").split(",")) {
    const m = /^\s*([A-Za-z][\w-]*)\s*=\s*(\d+)\s*$/.exec(part);
    if (m) names[m[1]!.toLowerCase()] = Number.parseInt(m[2]!, 10);
  }
  return names;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const community = env["PIPOE_SNMP_COMMUNITY"]?.trim() || "public";
  const scale = Number.parseFloat(env["PIPOE_SNMP_PORT_POWER_SCALE"] ?? "0.001");
  return {
    host: env["PIPOE_HOST"] ?? "0.0.0.0",
    port: int(env["PIPOE_PORT"], 3302),
    mode: env["PIPOE_MODE"] === "production" ? "production" : "simulation",
    apiKey: env["PIPOE_API_KEY"]?.trim() || undefined,
    switchHost: env["PIPOE_SWITCH_HOST"]?.trim() || "192.168.0.100",
    snmpPort: int(env["PIPOE_SNMP_PORT"], 161),
    snmpCommunity: community,
    snmpWriteCommunity: env["PIPOE_SNMP_WRITE_COMMUNITY"]?.trim() || community,
    snmpTimeoutMs: int(env["PIPOE_SNMP_TIMEOUT_MS"], 3000),
    poePorts: Math.max(1, int(env["PIPOE_POE_PORTS"], 16)),
    pseGroup: Math.max(1, int(env["PIPOE_PSE_GROUP"], 1)),
    portNames: parsePortNames(env["PIPOE_PORT_NAMES"]),
    allowUnlisted: env["PIPOE_ALLOW_UNLISTED"] === "1",
    portPowerOid: env["PIPOE_SNMP_PORT_POWER_OID"]?.trim().replace(/^\./, "").replace(/\.$/, "") || undefined,
    portPowerScale: Number.isNaN(scale) ? 0.001 : scale
  };
}
