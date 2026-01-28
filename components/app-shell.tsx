import type { ReactNode } from "react";

interface AppShellProps {
	children: ReactNode;
}

// AppShell is now a simple passthrough since window controls
// are integrated directly into the Header component
export function AppShell({ children }: AppShellProps) {
	return <>{children}</>;
}
