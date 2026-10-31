import { and, eq } from 'drizzle-orm';
import { db, execute, markDirty, selectAll, selectOne } from '../connection';
import { getSchema, type NewProjectMember, type ProjectMember } from '../schema';
import type { PublicUser } from './users';

function tables() {
  return getSchema();
}

export const projectMembersRepo = {
  async findByProjectAndUser(projectId: string, userId: string): Promise<ProjectMember | undefined> {
    const { projectMembers } = tables();
    return selectOne(
      db()
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    );
  },

  async listByUser(userId: string): Promise<ProjectMember[]> {
    const { projectMembers } = tables();
    return selectAll(db().select().from(projectMembers).where(eq(projectMembers.userId, userId)));
  },

  async grant(projectId: string, userId: string, role = 'member'): Promise<void> {
    const { projectMembers } = tables();
    const existing = await this.findByProjectAndUser(projectId, userId);
    if (existing) {
      await execute(
        db()
          .update(projectMembers)
          .set({ role })
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      );
      markDirty();
      return;
    }

    const row: NewProjectMember = {
      projectId,
      userId,
      role,
      createdAt: new Date(),
    };
    await execute(db().insert(projectMembers).values(row));
    markDirty();
  },

  async revoke(projectId: string, userId: string): Promise<void> {
    const { projectMembers } = tables();
    await execute(
      db().delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    );
    markDirty();
  },

  async replaceForUser(userId: string, projectIds: string[]): Promise<void> {
    const { projectMembers } = tables();
    const uniqueProjectIds = [...new Set(projectIds)];
    await execute(db().delete(projectMembers).where(eq(projectMembers.userId, userId)));
    for (const projectId of uniqueProjectIds) {
      await execute(
        db().insert(projectMembers).values({
          projectId,
          userId,
          role: 'member',
          createdAt: new Date(),
        })
      );
    }
    markDirty();
  },

  async canAccessProject(user: Pick<PublicUser, 'id' | 'role' | 'accessAllProjects'>, projectId: string): Promise<boolean> {
    if (user.role === 'admin' || user.accessAllProjects) {
      return true;
    }

    const member = await this.findByProjectAndUser(projectId, user.id);
    return !!member;
  },
};