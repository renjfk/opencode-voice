// OpenCode v2 TUI plugin definition.
import { setupPlugin } from "./plugin.ts";
import type { HostContext } from "./host.ts";

const plugin = {
  id: "opencode-voice",
  async setup(ctx: HostContext): Promise<() => Promise<void>> {
    const handle = await setupPlugin(ctx);
    return () => handle.dispose();
  },
};

export default plugin;
