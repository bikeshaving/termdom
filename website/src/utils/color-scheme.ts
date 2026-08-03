import type {Context} from "@b9g/crank/standalone";

export type ColorScheme = "dark" | "light";

// Duplicated in styles/client.css, because the FOUC-prevention script sets
// them inline before the stylesheet has loaded.
const BG_DARK = "#0d1117";
const BG_LIGHT = "#f7f9fb";
const TEXT_DARK = "#e6edf3";
const TEXT_LIGHT = "#10151c";

/** Reactive color scheme, shared by the toggle and anything that reads it. */
export function useColorScheme(ctx: Context) {
	// SSR: a static answer. Hydration sets up the reactivity.
	if (typeof window === "undefined") {
		return {
			get: (): ColorScheme => "dark",
			toggle: () => {},
			set: () => {},
		};
	}

	let current: ColorScheme = getColorScheme();
	applyColorScheme(current);

	const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
	const onMediaChange = (e: MediaQueryListEvent) => {
		// A system change only wins while the reader has made no choice of
		// their own.
		if (!sessionStorage.getItem("color-scheme")) {
			current = e.matches ? "dark" : "light";
			applyColorScheme(current);
			ctx.refresh();
		}
	};
	mediaQuery.addEventListener("change", onMediaChange);
	ctx.cleanup(() => mediaQuery.removeEventListener("change", onMediaChange));

	const onStorage = (e: StorageEvent) => {
		if (
			e.key === "color-scheme" &&
			e.storageArea === sessionStorage &&
			(e.newValue === "dark" || e.newValue === "light")
		) {
			current = e.newValue;
			applyColorScheme(current);
			ctx.refresh();
		}
	};
	window.addEventListener("storage", onStorage);
	ctx.cleanup(() => window.removeEventListener("storage", onStorage));

	return {
		get(): ColorScheme {
			return current;
		},
		toggle(): void {
			current = current === "dark" ? "light" : "dark";
			sessionStorage.setItem("color-scheme", current);
			applyColorScheme(current);
			ctx.refresh();
		},
		set(scheme: ColorScheme): void {
			current = scheme;
			sessionStorage.setItem("color-scheme", current);
			applyColorScheme(current);
			ctx.refresh();
		},
	};
}

function getColorScheme(): ColorScheme {
	const stored = sessionStorage.getItem("color-scheme");
	if (stored === "dark" || stored === "light") {
		return stored;
	}
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function applyColorScheme(scheme: ColorScheme): void {
	const isDark = scheme === "dark";
	document.documentElement.dataset.theme = scheme;
	document.documentElement.style.setProperty(
		"--bg-color",
		isDark ? BG_DARK : BG_LIGHT,
	);
	document.documentElement.style.setProperty(
		"--text-color",
		isDark ? TEXT_DARK : TEXT_LIGHT,
	);
	document.documentElement.classList.toggle("color-scheme-light", !isDark);
}

/** Runs before the first paint, so the page never flashes the wrong scheme. */
export function getColorSchemeScript(): string {
	return `
		const s = sessionStorage.getItem("color-scheme");
		const scheme = s === "dark" || s === "light" ? s :
			(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
		const isDark = scheme === "dark";
		document.documentElement.dataset.theme = scheme;
		document.documentElement.style.setProperty("--bg-color", isDark ? "${BG_DARK}" : "${BG_LIGHT}");
		document.documentElement.style.setProperty("--text-color", isDark ? "${TEXT_DARK}" : "${TEXT_LIGHT}");
		if (!isDark) document.documentElement.classList.add("color-scheme-light");
	`.trim();
}
