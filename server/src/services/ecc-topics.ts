import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { eccTopicIssues, eccTopics, issues } from "@paperclipai/db";

export interface TopicRow {
  id: string;
  name: string;
  summary: string;
  currentState: string | null;
  companyId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  issueCount: number;
}

export interface LinkedIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  companyId: string;
}

export interface TopicWithIssues extends Omit<TopicRow, "issueCount"> {
  issues: LinkedIssue[];
}

export function eccTopicsService(db: Db) {
  async function list(statusFilter?: string): Promise<TopicRow[]> {
    const q = db
      .select({
        id: eccTopics.id,
        name: eccTopics.name,
        summary: eccTopics.summary,
        currentState: eccTopics.currentState,
        companyId: eccTopics.companyId,
        status: eccTopics.status,
        createdAt: eccTopics.createdAt,
        updatedAt: eccTopics.updatedAt,
        issueCount: sql<number>`count(${eccTopicIssues.id})::int`,
      })
      .from(eccTopics)
      .leftJoin(eccTopicIssues, eq(eccTopicIssues.topicId, eccTopics.id))
      .groupBy(eccTopics.id)
      .orderBy(desc(eccTopics.updatedAt));

    if (statusFilter) {
      return q.where(eq(eccTopics.status, statusFilter));
    }
    return q;
  }

  async function getById(id: string): Promise<TopicWithIssues | null> {
    const rows = await db
      .select()
      .from(eccTopics)
      .where(eq(eccTopics.id, id))
      .limit(1);
    const topic = rows[0];
    if (!topic) return null;

    const linkedIssues = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        companyId: issues.companyId,
      })
      .from(eccTopicIssues)
      .innerJoin(issues, eq(issues.id, eccTopicIssues.issueId))
      .where(eq(eccTopicIssues.topicId, id))
      .orderBy(asc(eccTopicIssues.createdAt));

    return { ...topic, issues: linkedIssues };
  }

  async function create(data: { name: string; companyId?: string | null }): Promise<TopicRow> {
    const [row] = await db
      .insert(eccTopics)
      .values({ name: data.name, companyId: data.companyId ?? null })
      .returning();
    return { ...row!, issueCount: 0 };
  }

  async function update(
    id: string,
    data: {
      name?: string;
      summary?: string;
      currentState?: string | null;
      status?: string;
      companyId?: string | null;
    },
  ): Promise<TopicRow | null> {
    const [row] = await db
      .update(eccTopics)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(eccTopics.id, id))
      .returning();
    if (!row) return null;
    return { ...row, issueCount: 0 };
  }

  async function remove(id: string): Promise<boolean> {
    const result = await db
      .delete(eccTopics)
      .where(eq(eccTopics.id, id))
      .returning({ id: eccTopics.id });
    return result.length > 0;
  }

  async function linkIssue(topicId: string, issueId: string): Promise<void> {
    await db
      .insert(eccTopicIssues)
      .values({ topicId, issueId })
      .onConflictDoNothing();
  }

  async function unlinkIssue(topicId: string, issueId: string): Promise<void> {
    await db
      .delete(eccTopicIssues)
      .where(and(eq(eccTopicIssues.topicId, topicId), eq(eccTopicIssues.issueId, issueId)));
  }

  return { list, getById, create, update, remove, linkIssue, unlinkIssue };
}
