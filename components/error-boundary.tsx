import { AlertCircle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
	children: ReactNode;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
	errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
			errorInfo: null,
		};
	}

	static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		console.error("Error caught by ErrorBoundary:", error, errorInfo);
		this.setState({
			error,
			errorInfo,
		});
	}

	handleReload = () => {
		window.location.reload();
	};

	handleReset = () => {
		this.setState({
			hasError: false,
			error: null,
			errorInfo: null,
		});
	};

	handleSubmitIssue = () => {
		const { error, errorInfo } = this.state;

		// Sanitize error message and stack to remove hostnames/URLs
		const sanitize = (text: string) => {
			return text
				.replace(/https?:\/\/[^\s)]+/g, "[URL removed]")
				.replace(/localhost:\d+/g, "localhost:[PORT]")
				.replace(/\d+\.\d+\.\d+\.\d+(:\d+)?/g, "[IP removed]");
		};

		// Create issue title
		const title = `Error: ${sanitize(error?.message || "Unexpected error")}`;

		// Create issue body with error details
		const errorText = sanitize(error?.toString() || "Unknown error");
		const stackText = sanitize(
			errorInfo?.componentStack || "No component stack available",
		);

		const body = `## Error Description

An error occurred in the application:

\`\`\`
${errorText}
\`\`\`

## Component Stack

\`\`\`
${stackText}
\`\`\`

## Steps to Reproduce

<!-- Please describe the steps that led to this error -->

1.
2.
3.

## Environment

- Browser: ${navigator.userAgent}
- Platform: ${navigator.platform}
`;

		// Create GitHub issue URL with pre-filled title and body
		const url = new URL("https://github.com/obot-platform/discobot/issues/new");
		url.searchParams.set("title", title);
		url.searchParams.set("body", body);

		// Open in new tab
		window.open(url.toString(), "_blank");
	};

	render() {
		if (this.state.hasError) {
			return (
				<div className="flex min-h-screen items-center justify-center bg-background p-4">
					<div className="w-full max-w-2xl rounded-lg border border-destructive/50 bg-card p-6 shadow-lg">
						<div className="flex items-start gap-4">
							<AlertCircle className="h-6 w-6 shrink-0 text-destructive" />
							<div className="flex-1 space-y-4">
								<div>
									<h1 className="text-xl font-semibold text-foreground">
										Something went wrong
									</h1>
									<p className="mt-2 text-sm text-muted-foreground">
										An unexpected error occurred. You can try reloading the page
										or reset the component.
									</p>
								</div>

								{this.state.error && (
									<div className="space-y-2">
										<p className="text-sm font-medium text-foreground">
											Error details:
										</p>
										<pre className="overflow-x-auto rounded bg-muted p-3 text-xs text-foreground whitespace-pre-wrap break-words max-w-full">
											{this.state.error.toString()}
										</pre>
										{this.state.error.stack && (
											<details className="text-xs">
												<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
													Stack trace
												</summary>
												<pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-foreground whitespace-pre-wrap break-words max-w-full">
													{this.state.error.stack}
												</pre>
											</details>
										)}
										{this.state.errorInfo?.componentStack && (
											<details className="text-xs" open>
												<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
													Additional context
												</summary>
												<pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-foreground whitespace-pre-wrap break-words max-w-full">
													{this.state.errorInfo.componentStack}
												</pre>
											</details>
										)}
									</div>
								)}

								<div className="flex flex-wrap gap-2">
									<Button onClick={this.handleReload} variant="default">
										Reload Page
									</Button>
									<Button onClick={this.handleReset} variant="outline">
										Try Again
									</Button>
									<Button onClick={this.handleSubmitIssue} variant="outline">
										Submit Issue
									</Button>
								</div>
							</div>
						</div>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
