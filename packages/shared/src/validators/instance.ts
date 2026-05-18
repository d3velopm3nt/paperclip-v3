import { z } from "zod";

export const founderProfileSchema = z.object({
  name: z.string().default(""),
  personalCompanyId: z.string().uuid().nullable().default(null),
});

export type FounderProfile = z.infer<typeof founderProfileSchema>;

const eaNotificationChannelConfigSchema = z.object({
  high_risk_detected: z.boolean().default(false),
  approval_required: z.boolean().default(false),
  new_lead_created: z.boolean().default(false),
  proposal_request_detected: z.boolean().default(false),
  agent_blocked: z.boolean().default(false),
  topic_created: z.boolean().default(false),
  issue_created: z.boolean().default(false),
  urgent_item_detected: z.boolean().default(false),
  thread_reply_received: z.boolean().default(false),
});

export type EaNotificationChannelConfig = z.infer<typeof eaNotificationChannelConfigSchema>;
export type EaNotificationEvent = keyof EaNotificationChannelConfig;

const eaNotificationMatrixSchema = z.object({
  telegram: eaNotificationChannelConfigSchema.default({}),
  email: eaNotificationChannelConfigSchema.default({}),
});

export type EaNotificationMatrix = z.infer<typeof eaNotificationMatrixSchema>;

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  founderProfile: founderProfileSchema.optional(),
  eaNotificationMatrix: eaNotificationMatrixSchema.optional(),
  operatorNotifyEmail: z.string().optional(),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableIsolatedWorkspaces: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
