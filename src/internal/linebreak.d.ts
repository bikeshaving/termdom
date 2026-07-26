declare module "linebreak" {
	export default class LineBreaker {
		constructor(text: string);
		nextBreak(): {position: number; required: boolean} | null;
	}
}
