// Stats API contract (AD-6). Response shape for GET /api/stats plus the stable error
// codes the endpoint emits. No links in this contract → does NOT import linkRefine.
import { z } from 'zod';

/** One KPI tile: fixed key/order `resources · channels · authors · queries` (D3). */
export const StatsKpiSchema = z.object({
  key: z.enum(['resources', 'channels', 'authors', 'queries']),
  label: z.string().min(1),
  value: z.number().int().min(0),
  sub: z.string(),
});

export type StatsKpi = z.infer<typeof StatsKpiSchema>;

/** One day of the 14-day indexing activity series (D5 — zero-filled in the service). */
export const StatsActivityPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  count: z.number().int().min(0),
});

export type StatsActivityPoint = z.infer<typeof StatsActivityPointSchema>;

/** One per-channel volume row, ordered `count DESC, channelId ASC` (D7). */
export const StatsChannelSchema = z.object({
  channelId: z.string().min(1),
  channelName: z.string(),
  count: z.number().int().min(0),
});

export type StatsChannel = z.infer<typeof StatsChannelSchema>;

/** Personal read coverage over the caller's scoped resources (AC5). */
export const StatsCoverageSchema = z.object({
  readCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
  readPct: z.number().int().min(0).max(100),
});

export type StatsCoverage = z.infer<typeof StatsCoverageSchema>;

/** One row of the top-5-most-active-users block, ordered `count DESC, authorId ASC` (D3). */
export const StatsTopUserSchema = z.object({
  authorId: z.string().min(1),
  authorName: z.string().min(1),
  count: z.number().int().min(1),
});

export type StatsTopUser = z.infer<typeof StatsTopUserSchema>;

/** The 4 KPIs in their fixed, contractual order (D3). Consumers may index positionally. */
export const KPI_ORDER = ['resources', 'channels', 'authors', 'queries'] as const;

/** GET /api/stats — RBAC-scoped knowledge KPIs, activity, channel volume, and coverage. */
export const StatsResponseSchema = z.object({
  // `.length(4)` + `superRefine` pin both the count AND the fixed key order (AC1):
  // a per-item `z.enum` alone would let `[resources,resources,resources,resources]`
  // or a reordered array pass. The service is the sole producer, but the contract
  // (AD-6) is the safety net 9.2 relies on.
  kpis: z
    .array(StatsKpiSchema)
    .length(4)
    .superRefine((kpis, ctx) => {
      KPI_ORDER.forEach((key, i) => {
        if (kpis[i]?.key !== key) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'key'],
            message: `Expected kpis[${i}].key to be '${key}' (fixed order resources·channels·authors·queries)`,
          });
        }
      });
    }),
  activity: z.array(StatsActivityPointSchema).length(14),
  channels: z.array(StatsChannelSchema),
  coverage: StatsCoverageSchema,
  // `.max(5)` + `superRefine` pin the `count DESC, authorId ASC` ordering (D3): the
  // service is the sole producer, but the contract (AD-6) is 9.2's safety net, same
  // precedent as the KPI order pin above (P3).
  topUsers: z
    .array(StatsTopUserSchema)
    .max(5)
    .superRefine((rows, ctx) => {
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const curr = rows[i];
        if (!prev || !curr) continue;
        const outOfOrder =
          curr.count > prev.count || (curr.count === prev.count && curr.authorId <= prev.authorId);
        if (outOfOrder) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i],
            message: `Expected topUsers[${i}] to sort after topUsers[${i - 1}] by count DESC, authorId ASC`,
          });
        }
      }
    }),
});

export type StatsResponse = z.infer<typeof StatsResponseSchema>;

/** Stable error `code`s emitted by the stats endpoint (paired with ErrorSchema). */
export const STATS_ERROR = {
  INTERNAL: 'INTERNAL',
} as const;

export type StatsErrorCode = (typeof STATS_ERROR)[keyof typeof STATS_ERROR];
