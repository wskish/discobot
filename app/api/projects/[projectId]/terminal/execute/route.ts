import { NextResponse } from "next/server";

// Mock command responses
const mockResponses: Record<string, string> = {
	ls: "\x1b[1;34mapp\x1b[0m  \x1b[1;34mcomponents\x1b[0m  \x1b[1;34mlib\x1b[0m  \x1b[1;34mnode_modules\x1b[0m  \x1b[1;34mpublic\x1b[0m  package.json  tsconfig.json  README.md",
	"ls -la": `total 120
drwxr-xr-x  12 user user  4096 Jan  9 10:00 \x1b[1;34m.\x1b[0m
drwxr-xr-x   5 user user  4096 Jan  8 15:30 \x1b[1;34m..\x1b[0m
-rw-r--r--   1 user user   285 Jan  8 15:30 .gitignore
drwxr-xr-x   4 user user  4096 Jan  9 09:45 \x1b[1;34mapp\x1b[0m
drwxr-xr-x   3 user user  4096 Jan  9 10:00 \x1b[1;34mcomponents\x1b[0m
drwxr-xr-x   2 user user  4096 Jan  8 15:30 \x1b[1;34mlib\x1b[0m
drwxr-xr-x 245 user user 12288 Jan  9 08:00 \x1b[1;34mnode_modules\x1b[0m
-rw-r--r--   1 user user  1205 Jan  9 08:00 package.json
drwxr-xr-x   2 user user  4096 Jan  8 15:30 \x1b[1;34mpublic\x1b[0m
-rw-r--r--   1 user user   523 Jan  8 15:30 tsconfig.json`,
	pwd: "/home/user/projects/my-app",
	whoami: "user",
	date: new Date().toString(),
	uptime:
		" 10:23:45 up 42 days,  3:15,  1 user,  load average: 0.15, 0.10, 0.08",
	"uname -a":
		"Linux dev-server 5.15.0-91-generic #101-Ubuntu SMP Tue Jan 9 10:00:00 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux",
	hostname: "dev-server.local",
	"cat /etc/os-release": `PRETTY_NAME="Ubuntu 22.04.3 LTS"
NAME="Ubuntu"
VERSION_ID="22.04"
VERSION="22.04.3 LTS (Jammy Jellyfish)"
ID=ubuntu`,
	"git status": `On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	\x1b[31mmodified:   app/page.tsx\x1b[0m
	\x1b[31mmodified:   components/ide/terminal-view.tsx\x1b[0m

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	\x1b[31mlib/api-client.ts\x1b[0m

no changes added to commit (use "git add" and/or "git commit -a")`,
	"git branch": `* \x1b[32mmain\x1b[0m
  develop
  feature/api-routes`,
	"npm run build": `\x1b[36m▲ Next.js 15.1.0\x1b[0m

   Creating an optimized production build ...
   \x1b[32m✓\x1b[0m Compiled successfully
   \x1b[32m✓\x1b[0m Linting and checking validity of types
   \x1b[32m✓\x1b[0m Collecting page data
   \x1b[32m✓\x1b[0m Generating static pages (4/4)
   \x1b[32m✓\x1b[0m Finalizing page optimization

Route (app)                              Size     First Load JS
┌ ○ /                                    5.2 kB        92.1 kB
├ ○ /login                               2.1 kB        89.0 kB
└ ○ /dashboard                           8.4 kB        95.3 kB

\x1b[32m✓\x1b[0m Build completed in 12.3s`,
	"node -v": "v20.10.0",
	"npm -v": "10.2.3",
	"echo $HOME": "/home/user",
	"echo $PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	clear: "",
	help: `Available commands:
  ls, ls -la    - List directory contents
  pwd           - Print working directory
  whoami        - Display current user
  date          - Show current date/time
  uptime        - Show system uptime
  hostname      - Display hostname
  uname -a      - System information
  git status    - Show git status
  git branch    - List git branches
  npm run build - Build the project
  node -v       - Node.js version
  npm -v        - npm version
  echo          - Print text
  clear         - Clear terminal
  help          - Show this help`,
};

export async function POST(request: Request) {
	const { command } = await request.json();

	// Simulate network delay
	await new Promise((resolve) =>
		setTimeout(resolve, 100 + Math.random() * 200),
	);

	// Handle clear command specially
	if (command === "clear") {
		return NextResponse.json({ output: "", exitCode: 0 });
	}

	// Check for exact match
	if (mockResponses[command]) {
		return NextResponse.json({ output: mockResponses[command], exitCode: 0 });
	}

	// Handle echo commands
	if (command.startsWith("echo ")) {
		const text = command.slice(5).replace(/"/g, "").replace(/'/g, "");
		// Handle environment variables
		if (text.startsWith("$")) {
			const varName = text.slice(1);
			if (varName === "HOME")
				return NextResponse.json({ output: "/home/user", exitCode: 0 });
			if (varName === "USER")
				return NextResponse.json({ output: "user", exitCode: 0 });
			if (varName === "PWD")
				return NextResponse.json({
					output: "/home/user/projects/my-app",
					exitCode: 0,
				});
			return NextResponse.json({ output: "", exitCode: 0 });
		}
		return NextResponse.json({ output: text, exitCode: 0 });
	}

	// Handle cd command
	if (command.startsWith("cd ")) {
		return NextResponse.json({ output: "", exitCode: 0 });
	}

	// Handle cat command for known files
	if (command.startsWith("cat ")) {
		const file = command.slice(4).trim();
		if (file === "package.json") {
			return NextResponse.json({
				output: `{
  "name": "ide-chat",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  }
}`,
				exitCode: 0,
			});
		}
		if (mockResponses[command]) {
			return NextResponse.json({ output: mockResponses[command], exitCode: 0 });
		}
		return NextResponse.json({
			output: `\x1b[31mcat: ${file}: No such file or directory\x1b[0m`,
			exitCode: 1,
		});
	}

	// Unknown command
	return NextResponse.json({
		output: `\x1b[31mCommand not found: ${command.split(" ")[0]}\x1b[0m\nType 'help' for available commands.`,
		exitCode: 127,
	});
}
