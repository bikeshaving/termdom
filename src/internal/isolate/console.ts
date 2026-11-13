import {host} from "./host.ts";

function describe(value: unknown, depth: number): string {
	if (typeof value === "string") {
		return depth === 0 ? value : JSON.stringify(value);
	}

	if (value instanceof Error) {
		return value.stack ?? `${value.name}: ${value.message}`;
	}

	if (typeof value === "function") {
		return `[Function ${value.name || "(anonymous)"}]`;
	}

	if (typeof value !== "object" || value === null) {
		return String(value);
	}

	if (depth > 2) {
		return Array.isArray(value) ? "[Array]" : "[Object]";
	}

	try {
		if (Array.isArray(value)) {
			return `[${value.map((item) => describe(item, depth + 1)).join(", ")}]`;
		}

		const entries = Object.keys(value)
			.map((key) =>
				`${key}: ${describe((value as Record<string, unknown>)[key], depth + 1)}`,
			);
		return `{${entries.join(", ")}}`;
	} catch (error) {
		return `[object: ${error instanceof Error ? error.message : "unreadable"}]`;
	}
}

function format(args: unknown[]): string {
	return args.map((arg) => describe(arg, 0)).join(" ");
}

function method(level: string): (...args: unknown[]) => void {
	return (...args: unknown[]): void => {
		host.log(level, format(args));
	};
}

export const console = {
	debug: method("debug"),
	error: method("error"),
	info: method("info"),
	log: method("log"),
	trace: method("debug"),
	warn: method("warn"),
};

export function reportError(error: unknown): void {
	host.log("error", format(["Uncaught", error]));
}
