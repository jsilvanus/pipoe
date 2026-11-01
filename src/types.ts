export type PoeStatus = "delivering" | "searching" | "disabled" | "fault" | "other";
export type LinkStatus = "up" | "down" | "unknown";

export interface PortState {
  port: number;
  name?: string | undefined;
  /** PoE administratively enabled on the port. */
  poeEnabled: boolean;
  status: PoeStatus;
  /** True when the switch reports that it is delivering power. */
  delivering: boolean;
  link: LinkStatus;
  /** Power drawn by the device, if the switch reports it. */
  powerW: number | null;
}

export interface PoeTotals {
  /** Watts the switch can deliver in total, if reported. */
  budgetW: number | null;
  /** Watts currently consumed by all ports, if reported. */
  consumedW: number | null;
}

export interface SwitchSnapshot {
  ports: PortState[];
  totals: PoeTotals;
}

/** Low-level access to one switch. Ports are numbered like the front panel (1..n). */
export interface SwitchDriver {
  readAll(): Promise<{ ports: Omit<PortState, "name">[]; totals: PoeTotals }>;
  setPoeEnabled(port: number, enabled: boolean): Promise<void>;
  close(): Promise<void>;
}

export class PoeError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}
