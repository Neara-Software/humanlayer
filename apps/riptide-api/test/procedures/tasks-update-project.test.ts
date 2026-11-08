import { organizations } from '@humanlayer/db/tables/organizations'
import { projects } from '@humanlayer/db/tables/projects'
import { taskUserAcl } from '@humanlayer/db/tables/task-user-acl'
import { tasks } from '@humanlayer/db/tables/tasks'
import { workspaces } from '@humanlayer/db/tables/workspaces'
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { updateTaskProcedure } from '../../src/orpc/api/tasks/update'
import { createMockApiAuth, createMockApiContext } from '../mocks'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

describe('tasks.update — projectId', async () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase
	let organizationId: string
	let otherOrganizationId: string
	const workosOrganizationId = 'org_move_project_test'
	const owner = 'user_move_owner'
	const editor = 'user_move_editor'
	const outsider = 'user_move_outsider'

	beforeAll(async () => {
		const testDb = await createTestDb('tasks_update_project')
		cleanupTestDb = testDb.cleanup
		db = testDb.db
		const [org, otherOrg] = await db
			.insert(organizations)
			.values([
				{ name: 'move project org', workos_organization_id: workosOrganizationId },
				{ name: 'other org', workos_organization_id: 'org_move_project_other' },
			])
			.returning()
		organizationId = org!.id
		otherOrganizationId = otherOrg!.id
	}, 30000)

	afterAll(async () => {
		await cleanupTestDb?.()
	})

	const project = async (overrides: Partial<typeof projects.$inferInsert> = {}) => {
		const [row] = await db
			.insert(projects)
			.values({
				organization_id: organizationId,
				name: 'project',
				created_by: owner,
				resource_owner_user_id: owner,
				repositories: [],
				...overrides,
			})
			.returning()
		return row!.id
	}
	const task = async (workspaceId: string | null = null, projectId: string | null = null) => {
		const [row] = await db
			.insert(tasks)
			.values({
				name: 'task',
				resource_owner_user_id: owner,
				created_by: owner,
				organization_id: organizationId,
				project_id: projectId,
				workspace_id: workspaceId,
			})
			.returning()
		return row!.id
	}
	const move = (userId: string, taskId: string, projectId: string | null) =>
		call(
			updateTaskProcedure,
			{ taskId, projectId },
			{
				context: createMockApiContext({
					auth: createMockApiAuth({ userId, organizationId, workosOrganizationId }),
					services: { db, dbReadReplica: db },
				}),
			},
		)
	const projectOf = async (taskId: string) =>
		(await db.select({ projectId: tasks.project_id }).from(tasks).where(eq(tasks.id, taskId)))[0]?.projectId

	test('moves a task into a project and back to Other tasks with null', async () => {
		const projectId = await project()
		const taskId = await task()
		expect((await move(owner, taskId, projectId)).success).toBe(true)
		expect(await projectOf(taskId)).toBe(projectId)
		await move(owner, taskId, null)
		expect(await projectOf(taskId)).toBeNull()
	})

	test('an editor may move the task; someone without access may not', async () => {
		const projectId = await project()
		const taskId = await task()
		await db.insert(taskUserAcl).values({
			organization_id: organizationId,
			resource_owner_user_id: owner,
			subject_user_id: editor,
			task_id: taskId,
			permission_level: 'edit',
			granted_by: owner,
		})
		await move(editor, taskId, projectId)
		expect(await projectOf(taskId)).toBe(projectId)
		await expect(move(outsider, taskId, null)).rejects.toThrow()
		expect(await projectOf(taskId)).toBe(projectId)
	})

	test('refuses archived projects, other orgs, and private projects the caller cannot read', async () => {
		const taskId = await task()
		const archived = await project({ archived: true })
		const foreign = await project({ organization_id: otherOrganizationId })
		const someoneElsesPrivate = await project({ private: true, resource_owner_user_id: outsider })
		for (const projectId of [archived, foreign, someoneElsesPrivate]) {
			await expect(move(owner, taskId, projectId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
		}
		expect(await projectOf(taskId)).toBeNull()
	})

	test('a task cannot leave the project its workspace belongs to', async () => {
		const home = await project()
		const elsewhere = await project()
		const [workspace] = await db
			.insert(workspaces)
			.values({
				organization_id: organizationId,
				project_id: home,
				name: 'ws',
				created_by: owner,
				resource_owner_user_id: owner,
				repositories: [],
			})
			.returning()
		const taskId = await task(workspace!.id, home)
		await expect(move(owner, taskId, elsewhere)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
		await expect(move(owner, taskId, null)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
		expect((await move(owner, taskId, home)).success).toBe(true)
		expect(await projectOf(taskId)).toBe(home)
	})
})
