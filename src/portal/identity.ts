/** No MCP port or recorder may start until the parent binds this Zalo UID. */
export function confirmPortalIdentity(uid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); process.off("message", onMessage); process.off("disconnect", onDisconnect); };
    const onMessage = (message: { type?: string }) => {
      if (message.type !== "identity-accepted") return;
      cleanup(); resolve();
    };
    const onDisconnect = () => { cleanup(); reject(new Error("Portal disconnected before account verification")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Account verification timeout")); }, 10000);
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    if (!process.send || !process.connected) return onDisconnect();
    process.send({ type: "identity", uid });
  });
}
