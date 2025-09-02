declare module "linebreak" {
	export interface BreakPosition {
		position: number;
		required: boolean;
	}

	export default class LineBreaker {
		constructor(text: string);
		nextBreak(): BreakPosition | null;
	}
}