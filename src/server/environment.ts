/** Read-only environment view for configuration readers and isolated tests. */
export type Environment = Readonly<Record<string, string | undefined>>;
