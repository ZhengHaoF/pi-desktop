export type TerminalControlOpen = (takeover: boolean) => Promise<string | undefined>;

export async function runTerminalControlFlow(options: {
  confirmInitial: () => boolean | Promise<boolean>;
  confirmTakeover: () => boolean | Promise<boolean>;
  openControl: TerminalControlOpen;
  restoreObserve: () => Promise<unknown>;
  onBusy?: () => void;
}): Promise<"cancelled" | "opened" | "failed"> {
  if (!(await options.confirmInitial())) return "cancelled";
  const result = await options.openControl(false);
  if (result !== "HERDR_TERMINAL_BUSY") return result ? "failed" : "opened";
  options.onBusy?.();
  if (!(await options.confirmTakeover())) {
    await options.restoreObserve();
    return "cancelled";
  }
  return (await options.openControl(true)) ? "failed" : "opened";
}
