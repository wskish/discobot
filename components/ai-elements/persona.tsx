import {
	type RiveParameters,
	useRive,
	useStateMachineInput,
	useViewModel,
	useViewModelInstance,
	useViewModelInstanceColor,
} from "@rive-app/react-webgl2";
import type { FC, ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type PersonaState =
	| "idle"
	| "listening"
	| "thinking"
	| "speaking"
	| "asleep";

interface PersonaProps {
	state: PersonaState;
	onLoad?: RiveParameters["onLoad"];
	onLoadError?: RiveParameters["onLoadError"];
	onReady?: () => void;
	onPause?: RiveParameters["onPause"];
	onPlay?: RiveParameters["onPlay"];
	onStop?: RiveParameters["onStop"];
	className?: string;
	variant?: keyof typeof sources;
}

// The state machine name is always 'default' for Elements AI visuals
const stateMachine = "default";

const sources = {
	obsidian: {
		source:
			"https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/obsidian-2.0.riv",
		dynamicColor: true,
		hasModel: true,
	},
	mana: {
		source:
			"https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/mana-2.0.riv",
		dynamicColor: false,
		hasModel: true,
	},
	opal: {
		source:
			"https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/orb-1.2.riv",
		dynamicColor: false,
		hasModel: false,
	},
	halo: {
		source:
			"https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/halo-2.0.riv",
		dynamicColor: true,
		hasModel: true,
	},
	glint: {
		source:
			"https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/glint-2.0.riv",
		dynamicColor: true,
		hasModel: true,
	},
	command: {
		source:
			"https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/command-2.0.riv",
		dynamicColor: true,
		hasModel: true,
	},
};

const getCurrentTheme = (): "light" | "dark" => {
	if (typeof window !== "undefined") {
		if (document.documentElement.classList.contains("dark")) {
			return "dark";
		}
		if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
			return "dark";
		}
	}
	return "light";
};

const useTheme = (enabled: boolean) => {
	const [theme, setTheme] = useState<"light" | "dark">(getCurrentTheme);

	useEffect(() => {
		// Skip if not enabled (avoids unnecessary observers for non-dynamic-color variants)
		if (!enabled) {
			return;
		}

		// Watch for classList changes
		const observer = new MutationObserver(() => {
			setTheme(getCurrentTheme());
		});

		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});

		// Watch for OS-level theme changes
		let mql: MediaQueryList | null = null;
		const handleMediaChange = () => {
			setTheme(getCurrentTheme());
		};

		if (window.matchMedia) {
			mql = window.matchMedia("(prefers-color-scheme: dark)");
			mql.addEventListener("change", handleMediaChange);
		}

		return () => {
			observer.disconnect();
			if (mql) {
				mql.removeEventListener("change", handleMediaChange);
			}
		};
	}, [enabled]);

	return theme;
};

interface PersonaWithModelProps {
	rive: ReturnType<typeof useRive>["rive"];
	source: (typeof sources)[keyof typeof sources];
	children: React.ReactNode;
}

const PersonaWithModel = memo(
	({ rive, source, children }: PersonaWithModelProps) => {
		const theme = useTheme(source.dynamicColor);
		const viewModel = useViewModel(rive, { useDefault: true });
		const viewModelInstance = useViewModelInstance(viewModel, {
			rive,
			useDefault: true,
		});
		const viewModelInstanceColor = useViewModelInstanceColor(
			"color",
			viewModelInstance,
		);

		useEffect(() => {
			if (!(viewModelInstanceColor && source.dynamicColor)) {
				return;
			}

			const [r, g, b] = theme === "dark" ? [255, 255, 255] : [0, 0, 0];
			viewModelInstanceColor.setRgb(r, g, b);
		}, [viewModelInstanceColor, theme, source.dynamicColor]);

		return children;
	},
);

interface PersonaWithoutModelProps {
	children: ReactNode;
}

const PersonaWithoutModel = memo(
	({ children }: PersonaWithoutModelProps) => children,
);

export const Persona: FC<PersonaProps> = memo(
	({
		variant = "obsidian",
		state = "idle",
		onLoad,
		onLoadError,
		onReady,
		onPause,
		onPlay,
		onStop,
		className,
	}) => {
		const source = sources[variant];

		if (!source) {
			throw new Error(`Invalid variant: ${variant}`);
		}

		// Stabilize callbacks to prevent useRive from reinitializing
		const callbacksRef = useRef({
			onLoad,
			onLoadError,
			onReady,
			onPause,
			onPlay,
			onStop,
		});
		callbacksRef.current = {
			onLoad,
			onLoadError,
			onReady,
			onPause,
			onPlay,
			onStop,
		};

		const stableCallbacks = useMemo(
			() => ({
				onLoad: ((loadedRive) =>
					callbacksRef.current.onLoad?.(
						loadedRive,
					)) as RiveParameters["onLoad"],
				onLoadError: ((err) =>
					callbacksRef.current.onLoadError?.(
						err,
					)) as RiveParameters["onLoadError"],
				onReady: () => callbacksRef.current.onReady?.(),
				onPause: ((event) =>
					callbacksRef.current.onPause?.(event)) as RiveParameters["onPause"],
				onPlay: ((event) =>
					callbacksRef.current.onPlay?.(event)) as RiveParameters["onPlay"],
				onStop: ((event) =>
					callbacksRef.current.onStop?.(event)) as RiveParameters["onStop"],
			}),
			[],
		);

		const { rive, RiveComponent } = useRive({
			src: source.source,
			stateMachines: stateMachine,
			autoplay: true,
			onLoad: stableCallbacks.onLoad,
			onLoadError: stableCallbacks.onLoadError,
			onRiveReady: stableCallbacks.onReady,
			onPause: stableCallbacks.onPause,
			onPlay: stableCallbacks.onPlay,
			onStop: stableCallbacks.onStop,
		});

		const listeningInputRef =
			useRef<ReturnType<typeof useStateMachineInput>>(null);
		const thinkingInputRef =
			useRef<ReturnType<typeof useStateMachineInput>>(null);
		const speakingInputRef =
			useRef<ReturnType<typeof useStateMachineInput>>(null);
		const asleepInputRef =
			useRef<ReturnType<typeof useStateMachineInput>>(null);

		listeningInputRef.current = useStateMachineInput(
			rive,
			stateMachine,
			"listening",
		);
		thinkingInputRef.current = useStateMachineInput(
			rive,
			stateMachine,
			"thinking",
		);
		speakingInputRef.current = useStateMachineInput(
			rive,
			stateMachine,
			"speaking",
		);
		asleepInputRef.current = useStateMachineInput(rive, stateMachine, "asleep");

		useEffect(() => {
			// Rive library API requires mutating the input value property
			const listening = listeningInputRef.current;
			const thinking = thinkingInputRef.current;
			const speaking = speakingInputRef.current;
			const asleep = asleepInputRef.current;

			if (listening) {
				listening.value = state === "listening";
			}
			if (thinking) {
				thinking.value = state === "thinking";
			}
			if (speaking) {
				speaking.value = state === "speaking";
			}
			if (asleep) {
				asleep.value = state === "asleep";
			}
		}, [state]);

		const Component = source.hasModel ? PersonaWithModel : PersonaWithoutModel;

		return (
			<Component rive={rive} source={source}>
				<RiveComponent className={cn("size-16 shrink-0", className)} />
			</Component>
		);
	},
);
