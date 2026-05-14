import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";
import {
  instanceGeneralSettingsSchema,
  type InstanceGeneralSettings,
  instanceExperimentalSettingsSchema,
  type InstanceExperimentalSettings,
  type PatchInstanceGeneralSettings,
  type InstanceSettings,
  type PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";

const DEFAULT_SINGLETON_KEY = "default";

function normalizeGeneralSettings(raw: unknown): InstanceGeneralSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  // Use passthrough so unknown JSONB fields (telegramOperatorChatId, etc.) don't cause safeParse failure
  const parsed = instanceGeneralSettingsSchema.strip().safeParse(r);
  if (parsed.success) {
    return {
      censorUsernameInLogs: parsed.data.censorUsernameInLogs ?? false,
      ...(parsed.data.eaNotificationMatrix !== undefined && { eaNotificationMatrix: parsed.data.eaNotificationMatrix }),
      ...(parsed.data.operatorNotifyEmail !== undefined && { operatorNotifyEmail: parsed.data.operatorNotifyEmail }),
    };
  }
  // Fallback: manual extraction
  return {
    censorUsernameInLogs: typeof r.censorUsernameInLogs === "boolean" ? r.censorUsernameInLogs : false,
    ...(r.eaNotificationMatrix !== undefined && { eaNotificationMatrix: r.eaNotificationMatrix as InstanceGeneralSettings["eaNotificationMatrix"] }),
    ...(r.operatorNotifyEmail !== undefined && { operatorNotifyEmail: r.operatorNotifyEmail as string }),
  };
}

function normalizeExperimentalSettings(raw: unknown): InstanceExperimentalSettings {
  const parsed = instanceExperimentalSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      enableIsolatedWorkspaces: parsed.data.enableIsolatedWorkspaces ?? false,
      autoRestartDevServerWhenIdle: parsed.data.autoRestartDevServerWhenIdle ?? false,
    };
  }
  return {
    enableIsolatedWorkspaces: false,
    autoRestartDevServerWhenIdle: false,
  };
}

function toInstanceSettings(row: typeof instanceSettings.$inferSelect): InstanceSettings {
  return {
    id: row.id,
    general: normalizeGeneralSettings(row.general),
    experimental: normalizeExperimentalSettings(row.experimental),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function instanceSettingsService(db: Db) {
  async function getOrCreateRow() {
    const existing = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const [created] = await db
      .insert(instanceSettings)
      .values({
        singletonKey: DEFAULT_SINGLETON_KEY,
        general: {},
        experimental: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          updatedAt: now,
        },
      })
      .returning();

    return created;
  }

  return {
    get: async (): Promise<InstanceSettings> => toInstanceSettings(await getOrCreateRow()),

    getGeneral: async (): Promise<InstanceGeneralSettings> => {
      const row = await getOrCreateRow();
      return normalizeGeneralSettings(row.general);
    },

    getExperimental: async (): Promise<InstanceExperimentalSettings> => {
      const row = await getOrCreateRow();
      return normalizeExperimentalSettings(row.experimental);
    },

    updateGeneral: async (patch: PatchInstanceGeneralSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      // Raw-merge preserves unknown JSONB fields (e.g. telegramOperatorChatId, founderProfile)
      const rawMerged = {
        ...((current.general as Record<string, unknown>) ?? {}),
        ...patch,
      };
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          general: rawMerged,
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    updateExperimental: async (patch: PatchInstanceExperimentalSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextExperimental = normalizeExperimentalSettings({
        ...normalizeExperimentalSettings(current.experimental),
        ...patch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          experimental: { ...nextExperimental },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    listCompanyIds: async (): Promise<string[]> =>
      db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id)),
  };
}
