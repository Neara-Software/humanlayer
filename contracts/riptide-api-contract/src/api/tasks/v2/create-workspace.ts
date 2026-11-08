import { WorkspaceRepositoriesSchema } from '@humanlayer/schemas/zod/project-workspace'
import { StatusCodes } from 'http-status-codes'
import z from 'zod/v4'

import { contractBuilder } from '../../../contract-builder'

/**
 * Gives an existing project task with no workspace one, made the way `tasks.v2.create` makes it, so
 * its sessions can launch through `sessions.v2.create`. Tasks moved or imported into a project have none.
 * Needs edit access to the task and a readable, non-archived project. A task that already has a
 * workspace returns it.
 */
export const CreateTaskWorkspaceV2InputSchema = z
	.object({
		taskId: z.uuidv7(),
		workspaceId: z.uuidv7(),
		repositories: WorkspaceRepositoriesSchema,
		defaultRepositoryIdentity: z.string().min(1).optional(),
	})
	.refine(
		(input) =>
			!input.defaultRepositoryIdentity ||
			input.repositories.some((repository) => repository.repositoryIdentity === input.defaultRepositoryIdentity),
		{
			path: ['defaultRepositoryIdentity'],
			message: 'defaultRepositoryIdentity must match one of the repositories',
		},
	)

export type CreateTaskWorkspaceV2Input = z.infer<typeof CreateTaskWorkspaceV2InputSchema>

export const CreateTaskWorkspaceV2OutputSchema = z.object({
	result: z.enum(['created', 'already-exists']),
	transactionId: z.string(),
	workspaceId: z.uuidv7(),
})

export const createTaskWorkspaceV2Contract = contractBuilder
	.input(CreateTaskWorkspaceV2InputSchema)
	.output(CreateTaskWorkspaceV2OutputSchema)
	.errors({
		TASK_NOT_FOUND: {
			status: StatusCodes.NOT_FOUND,
			data: z.object({ taskId: z.string() }),
		},
		PROJECT_NOT_FOUND: {
			status: StatusCodes.NOT_FOUND,
			data: z.object({ projectId: z.string() }),
		},
		UNSUPPORTED_RECIPE: {
			status: StatusCodes.BAD_REQUEST,
			data: z.object({ message: z.string() }),
		},
	})
