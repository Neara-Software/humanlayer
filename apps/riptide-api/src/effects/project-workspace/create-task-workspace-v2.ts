import { tasks } from '@humanlayer/db/tables/tasks'
import type { CreateTaskWorkspaceV2Input } from '@humanlayer/riptide-api-contract/api/tasks/v2/create-workspace'
import {
	resolveTaskWorkspacePathSegment,
	taskWorkspaceRoot,
	taskWorkspaceSessionDirectory,
} from '@humanlayer/riptide-api-contract/lib/task-workspace-path'
import { hasRepositoryUrlCredentials } from '@humanlayer/schemas/effect/project-workspace'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'

import { checkTaskWritePermission } from '../../db/task-auth'
import { getTransactionId } from '../services/postgres/helpers'
import { PostgresDb } from '../services/postgres/postgres-db.service'
import {
	readWorkspaceProject,
	insertWorkspace,
	requireProjectsV2Enabled,
	withDefaultRepository,
} from './create-task-v2'
import { ProjectLocationInvalid, ProjectMutationForbidden, ProjectNotFound } from './errors'
import type { ProjectActorContext } from './project-operations'

/** See `createTaskWorkspaceV2Contract`. */
export const createTaskWorkspaceV2 = Effect.fn('project_workspace.create_task_workspace_v2')(function* (
	input: CreateTaskWorkspaceV2Input & { readonly actor: ProjectActorContext },
) {
	if (input.repositories.some((repository) => hasRepositoryUrlCredentials(repository.remoteUrl))) {
		return yield* new ProjectLocationInvalid({ message: 'Repository URLs must not contain embedded credentials' })
	}
	const postgres = yield* PostgresDb
	return yield* postgres.transaction((transaction) =>
		Effect.gen(function* () {
			yield* requireProjectsV2Enabled(transaction, input.actor)
			// Locks the task row, so two first launches make one workspace.
			const access = yield* transaction.run(() =>
				checkTaskWritePermission(
					transaction.client,
					input.taskId,
					input.actor.userId,
					input.actor.organizationId,
				),
			)
			if (!access.ok) {
				if (access.reason === 'not_found') return yield* new ProjectNotFound({ projectId: input.taskId })
				return yield* new ProjectMutationForbidden({ projectId: input.taskId })
			}
			const [task] = yield* transaction.query(
				transaction.client
					.select({
						name: tasks.name,
						slug: tasks.slug,
						projectId: tasks.project_id,
						workspaceId: tasks.workspace_id,
						ownerUserId: tasks.resource_owner_user_id,
					})
					.from(tasks)
					.where(eq(tasks.id, input.taskId)),
			)
			if (!task) return yield* new ProjectNotFound({ projectId: input.taskId })
			if (task.workspaceId) {
				const transactionId = yield* getTransactionId(transaction)
				return { result: 'already-exists' as const, transactionId, workspaceId: task.workspaceId }
			}
			if (!task.projectId) return yield* new ProjectLocationInvalid({ message: 'The task is not in a project' })

			yield* readWorkspaceProject(transaction, input.actor, task.projectId, input.repositories)
			const repositories = yield* withDefaultRepository(input.repositories, input.defaultRepositoryIdentity)
			yield* insertWorkspace(transaction, {
				id: input.workspaceId,
				organizationId: input.actor.organizationId,
				projectId: task.projectId,
				name: task.name,
				createdBy: input.actor.userId,
				ownerUserId: task.ownerUserId,
				repositories,
			})
			const workspaceRoot = taskWorkspaceRoot(resolveTaskWorkspacePathSegment(task.slug, input.workspaceId))
			yield* transaction.query(
				transaction.client
					.update(tasks)
					.set({
						workspace_id: input.workspaceId,
						default_working_directory: taskWorkspaceSessionDirectory(workspaceRoot, repositories),
						// As for tasks.v2.create: the workspace materializes before the session launches.
						worktree_timing: 'now',
					})
					.where(eq(tasks.id, input.taskId)),
			)
			const transactionId = yield* getTransactionId(transaction)
			return { result: 'created' as const, transactionId, workspaceId: input.workspaceId }
		}),
	)
})
