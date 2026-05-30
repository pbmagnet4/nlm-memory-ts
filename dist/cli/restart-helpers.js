/**
 * Pure planning helpers for `nlm restart`.
 *
 * `npm i -g nlm-memory@latest` swaps the binary on disk but the running
 * daemon stays in memory on the old code (launchd KeepAlive doesn't notice
 * the swap). `nlm restart` closes that gap. The planning logic is split
 * out here so it can be unit-tested without spawning launchctl/systemctl.
 */
/**
 * Pattern fed to `pkill -f` when no managed unit owns the daemon. Must
 * match the daemon's entry-point invocation but NOT the `nlm restart`
 * command running pkill — otherwise pkill would kill its own caller
 * before the replacement is spawned.
 */
export const DAEMON_PKILL_PATTERN = "nlm\\.(js|ts) start";
export function planRestart(ctx) {
    if (ctx.platform === "darwin") {
        if (ctx.uid === undefined) {
            return { kind: "unsupported", reason: "could not determine UID" };
        }
        if (ctx.agentLoaded) {
            return { kind: "launchctl-kickstart", uid: ctx.uid, label: ctx.label };
        }
        if (ctx.plistExists) {
            return { kind: "launchctl-bootstrap", uid: ctx.uid, plist: ctx.plistPath };
        }
        return { kind: "pkill-respawn" };
    }
    if (ctx.platform === "linux") {
        if (ctx.systemdAvailable && ctx.unitFileExists) {
            return { kind: "systemctl-restart", unit: ctx.unitName };
        }
        return { kind: "pkill-respawn" };
    }
    return { kind: "unsupported", reason: `platform ${ctx.platform} not supported` };
}
//# sourceMappingURL=restart-helpers.js.map