export function getServerAuthProfile(config) {
  if (config.server.transport === "stdio") {
    return {
      transport: "stdio",
      active: false,
      mode: "none",
      note:
        "Local stdio MCP relies on local process trust. Any future remote transport must add bearer or gateway auth in front of the MCP server.",
    };
  }

  return {
    transport: config.server.transport,
    active: config.remoteAuth.mode !== "none",
    mode: config.remoteAuth.mode,
    tokenHeader: config.remoteAuth.tokenHeader,
    principalHeader: config.remoteAuth.principalHeader,
    signatureHeader: config.remoteAuth.signatureHeader,
    sharedSecretConfigured: Boolean(config.remoteAuth.sharedSecret),
    maxSkewSeconds: config.remoteAuth.maxSkewSeconds,
    requiredScopes: config.remoteAuth.requiredScopes,
    note:
      "Remote MCP auth is scaffolded in config. Wire the selected mode into the transport or gateway before exposing this server outside local development.",
  };
}
