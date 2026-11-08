import { Effect } from 'effect'

import { createTaskWorkspaceV2 } from '../../../../effects/project-workspace/create-task-workspace-v2'
import { effectOrpcBaseOrganizationRequired } from '../../../effect-base'

export const createTaskWorkspaceV2Procedure = effectOrpcBaseOrganizationRequired.tasks.v2.createWorkspace.effect(
	function* ({ input, context, errors }) {
		return yield* createTaskWorkspaceV2({
			...input,
			actor: { organizationId: context.auth.organizationId, userId: context.auth.userId },
		}).pipe(
			Effect.catchTags({
				ProjectsV2Disabled: () => Effect.fail(errors.FORBIDDEN()),
				ProjectMutationForbidden: () => Effect.fail(errors.FORBIDDEN()),
				ProjectNotFound: (error) =>
					Effect.fail(
						error.projectId === input.taskId
							? errors.TASK_NOT_FOUND({ data: { taskId: input.taskId } })
							: errors.PROJECT_NOT_FOUND({ data: { projectId: error.projectId } }),
					),
				ProjectLocationInvalid: (error) =>
					Effect.fail(errors.BAD_REQUEST({ data: { message: error.message } })),
				UnsupportedRecipeProfile: (error) =>
					Effect.fail(errors.UNSUPPORTED_RECIPE({ data: { message: error.message } })),
				ProjectPersistenceUnavailable: () => Effect.fail(errors.SERVICE_UNAVAILABLE()),
				PostgresDbQueryError: () => Effect.fail(errors.SERVICE_UNAVAILABLE()),
				PostgresDbTransactionError: () => Effect.fail(errors.SERVICE_UNAVAILABLE()),
			}),
		)
	},
)
