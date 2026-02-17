import { useStartupStatus } from "../lib/contexts/startup-status-context";

/**
 * StartupStatusBar displays ongoing startup tasks (VZ image download, runtime image pull, etc.)
 * at the top of the application. It automatically hides when all tasks are complete.
 */
export function StartupStatusBar() {
	const { tasks, hasActiveTasks } = useStartupStatus();

	// Don't render if there are no active tasks
	if (!hasActiveTasks) {
		return null;
	}

	return (
		<div className="border-b border-border bg-background-elevated">
			<div className="px-4 py-2">
				<div className="flex flex-col gap-2">
					{tasks
						.filter(
							(task) =>
								task.state === "pending" || task.state === "in_progress",
						)
						.map((task) => (
							<div key={task.id} className="flex items-center gap-3">
								{/* Loading spinner */}
								<div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-foreground" />

								{/* Task name */}
								<span className="text-sm text-foreground">{task.name}</span>

								{/* Progress indicator - hide if > 100% */}
								{task.progress !== undefined &&
									task.progress !== null &&
									task.progress <= 100 && (
										<span className="text-sm text-foreground-muted">
											{task.progress}%
										</span>
									)}

								{/* Current operation */}
								{task.currentOperation && (
									<span className="text-sm text-foreground-muted">
										{task.currentOperation}
									</span>
								)}

								{/* Byte progress for downloads */}
								{task.bytesDownloaded !== undefined &&
									task.bytesDownloaded > 0 && (
										<span className="text-sm text-foreground-muted">
											{task.totalBytes !== undefined &&
											task.totalBytes > 0 &&
											task.bytesDownloaded <= task.totalBytes
												? `${formatBytes(task.bytesDownloaded)} / ${formatBytes(task.totalBytes)}`
												: formatBytes(task.bytesDownloaded)}
										</span>
									)}
							</div>
						))}
				</div>
			</div>
		</div>
	);
}

/**
 * Format bytes to human-readable string (KB, MB, GB)
 */
function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Math.round(bytes / k ** i)} ${sizes[i]}`;
}
