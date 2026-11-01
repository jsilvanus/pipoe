import type { PoeTotals, PortState, SwitchDriver } from "./types.js";

/** A stateful fake switch for development and tests. Devices draw power only while PoE is on. */
export class SimulatedSwitch implements SwitchDriver {
  private readonly enabled: boolean[];
  private readonly connected: Set<number>;

  constructor(
    private readonly portCount = 16,
    connectedPorts: number[] = [1, 2]
  ) {
    this.enabled = Array.from({ length: portCount }, () => true);
    this.connected = new Set(connectedPorts);
  }

  async readAll(): Promise<{ ports: Omit<PortState, "name">[]; totals: PoeTotals }> {
    const ports: Omit<PortState, "name">[] = this.enabled.map((poeEnabled, i) => {
      const port = i + 1;
      const delivering = poeEnabled && this.connected.has(port);
      return {
        port,
        poeEnabled,
        status: !poeEnabled ? "disabled" : delivering ? "delivering" : "searching",
        delivering,
        link: delivering ? "up" : "down",
        powerW: delivering ? 8.5 : 0
      };
    });
    const consumedW = ports.reduce((sum, p) => sum + (p.powerW ?? 0), 0);
    return { ports, totals: { budgetW: 240, consumedW } };
  }

  async setPoeEnabled(port: number, enabled: boolean): Promise<void> {
    if (port < 1 || port > this.portCount) throw new Error(`No port ${port}`);
    this.enabled[port - 1] = enabled;
  }

  async close(): Promise<void> {}
}
