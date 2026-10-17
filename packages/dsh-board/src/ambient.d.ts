/**
 * Ambient declarations for peer bundles that are present only in a dsh
 * profile's node_modules, not in this workspace. Runtime shapes are narrowed
 * at the call site in board.ts (`as unknown as { ... }`), so these stay loose.
 */

declare module 'dsh-arkiv/arkiv' {
  export const ArkivBackend: unknown
}

declare module 'dsh-haven-aol' {
  export const AolRuntime: unknown
}

declare module 'dsh-wallet' {}
