import { PoeError, type PortState, type SwitchDriver, type SwitchSnapshot } from "./types.js";

export interface PoeServiceOptions {
  driver: SwitchDriver;
  portNames: Record<string, number>;
  poePorts: number;
  allowUnlisted?: boolean | undefined;
  /** How long a cycle waits after switching off before switching on again. */
  defaultOffMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export const MIN_OFF_MS = 1000;
export const MAX_OFF_MS = 60000;

export class PoeService {
  private readonly names = new Map<number, string>();
  private readonly busy = new Set<number>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: PoeServiceOptions) {
    for (const [name, port] of Object.entries(options.portNames)) this.names.set(port, name);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Accepts a port number ("5") or a configured name ("cam1"). */
  resolvePort(ref: string): number {
    if (/^\d+$/.test(ref)) {
      const port = Number.parseInt(ref, 10);
      if (port < 1 || port > this.options.poePorts) throw new PoeError(404, `No PoE port ${port} (1-${this.options.poePorts})`);
      return port;
    }
    const port = this.options.portNames[ref.toLowerCase()];
    if (port === undefined) throw new PoeError(404, `Unknown port name '${ref}'`);
    return port;
  }

  async list(): Promise<SwitchSnapshot> {
    const snap = await this.read();
    return snap;
  }

  async get(ref: string): Promise<PortState> {
    const port = this.resolvePort(ref);
    const snap = await this.read();
    const found = snap.ports.find((p) => p.port === port);
    if (!found) throw new PoeError(404, `No PoE port ${port}`);
    return found;
  }

  async setPower(ref: string, enabled: boolean): Promise<PortState> {
    const port = this.resolveWritable(ref);
    this.lock(port);
    try {
      await this.options.driver.setPoeEnabled(port, enabled);
      return await this.verify(port, enabled);
    } finally {
      this.busy.delete(port);
    }
  }

  /** Switch PoE off, wait, switch on. The port stays locked meanwhile. */
  async cycle(ref: string, offMs?: number): Promise<PortState> {
    const port = this.resolveWritable(ref);
    const wait = Math.min(MAX_OFF_MS, Math.max(MIN_OFF_MS, offMs ?? this.options.defaultOffMs ?? 5000));
    this.lock(port);
    try {
      await this.options.driver.setPoeEnabled(port, false);
      await this.verify(port, false);
      await this.sleep(wait);
      await this.options.driver.setPoeEnabled(port, true);
      return await this.verify(port, true);
    } catch (err) {
      // Never leave a device unpowered because a cycle failed halfway.
      await this.options.driver.setPoeEnabled(port, true).catch(() => undefined);
      throw err;
    } finally {
      this.busy.delete(port);
    }
  }

  async close(): Promise<void> {
    await this.options.driver.close();
  }

  private async read(): Promise<SwitchSnapshot> {
    try {
      const raw = await this.options.driver.readAll();
      return {
        ports: raw.ports.map((p) => ({ ...p, name: this.names.get(p.port) })),
        totals: raw.totals
      };
    } catch (err) {
      throw new PoeError(502, `Switch unreachable: ${(err as Error).message}`);
    }
  }

  private resolveWritable(ref: string): number {
    const port = this.resolvePort(ref);
    if (!this.names.has(port) && !this.options.allowUnlisted) {
      throw new PoeError(403, `Port ${port} has no name in PIPOE_PORT_NAMES; refusing to switch it`);
    }
    return port;
  }

  private lock(port: number): void {
    if (this.busy.has(port)) throw new PoeError(409, `Port ${port} is busy (another switch or cycle is running)`);
    this.busy.add(port);
  }

  private async verify(port: number, enabled: boolean): Promise<PortState> {
    const state = (await this.read()).ports.find((p) => p.port === port);
    if (!state) throw new PoeError(502, `Port ${port} missing from switch answer`);
    if (state.poeEnabled !== enabled) {
      throw new PoeError(502, `Switch did not apply PoE ${enabled ? "on" : "off"} on port ${port} (is the write community set?)`);
    }
    return state;
  }
}
