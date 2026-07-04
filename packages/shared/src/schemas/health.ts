// Health check contract (AD-6). `GET /health` is auth-exempt and lives at the
// top level (not under /api/). The response shape is defined here in shared and
// validated by the backend before sending — never hand-written in the service.
import { z } from 'zod';

/** A dependency is reachable, unreachable, or not yet reporting readiness. */
export const ComponentStatusSchema = z.enum(['connected', 'disconnected', 'pending']);

export type ComponentStatus = z.infer<typeof ComponentStatusSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded']),
  components: z.object({
    // Gating dependencies: their state decides healthy vs degraded.
    database: z.enum(['connected', 'disconnected']),
    redis: z.enum(['connected', 'disconnected']),
    // Non-gating for now: Bot/Workers don't report readiness until Epic 3, so
    // these stay "pending" and never flip the overall status.
    discord: ComponentStatusSchema,
    indexer: ComponentStatusSchema,
  }),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
