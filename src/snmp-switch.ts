import snmp from "net-snmp";
import type { LinkStatus, PoeStatus, PoeTotals, PortState, SwitchDriver } from "./types.js";

// RFC 3621 POWER-ETHERNET-MIB (IEEE 802.3af/at PSE). Index is <pseGroup>.<port>.
export const OID = {
  portAdminEnable: "1.3.6.1.2.1.105.1.1.1.3", // 1 = true, 2 = false (read-write)
  portDetectionStatus: "1.3.6.1.2.1.105.1.1.1.6", // 1 disabled, 2 searching, 3 deliveringPower, 4 fault, ...
  mainPsePower: "1.3.6.1.2.1.105.1.3.1.1.2", // watts available, per group
  mainPseConsumption: "1.3.6.1.2.1.105.1.3.1.1.4", // watts consumed, per group
  ifOperStatus: "1.3.6.1.2.1.2.2.1.8" // 1 up, 2 down
} as const;

export interface SnmpValue {
  oid: string;
  value: number | string | Buffer | null;
}

/** The two SNMP calls the driver needs; replaced by a fake in tests. */
export interface SnmpAccess {
  get(oids: string[]): Promise<SnmpValue[]>;
  setInteger(oid: string, value: number): Promise<void>;
  close(): void;
}

export interface SnmpSwitchOptions {
  pseGroup: number;
  poePorts: number;
  portPowerOid?: string | undefined;
  portPowerScale?: number | undefined;
}

export function detectionToStatus(code: number | null): PoeStatus {
  switch (code) {
    case 1:
      return "disabled";
    case 2:
      return "searching";
    case 3:
      return "delivering";
    case 4:
    case 6:
      return "fault";
    default:
      return "other";
  }
}

function num(value: SnmpValue["value"] | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class SnmpSwitch implements SwitchDriver {
  constructor(
    private readonly read: SnmpAccess,
    private readonly write: SnmpAccess,
    private readonly options: SnmpSwitchOptions
  ) {}

  async readAll(): Promise<{ ports: Omit<PortState, "name">[]; totals: PoeTotals }> {
    const { pseGroup, poePorts, portPowerOid } = this.options;
    const scale = this.options.portPowerScale ?? 0.001;
    const nums = Array.from({ length: poePorts }, (_, i) => i + 1);
    const oids: string[] = [
      `${OID.mainPsePower}.${pseGroup}`,
      `${OID.mainPseConsumption}.${pseGroup}`,
      ...nums.map((p) => `${OID.portAdminEnable}.${pseGroup}.${p}`),
      ...nums.map((p) => `${OID.portDetectionStatus}.${pseGroup}.${p}`),
      ...nums.map((p) => `${OID.ifOperStatus}.${p}`),
      ...(portPowerOid ? nums.map((p) => `${portPowerOid}.${p}`) : [])
    ];
    const values = new Map<string, SnmpValue["value"]>();
    // Stay well under typical PDU limits: ask in chunks.
    for (let i = 0; i < oids.length; i += 20) {
      for (const v of await this.read.get(oids.slice(i, i + 20))) values.set(v.oid.replace(/^\./, ""), v.value);
    }

    const ports = nums.map((port) => {
      const admin = num(values.get(`${OID.portAdminEnable}.${pseGroup}.${port}`));
      const status = detectionToStatus(num(values.get(`${OID.portDetectionStatus}.${pseGroup}.${port}`)));
      const oper = num(values.get(`${OID.ifOperStatus}.${port}`));
      const raw = portPowerOid ? num(values.get(`${portPowerOid}.${port}`)) : null;
      const link: LinkStatus = oper === 1 ? "up" : oper === 2 ? "down" : "unknown";
      return {
        port,
        poeEnabled: admin === 1,
        status,
        delivering: status === "delivering",
        link,
        powerW: raw === null ? null : Math.round(raw * scale * 100) / 100
      };
    });
    return {
      ports,
      totals: {
        budgetW: num(values.get(`${OID.mainPsePower}.${pseGroup}`)),
        consumedW: num(values.get(`${OID.mainPseConsumption}.${pseGroup}`))
      }
    };
  }

  async setPoeEnabled(port: number, enabled: boolean): Promise<void> {
    await this.write.setInteger(`${OID.portAdminEnable}.${this.options.pseGroup}.${port}`, enabled ? 1 : 2);
  }

  async close(): Promise<void> {
    this.read.close();
    this.write.close();
  }
}

/** net-snmp session wrapped as SnmpAccess (SNMPv2c). */
export function netSnmpAccess(host: string, port: number, community: string, timeoutMs: number): SnmpAccess {
  const session = snmp.createSession(host, community, {
    port,
    version: snmp.Version2c,
    timeout: timeoutMs,
    retries: 1
  });
  return {
    get: (oids) =>
      new Promise((resolve, reject) => {
        session.get(oids, (err: Error | null, varbinds: any[]) => {
          if (err) return reject(err);
          resolve(
            varbinds.map((vb) => ({
              oid: String(vb.oid),
              // noSuchObject / noSuchInstance / endOfMibView come back as error varbinds: treat as missing
              value: snmp.isVarbindError(vb) ? null : typeof vb.value === "number" ? vb.value : vb.value
            }))
          );
        });
      }),
    setInteger: (oid, value) =>
      new Promise((resolve, reject) => {
        session.set([{ oid, type: snmp.ObjectType.Integer, value }], (err: Error | null, varbinds: any[]) => {
          if (err) return reject(err);
          const bad = varbinds.find((vb) => snmp.isVarbindError(vb));
          if (bad) return reject(new Error(snmp.varbindError(bad)));
          resolve();
        });
      }),
    close: () => session.close()
  };
}
