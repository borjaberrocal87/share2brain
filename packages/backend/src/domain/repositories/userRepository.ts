// Domain port: persistence contract for application users. Pure — no Drizzle,
// no SQL. The Drizzle implementation lives in infrastructure/ and satisfies this
// interface, so the application layer depends only on the contract (AD-2 spirit,
// backend-standards §Layered Architecture).

/** A user's persisted profile as the domain cares about it. */
export interface UserProfile {
  id: string;
  discordId: string;
  username: string;
  avatar: string | null;
}

export interface UserRepository {
  /**
   * Insert the user, or update `username`/`avatar` if a row with the same
   * `discordId` already exists. Idempotent by design (a repeated OAuth login
   * must not create duplicates). Returns the stable app-side user id.
   */
  upsertByDiscordId(user: {
    discordId: string;
    username: string;
    avatar: string | null;
  }): Promise<{ id: string }>;

  /** Look up a user by app-side id, or `null` if none exists. */
  findById(id: string): Promise<UserProfile | null>;
}
