export interface EaNotificationChannelConfig {
  high_risk_detected: boolean;
  approval_required: boolean;
  new_lead_created: boolean;
  proposal_request_detected: boolean;
  agent_blocked: boolean;
  topic_created: boolean;
  issue_created: boolean;
  urgent_item_detected: boolean;
  thread_reply_received: boolean;
}

export interface EaNotificationMatrix {
  telegram: EaNotificationChannelConfig;
  email: EaNotificationChannelConfig;
}

export type EaNotificationEvent = keyof EaNotificationChannelConfig;

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  eaNotificationMatrix?: EaNotificationMatrix;
  operatorNotifyEmail?: string;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
