export type WindowKey = string

declare module 'claude-code' {
  interface PluginState {
    // The 5-hour window (by its reset time) this session already compacted for.
    'quota-compact': { doneFor: WindowKey | null }
  }
}
