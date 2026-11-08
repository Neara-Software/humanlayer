import { onlineHosts } from '@humanlayer/db/tables/online-hosts'
import { organizations } from '@humanlayer/db/tables/organizations'
import { projects } from '@humanlayer/db/tables/projects'
import { repositoryLocationsForUserForHost } from '@humanlayer/db/tables/repository-locations-for-user-for-host'
import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import { userSettings } from '@humanlayer/db/tables/user-settings'
import { workspaces } from '@humanlayer/db/tables/workspaces'
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createSessionV2Procedure as liveCreateSessionV2 } from '../../src/orpc/api/sessions/v2/create.effect'
import { createTaskWorkspaceV2Procedure as liveCreateWorkspace } from '../../src/orpc/api/tasks/v2/create-workspace.effect'
import { createMockApiContext, createMockStripeService, createMockWorkosService } from '../mocks'
import { bindProcedureToRuntime, createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

const repository = {
	remoteUrl: 'git@github.com:humanlayer/syncopate.git',
	repositoryIdentity: 'github.com/humanlayer/syncopate',
	defaultBranch: 'main',
	branch: 'main',
	default: true as const,
	autoPushBranch: false,
	copyGlobs: [] as string[],
}

describe('tasks v2 createWorkspace', () => {
	let db: PostgresJsDatabase
	let cleanup: (() => Promise<void>) | undefined
	let runtime: ReturnType<typeof createRuntimeWithTestPostgresLayer> | undefined
	let createWorkspace: typeof liveCreateWorkspace
	let createSessionV2: typeof liveCreateSessionV2
	const services = {
		workos: createMockWorkosService(),
		stripe: createMockStripeService(),
		get db() {
			return db
		},
		get dbReadReplica() {
			return db
		},
	}

	beforeAll(async () => {
		const testDb = await createTestDb('tasks-v2-create-workspace')
		db = testDb.db
		cleanup = testDb.cleanup
		runtime = createRuntimeWithTestPostgresLayer(db)
		createWorkspace = bindProcedureToRuntime(liveCreateWorkspace, runtime)
		createSessionV2 = bindProcedureToRuntime(liveCreateSessionV2, runtime)
	}, 60_000)

	afterAll(async () => {
		await runtime?.dispose()
		await cleanup?.()
	}, 30_000)

	/** A task moved into a project: project_id set, no workspace. */
	async function setup(projectOverrides: Partial<typeof projects.$inferInsert> = {}) {
		const organizationId = uuidv7()
		const userId = `user-${uuidv7()}`
		const hostId = `host-${uuidv7()}`
		const projectId = uuidv7()
		const taskId = uuidv7()
		await db
			.insert(organizations)
			.values({ id: organizationId, name: 'Workspace test', workos_organization_id: `workos-${organizationId}` })
		await db
			.insert(userSettings)
			.values({ organization_id: organizationId, user_id: userId, projects_v2_enabled: true })
		await db
			.insert(onlineHosts)
			.values({ organization_id: organizationId, user_id: userId, host_id: hostId, status: 'online' })
		await db.insert(projects).values({
			id: projectId,
			organization_id: organizationId,
			name: 'Test project',
			created_by: userId,
			resource_owner_user_id: userId,
			repositories: [repository],
			...projectOverrides,
		})
		await db.insert(repositoryLocationsForUserForHost).values({
			organization_id: organizationId,
			user_id: userId,
			host_id: hostId,
			repository_identity: repository.repositoryIdentity,
			source_kind: 'filesystem',
			source_path: '/home/user/projects/syncopate',
		})
		await db.insert(tasks).values({
			id: taskId,
			organization_id: organizationId,
			project_id: projectId,
			name: 'Moved task',
			slug: 'moved-task',
			created_by: userId,
			resource_owner_user_id: userId,
			default_working_directory: '/somewhere/else',
		})
		const context = (asUser = userId) =>
			createMockApiContext({
				auth: {
					userId: asUser,
					organizationId,
					workosOrganizationId: `workos-${organizationId}`,
					role: '',
					roles: [],
					permissions: [],
					entitlements: [],
					sessionId: 'session',
				},
				services,
			})
		return { hostId, projectId, taskId, context }
	}

	const input = (taskId: string) => ({
		taskId,
		workspaceId: taskId,
		repositories: [{ ...repository, branch: 'tom/moved-task' }],
	})

	test('gives the task a workspace once, and its sessions launch in it', async () => {
		const actor = await setup()
		const first = await call(createWorkspace, input(actor.taskId), { context: actor.context() })
		expect(first.result).toBe('created')
		const again = await call(
			createWorkspace,
			{ ...input(actor.taskId), workspaceId: uuidv7() },
			{
				context: actor.context(),
			},
		)
		expect(again).toMatchObject({ result: 'already-exists', workspaceId: actor.taskId })

		const [task] = await db.select().from(tasks).where(eq(tasks.id, actor.taskId))
		expect(task).toMatchObject({
			workspace_id: actor.taskId,
			default_working_directory: '~/.humanlayer/workspaces/moved-task',
			worktree_timing: 'now',
		})
		const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, actor.taskId))
		expect(workspace).toMatchObject({ project_id: actor.projectId, name: 'Moved task' })

		const session = await call(
			createSessionV2,
			{
				taskId: actor.taskId,
				workspaceId: actor.taskId,
				title: 'first',
				text: 'go',
				hostId: actor.hostId,
				codingAgent: 'claude' as const,
				provider: 'anthropic',
				model: 'opus',
				permissionsMode: 'default' as const,
			},
			{ context: actor.context() },
		)
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.sessionId))
		expect(row?.working_directory).toBe('~/.humanlayer/workspaces/moved-task')
	})

	test('refuses without edit access or with an archived project, and changes nothing', async () => {
		const actor = await setup()
		await expect(
			call(createWorkspace, input(actor.taskId), { context: actor.context(`user-${uuidv7()}`) }),
		).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })

		const archived = await setup({ archived: true })
		await expect(
			call(createWorkspace, input(archived.taskId), { context: archived.context() }),
		).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })

		const rows = await db.select().from(workspaces).where(eq(workspaces.id, archived.taskId))
		expect(rows).toHaveLength(0)
	})
})
