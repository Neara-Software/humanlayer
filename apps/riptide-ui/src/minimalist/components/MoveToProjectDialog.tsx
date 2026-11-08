import type { Task } from '@humanlayer/db/tables/tasks'
import { useState } from 'react'

import { useTaskActions } from '@/hooks/useTaskActions'
import { Dialog } from '@/minimalist/components/Dialog'
import { useProjects } from '@/minimalist/lib/data'
import { useUi } from '@/minimalist/lib/ui-state'

const OTHER_TASKS = ''

/**
 * Picks the project a task belongs to, or "Other tasks". The move shows at once (optimistic) and
 * rolls back with a toast if the server refuses it.
 */
export function MoveToProjectDialog({
	task,
	onClose,
}: {
	task: Pick<Task, 'id' | 'name' | 'project_id'>
	onClose: () => void
}) {
	const projects = useProjects()
	const { moveTaskToProject } = useTaskActions()
	const { showToast } = useUi()
	const [projectId, setProjectId] = useState(task.project_id ?? OTHER_TASKS)
	const move = () => {
		onClose()
		if (projectId === (task.project_id ?? OTHER_TASKS)) return
		moveTaskToProject({ taskId: task.id, projectId: projectId || null }).isPersisted.promise.catch(() =>
			showToast(`Could not move ${task.name}. It is back where it was.`),
		)
	}
	return (
		<Dialog title="Move to project" onClose={onClose} onSubmit={move}>
			<select
				aria-label="Project"
				autoFocus
				value={projectId}
				onChange={(event) => setProjectId(event.target.value)}
				disabled={projects.isPending}
			>
				{(projects.data ?? []).map((project) => (
					<option key={project.id} value={project.id}>
						{project.name}
					</option>
				))}
				<option value={OTHER_TASKS}>Other tasks</option>
			</select>
			<div className="dialog-actions">
				<button type="button" className="btn" onClick={onClose}>
					Cancel
				</button>
				<button type="submit" className="btn primary" disabled={projects.isPending}>
					Move
				</button>
			</div>
		</Dialog>
	)
}
