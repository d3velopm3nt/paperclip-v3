import { api } from "./client";

export interface Room {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string | null;
  requireApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoomMember {
  id: string;
  roomId: string;
  agentId: string | null;
  isOperator: boolean;
  notifyOnMessage: boolean;
}

export interface RoomDetail extends Room {
  members: RoomMember[];
}

export interface OperatorMessage {
  id: string;
  companyId: string;
  roomId: string | null;
  issueId: string | null;
  direction: "inbound" | "outbound";
  platform: string;
  fromAgentId: string | null;
  body: string;
  createdAt: string;
}

export const roomsApi = {
  list: (companyId: string) => api.get<Room[]>(`/companies/${companyId}/rooms`),

  create: (
    companyId: string,
    data: { name: string; slug: string; description?: string; requireApproval?: boolean },
  ) => api.post<Room>(`/companies/${companyId}/rooms`, data),

  get: (id: string) => api.get<RoomDetail>(`/rooms/${id}`),

  update: (
    id: string,
    data: Partial<{ name: string; slug: string; description: string; requireApproval: boolean }>,
  ) => api.patch<Room>(`/rooms/${id}`, data),

  delete: (id: string) => api.delete(`/rooms/${id}`),

  addMember: (roomId: string, data: { agentId?: string; isOperator?: boolean }) =>
    api.post<RoomMember>(`/rooms/${roomId}/members`, data),

  removeMember: (roomId: string, memberId: string) =>
    api.delete(`/rooms/${roomId}/members/${memberId}`),

  getMessages: (roomId: string) => api.get<OperatorMessage[]>(`/rooms/${roomId}/messages`),
};
